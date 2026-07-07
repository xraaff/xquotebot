// Bridge: Telegram bot + HTTP API + OpenRouter proxy + persistent SQLite queue + rate limiter
// Deploy on Railway/Render/VPS. Read bridge/README.md for env vars.

const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

let TelegramBot;
try { TelegramBot = require('node-telegram-bot-api'); } catch {}

// ============ CONFIG (from env) ============
const cfg = {
    port: parseInt(process.env.PORT || '8080'),
    openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    bridgeToken: process.env.BRIDGE_TOKEN || '',
    model: process.env.MODEL || 'google/gemini-2.0-flash-exp:free',
    fallbackModels: (process.env.FALLBACK_MODELS || 'deepseek/deepseek-chat-v3:free,meta-llama/llama-3.3-70b-instruct:free,qwen/qwen-2.5-72b-instruct:free').split(',').map(s => s.trim()).filter(Boolean),
    userPersona: process.env.USER_PERSONA || 'Lowercase starts, contractions, no fluff. Sharp builder/investor tone. Casual but specific. You never open with "I" or the @handle. ≤1 emoji only if it adds meaning. You are a peer who reads the AI/productivity/crypto space.',
    replyStyle: process.env.REPLY_STYLE || 'Sharp observation or pushback, not generic praise. Specific examples > vague agreement.',
    exampleReplies: (() => { try { return JSON.parse(process.env.EXAMPLE_REPLIES || '[]'); } catch { return []; } })(),
    maxPerHour: parseInt(process.env.MAX_PER_HOUR || '8'),
    maxPerDay: parseInt(process.env.MAX_PER_DAY || '30'),
    minDelayMs: parseInt(process.env.MIN_DELAY_MS || '90000'),
    maxDelayMs: parseInt(process.env.MAX_DELAY_MS || '240000'),
    dataDir: process.env.DATA_DIR || '/app/data'
};

if (!cfg.bridgeToken) {
    cfg.bridgeToken = require('crypto').randomBytes(24).toString('hex');
    console.warn('[BOOT] BRIDGE_TOKEN not set, generated ephemeral:', cfg.bridgeToken);
}

if (!fs.existsSync(cfg.dataDir)) fs.mkdirSync(cfg.dataDir, { recursive: true });

// ============ SQLite ============
const db = new Database(path.join(cfg.dataDir, 'bridge.db'));
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        chat_id TEXT,
        added_by TEXT,
        added_at INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        completed_at INTEGER,
        generated_reply TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_status ON queue(status);
