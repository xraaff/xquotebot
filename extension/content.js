// Auto Quote Reply content script v2
// Receives a task from background, extracts full quote-tweet context, asks bridge for AI reply,
// posts + likes with human-like timing & typing.

console.log('[AQR] loaded');

let busy = false;
let toastEl;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

async function bridgeCall(path, opts = {}) {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get(['bridgeUrl', 'bridgeToken'], async s => {
            if (!s.bridgeUrl || !s.bridgeToken) return reject(new Error('bridge not configured'));
            try {
                const r = await fetch(`${s.bridgeUrl.replace(/\/$/, '')}${path}`, {
                    ...opts,
                    headers: {
                        'Authorization': `Bearer ${s.bridgeToken}`,
                        'Content-Type': 'application/json',
                        ...(opts.headers || {})
                    },
                    body: opts.body ? JSON.stringify(opts.body) : undefined
                });
                if (!r.ok) return reject(new Error(`bridge ${r.status}`));
                resolve(await r.json());
            } catch (e) { reject(e); }
        });
    });
}

function showToast(msg, err = false) {
    if (!toastEl) {
        toastEl = document.createElement('div');
        Object.assign(toastEl.style, {
            position: 'fixed', bottom: '20px', right: '20px',
            padding: '10px 16px', borderRadius: '8px', zIndex: '99999',
            fontWeight: '600', fontSize: '14px', maxWidth: '340px',
            background: '#1DA1F2', color: '#fff',
            boxShadow: '0 4px 12px rgba(0,0,0,.25)'
        });
        document.body.appendChild(toastEl);
    }
    toastEl.style.background = err ? '#e0245e' : '#1DA1F2';
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.style.display = 'none'; }, 4500);
}

// ============== DOM ==============
function $$(root, sel) { return Array.from((root || document).querySelectorAll(sel)); }
function getMainColumn() {
    return document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main') || document.body;
}

function extractTweetBasics(tweetEl) {
    if (!tweetEl) return null;
    const text = tweetEl.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || '';
    const userNameEl = tweetEl.querySelector('[data-testid="User-Name"]');
    let handle = 'unknown';
    if (userNameEl) {
        const links = userNameEl.querySelectorAll('a');
        const lastLink = links[links.length - 1];
        if (lastLink) handle = (lastLink.textContent || '').replace(/^@/, '').trim() || 'unknown';
    }
    const timeEl = tweetEl.querySelector('time');
    const timestamp = timeEl?.getAttribute('datetime') || '';
    return { author: handle, text, timestamp };
}

function extractQuotedTweet(mainTweetEl) {
    if (!mainTweetEl) return null;
    const linkBlocks = mainTweetEl.querySelectorAll('[role="link"]');
    for (const lb of linkBlocks) {
        const inner = lb.querySelector('[data-testid="tweetText"]');
        if (inner) {
            const innerUserName = lb.querySelector('[data-testid="User-Name"]');
            let author = 'unknown';
            if (innerUserName) {
                const links = innerUserName.querySelectorAll('a');
                const lastLink = links[links.length - 1];
                if (lastLink) author = (lastLink.textContent || '').replace(/^@/, '').trim() || 'unknown';
            }
            return { author, text: (inner.textContent || '').trim() };
        }
    }
    return null;
}

function extractThreadReplies(excludeAuthor) {
    const main = $$(getMainColumn(), 'article[data-testid="tweet"]')[0];
    if (!main) return [];
    const all = $$(document, 'article[data-testid="tweet"]');
    const out = [];
    const seen = new Set();
    for (const a of all) {
        if (a === main) continue;
        const b = extractTweetBasics(a);
        if (!b || !b.text) continue;
        if (b.author === excludeAuthor) continue;
        const k = b.text.slice(0, 80);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(b);
    }
    return out.slice(0, 6);
}

async function buildContext(task) {
    // Wait for SPA to render the status page
    for (let i = 0; i < 20; i++) {
        await sleep(500);
        const m = $$(getMainColumn(), 'article[data-testid="tweet"]')[0];
        if (m && m.querySelector('[data-testid="tweetText"]')) {
            // extra wait for replies + quoted-tweet card to render
            await sleep(1500);
            break;
        }
    }
    const mainTweet = $$(getMainColumn(), 'article[data-testid="tweet"]')[0];
    if (!mainTweet) throw new Error('main tweet not found on page');

    const quoteTweet = extractTweetBasics(mainTweet);
    if (!quoteTweet || !quoteTweet.text) throw new Error('could not extract quote tweet text');
    const quotedTweet = extractQuotedTweet(mainTweet);
    const replies = extractThreadReplies(quoteTweet.author);

    return {
        url: task.url,
        path: task.path || new URL(task.url).pathname,
        author: quoteTweet.author,
        quoteTweet,
        quotedTweet,
        repliesInThread: replies
    };
}

// ============== Posting: human-like ==============
async function clickReplyButton(tweetEl) {
    const btn = tweetEl.querySelector('[data-testid="reply"]');
    if (!btn) throw new Error('reply button missing');
    btn.click();
    await sleep(rnd(1500, 2200));
    const modal = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
    if (!modal) throw new Error('composer not opened');
    return modal;
}

async function typeHumanLike(text) {
    const editor =
        document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]') ||
        document.querySelector('[role="dialog"] textarea[data-testid="tweetTextarea_0"]') ||
        document.querySelector('[role="dialog"] textarea');

    if (!editor) throw new Error('editor not found');

    let target;
    if (editor.tagName === 'TEXTAREA') {
        target = editor;
    } else {
        target = editor.querySelector('[data-contents="true"]') || editor.querySelector('[data-text="true"]') || editor;
    }

    target.focus();
    await sleep(rnd(250, 450));
    // Reset any prior content
    target.textContent = '';
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));

    const baseDelay = rnd(28, 50);
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        target.textContent = text.slice(0, i + 1);
        target.dispatchEvent(new InputEvent('input', { bubbles: true, data: c, inputType: 'insertText' }));
        let d = baseDelay + rnd(0, 35);
        if (c === ' ' || c === '\n') d *= 0.55;
        if ('.,!?;:'.includes(c)) d += rnd(80, 200);
        if (Math.random() < 0.04) d += rnd(180, 450);
        await sleep(d);
    }
    target.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(rnd(200, 400));
}

async function clickSendReply() {
    const modal = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
    if (!modal) throw new Error('modal closed before send');
    const sendBtn =
        modal.querySelector('[data-testid="tweetButton"]') ||
        modal.querySelector('[data-testid="tweetButtonInline"]') ||
        Array.from(modal.querySelectorAll('button')).find(b => /reply|post|tweet/i.test(b.textContent || '') && !b.disabled);
    if (!sendBtn) throw new Error('send button missing');
    if (sendBtn.disabled) throw new Error('send disabled');
    sendBtn.click();
    await sleep(rnd(1300, 1900));
}

async function likeTweet(tweetEl) {
    const likeBtn = tweetEl.querySelector('[data-testid="like"]');
    if (!likeBtn) return;
    const ariaLabel = (likeBtn.getAttribute('aria-label') || '').toLowerCase();
    const pressed = likeBtn.getAttribute('aria-pressed') === 'true' || ariaLabel.includes('liked');
    if (pressed) return;
    likeBtn.click();
    await sleep(rnd(700, 1300));
}

// ============== Task handler ==============
async function handleTask(task) {
    if (busy) { console.log('[AQR] busy'); return; }
    busy = true;
    console.log('[AQR] handling', task);

    try {
        showToast('🤖 loading tweet…');
        const context = await buildContext(task);
        console.log('[AQR] context', context);

        showToast('🧠 generating reply…');
        const gen = await bridgeCall('/generate', { method: 'POST', body: context });
        if (gen.error) throw new Error('AI: ' + gen.error);
        const reply = gen.reply;
        console.log('[AQR] reply:', reply);

        // Simulate "reading"
        await sleep(rnd(2400, 5500));

        // Like first (only if unliked)
        const mainTweet = $$(document, 'article[data-testid="tweet"]')[0];
        if (context.quotedTweet) {
            await likeTweet(mainTweet);
        }

        // Random small scroll jitter (looks like real user)
        window.scrollBy({ top: rnd(-50, 60), behavior: 'smooth' });
        await sleep(rnd(400, 900));

        // Open reply composer
        showToast('⌨️ opening composer…');
        await clickReplyButton(mainTweet);

        // Type
        await typeHumanLike(reply);

        // Review delay (1.5-3s)
        await sleep(rnd(1500, 3000));

        // Light scroll back-up to look like reviewing
        window.scrollBy({ top: rnd(-25, 25), behavior: 'smooth' });

        // Send
        showToast('🚀 posting…');
        await clickSendReply();

        // Move on
        await sleep(rnd(900, 1500));
        window.scrollBy({ top: rnd(120, 280), behavior: 'smooth' });

        showToast('✅ reply sent');
        await chrome.runtime.sendMessage({
            action: 'taskComplete',
            payload: { taskId: task.id, success: true, generatedReply: reply, chatId: task.chatId }
        });
    } catch (e) {
        console.error('[AQR] fail', e);
        showToast('❌ ' + e.message, true);
        await chrome.runtime.sendMessage({
            action: 'taskComplete',
            payload: { taskId: task.id, success: false, error: e.message, chatId: task.chatId }
        });
    } finally {
        busy = false;
    }
}

chrome.runtime.onMessage.addListener((req, _s, sendResponse) => {
    if (req.action === 'handleTask') {
        handleTask(req.task);
        sendResponse({ ok: true });
        return true;
    }
});