`);
const stmtInsert = db.prepare(`INSERT INTO queue (id,url,path,chat_id,added_by,added_at) VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO NOTHING`);
const stmtNextPending = db.prepare(`SELECT * FROM queue WHERE status='pending' ORDER BY added_at ASC LIMIT 1`);
const stmtDelete = db.prepare(`DELETE FROM queue WHERE id=?`);
const stmtComplete = db.prepare(`UPDATE queue SET status='done', completed_at=?, generated_reply=?, last_error=? WHERE id=?`);
const stmtFail = db.prepare(`UPDATE queue SET status='failed', completed_at=?, last_error=?, attempts=attempts+1 WHERE id=?`);
const stmtRecent = db.prepare(`SELECT * FROM queue WHERE status IN ('done','failed') ORDER BY completed_at DESC LIMIT ?`);

// ============ RATE LIMIT (in-memory, per-process) ============
let lastActionTime = 0;
let actionsThisHour = 0;
let actionsToday = 0;
let currentHour = -1, currentDay = -1;
let nextTaskId = null;
let nextTaskChatId = null;

function tickCounters() {
    const now = new Date();
    if (now.getHours() !== currentHour) { currentHour = now.getHours(); actionsThisHour = 0; }
    if (now.getDate() !== currentDay) { currentDay = now.getDate(); actionsToday = 0; }
}
function canAct() {
    tickCounters();
    return Date.now() - lastActionTime >= cfg.minDelayMs
        && actionsThisHour < cfg.maxPerHour
        && actionsToday < cfg.maxPerDay;
}
function recordAction() {
    lastActionTime = Date.now();
    actionsThisHour++;
    actionsToday++;
}

// ============ AI GENERATION ============
async function generateAIReply(context) {
    if (!cfg.openRouterApiKey) throw new Error('OPENROUTER_API_KEY missing');

    const { quotedTweet, quoteTweet, repliesInThread, url, author } = context;

    let examplesBlock = '';
    if (cfg.exampleReplies.length) {
        examplesBlock = `\n# YOUR EXISTING REPLIES (study tone/length — never copy verbatim):\n` +
            cfg.exampleReplies.slice(0, 8).map((ex, i) =>
                `Example ${i+1}:\nContext: ${(ex.input||'').slice(0,400)}\nYour reply: ${ex.output}`
            ).join('\n\n') + '\n';
    }

    const systemPrompt = `You write replies to Twitter/X quote tweets.

CONTEXT SHAPE:
Someone (@${author}) made a QUOTE TWEET: they quoted another person's tweet AND added their own short commentary on top. Your reply goes UNDERNEATH @${author}'s quote — meaning you respond primarily to THEIR commentary/opinion, not to the original quoted author. Use the original quoted tweet only when @${author}'s commentary references it directly.

STYLE:
${cfg.userPersona}
Tone flags: ${cfg.replyStyle}
${examplesBlock}

STRICT RULES (violating any = useless reply):
1. 80–230 characters. 150 sweet spot. NEVER exceed 280.
2. Don't open with "I", the @handle, "Honestly", "Honestly said", "Look,".
3. NO generic praise: no "great point", "this is fire", "so true", "exactly", "👏👏👏".
4. NO assistant filler: no "Certainly!", "Here's my take:", "As an AI", numbered lists.
5. NO hashtags. NO emojis except ≤1 if it genuinely adds meaning.
6. Add ONE specific thing: sharp pushback, concrete example they missed, non-obvious angle. Generic agreement is useless.
7. Read what other repliers already said in the thread. Don't repeat them.
8. Don't paraphrase what they said back at them.
9. Lowercase opening fine if casual. Match their register.
10. Output ONLY the reply text. No quotes, no "Reply:", no markdown.`;

    const quotedSection = quotedTweet
        ? `=== ORIGINAL QUOTED TWEET (context only) ===\n@${quotedTweet.author}: "${quotedTweet.text}"\n(${quotedTweet.metrics || 'no metrics'})`
        : '=== ORIGINAL QUOTED TWEET ===\n(could not extract)';

    const repliesSection = repliesInThread?.length
        ? `\n=== EXISTING REPLIES IN THREAD (do NOT repeat these) ===\n` +
            repliesInThread.slice(0, 6).map((r, i) => `  ${i+1}. @${r.author}: "${(r.text||'').slice(0,200)}"`).join('\n')
        : '';

    const userPrompt = `Reply target: ${url}\n\n${quotedSection}\n\n=== QUOTE TWEET YOU'RE REPLYING TO ===\n@${author}: "${quoteTweet.text}"\nposted ${quoteTweet.timestamp || 'recently'}\n${repliesSection}\n\nWrite the reply now. ONLY the reply text.`;

    const modelsToTry = [cfg.model, ...cfg.fallbackModels.filter(m => m !== cfg.model)];
    let lastErr = null;
    for (const model of modelsToTry) {
        try {
            console.log(`[AI] try ${model}`);
            const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${cfg.openRouterApiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/quote-bridge',
                    'X-Title': 'Quote Reply Bot'
                },
                body: JSON.stringify({
                    model, temperature: 0.78, max_tokens: 120,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ]
                })
            });
            if (!r.ok) {
                lastErr = `${model} → ${r.status}: ${(await r.text()).slice(0,200)}`;
                console.warn('[AI]', lastErr);
                continue;
            }
            const data = await r.json();
            let reply = data.choices?.[0]?.message?.content?.trim() || '';
            reply = reply
                .replace(/^["'`]+|["'`]+$/g, '')
                .replace(/^(Reply:|@?\w+:\s*)/i, '')
                .replace(/^Honest(ly)?[.!]?\s/i, '')
                .replace(/^Look,?\s/i, '');
            if (reply.length < 25) { lastErr = `${model} → too short/refusal: "${reply}"`; continue; }
            if (reply.length > 280) reply = reply.slice(0, 277) + '…';
            console.log(`[AI] ✓ ${model} → "${reply}"`);
            return reply;
        } catch (e) {
            lastErr = `${model} → ${e.message}`;
            console.warn('[AI]', lastErr);
        }
    }
    throw new Error(`All models failed: ${lastErr}`);
}

// ============ EXPRESS ============
const app = express();
app.use(express.json({ limit: '512kb' }));

function authOk(req) {
    const h = req.headers.authorization || '';
    return h === `Bearer ${cfg.bridgeToken}`;
}

function extensionSeen() {
    return Date.now() - extensionHeartbeatAt < 60000;
}
let extensionHeartbeatAt = 0;

app.get('/', (_req, res) => res.send('Quote Reply Bridge — alive'));

app.post('/heartbeat', (req, res) => {
    if (!authOk(req)) return res.status(401).end();
    extensionHeartbeatAt = Date.now();
    res.json({
        ok: true,
        rateLimits: { perHour: cfg.maxPerHour, perDay: cfg.maxPerDay, minDelayMs: cfg.minDelayMs, maxDelayMs: cfg.maxDelayMs },
        connected: extensionSeen(),
        queueLen: db.prepare(`SELECT COUNT(*) c FROM queue WHERE status='pending'`).get().c
    });
});

app.post('/task', (req, res) => {
    if (!authOk(req)) return res.status(401).end();
    tickCounters();
    extensionHeartbeatAt = Date.now();
    const can = canAct();
    let task = null;
    if (can) {
        const row = stmtNextPending.get();
        if (row) {
            stmtDelete.run(row.id);
            nextTaskId = row.id;
            nextTaskChatId = row.chat_id;
            task = {
                id: row.id,
                url: row.url,
                path: row.path,
                chatId: row.chat_id,
                addedBy: row.added_by
            };
            console.log('[task] dequeued', task.path);
        }
    }
    res.json({
        task,
        canAct: can,
        stats: {
            queueLen: db.prepare(`SELECT COUNT(*) c FROM queue WHERE status='pending'`).get().c,
            actionsThisHour, actionsToday,
            lastAction: lastActionTime ? new Date(lastActionTime).toISOString() : null,
            nextSlotIn: can ? 0 : Math.ceil((cfg.minDelayMs - (Date.now() - lastActionTime))/1000)
        }
    });
});

app.post('/generate', async (req, res) => {
    if (!authOk(req)) return res.status(401).end();
    try {
        const reply = await generateAIReply(req.body);
        res.json({ reply });
    } catch (e) {
        console.error('[generate]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/complete', (req, res) => {
    if (!authOk(req)) return res.status(401).end();
    const { taskId, success, error, generatedReply, chatId } = req.body || {};
    if (!taskId) return res.status(400).json({ error: 'taskId required' });
    const now = Date.now();
    if (success) {
        recordAction();
        stmtComplete.run(now, generatedReply || null, null, taskId);
    } else {
        stmtFail.run(now, error || 'unknown', taskId || nextTaskId);
    }
    if (bot && chatId) {
        bot.sendMessage(chatId,
            success
                ? `✅ posted:\n"${generatedReply}"`
                : `❌ failed:\n${error || 'unknown'}`
        ).catch(() => {});
    }
    res.json({ ok: true });
});

app.get('/status', (req, res) => {
    if (!authOk(req)) return res.status(401).end();
    tickCounters();
    res.json({
        queueLen: db.prepare(`SELECT COUNT(*) c FROM queue WHERE status='pending'`).get().c,
        processedToday: db.prepare(`SELECT COUNT(*) c FROM queue WHERE status='done' AND completed_at > ?`).get(Date.now() - 86400000).c,
        actionsThisHour, actionsToday,
        extensionConnected: extensionSeen(),
        canAct: canAct(),
        model: cfg.model
    });
});

// ============ TELEGRAM ============
let bot = null;
function startTelegram() {
    if (!TelegramBot) { console.warn('[TG] node-telegram-bot-api not loaded'); return; }
    if (!cfg.telegramBotToken) { console.warn('[TG] TELEGRAM_BOT_TOKEN not set'); return; }

    bot = new TelegramBot(cfg.telegramBotToken, { polling: true });
    console.log('[TG] started');

    const URL_RE = /https?:\/\/(twitter\.com|x\.com)\/\w+\/status\/\d+(\?\S*)?/g;

    const send = (id, msg) => bot.sendMessage(id, msg).catch(() => {});

    bot.onText(/\/start/, msg => send(msg.chat.id,
        `🤖 Twitter Quote Reply Bot\n\n• Send me X/Twitter URLs of QUOTE tweets — I'll queue them\n• They get auto-replied + liked on the Chrome with the extension running\n\nCommands:\n/status — queue & rate limits\n/last [N] — last N processed (default 5)\n/clear — empty pending queue\n\nBridge URL: ${req_protocol()}\nExtension: ${extensionSeen() ? '✅ connected' : '❌ no Chrome open yet'}`));

    bot.onText(/\/status/, msg => {
        tickCounters();
        const queueLen = db.prepare(`SELECT COUNT(*) c FROM queue WHERE status='pending'`).get().c;
        send(msg.chat.id,
            `📊 pending: ${queueLen}\nactions: ${actionsThisHour}/${cfg.maxPerHour}h · ${actionsToday}/${cfg.maxPerDay}d\n` +
            `extension: ${extensionSeen() ? '✅ up' : '❌ down — open x.com in Chrome with extension installed'}\n` +
            `next slot: ${canAct() ? '✅ free' : '⏳ wait ' + Math.ceil((cfg.minDelayMs - (Date.now() - lastActionTime))/1000) + 's'}\nmodel: ${cfg.model}`);
    });

    bot.onText(/\/clear/, msg => {
        const n = db.prepare(`DELETE FROM queue WHERE status='pending'`).run().changes;
        send(msg.chat.id, `🗑 cleared ${n} pending`);
    });

    bot.onText(/\/last(?: (\d+))?/, (msg, m) => {
        const n = parseInt(m[1]) || 5;
        const rows = stmtRecent.all(n);
        if (!rows.length) return send(msg.chat.id, 'no tasks yet');
        send(msg.chat.id, rows.map(r =>
            `${r.status === 'done' ? '✅' : '❌'} ${r.path}\n` +
            (r.generated_reply ? `→ "${r.generated_reply}"` : `err: ${r.last_error || '?'}`)
        ).join('\n\n'));
    });

    bot.on('message', msg => {
        if (msg.text?.startsWith('/')) return;
        const urls = msg.text?.match(URL_RE) || [];
        if (!urls.length) return send(msg.chat.id, 'send me x.com URLs of quote tweets');
        let added = 0, dup = 0;
        for (const raw of urls) {
            const clean = raw.split('?')[0];
            const p = new URL(clean).pathname;
            const result = stmtInsert.run(`${Date.now()}_${Math.random().toString(36).slice(2,8)}`, clean, p, msg.chat.id, msg.from?.username || 'tg', Date.now());
            if (result.changes === 0) dup++;
            else added++;
        }
        const queueLen = db.prepare(`SELECT COUNT(*) c FROM queue WHERE status='pending'`).get().c;
        send(msg.chat.id, `➕ added ${added}${dup ? ` (${dup} dup)` : ''} · queue: ${queueLen}\n` +
            `${extensionSeen() ? '🚀 already on it' : '⚠️ open x.com in a Chrome with the extension installed'}`);
    });

    bot.on('polling_error', e => console.error('[TG] poll err:', e.message));
}

function req_protocol() { return `https://<your-bridge-domain>`; }

// ============ BOOT ============
app.listen(cfg.port, () => {
    console.log(`[HTTP] listening on :${cfg.port}`);
    console.log(`[CFG] model=${cfg.model}`);
    console.log(`[CFG] rate: ${cfg.maxPerHour}/h, ${cfg.maxPerDay}/d, delay ${cfg.minDelayMs/1000}s..${cfg.maxDelayMs/1000}s`);
    console.log(`[CFG] db at ${path.join(cfg.dataDir, 'bridge.db')}`);
    console.log(`[CFG] BRIDGE_TOKEN (paste into extension): ${cfg.bridgeToken}`);
    startTelegram();
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });