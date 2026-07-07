// Polls bridge. Drives content script.

const POLL_MS = 8_000;

async function cfg() {
    return new Promise(r => chrome.storage.sync.get(['bridgeUrl', 'bridgeToken'], s => r(s)));
}

async function bridgeFetch(path, opts = {}) {
    const { bridgeUrl, bridgeToken } = await cfg();
    if (!bridgeUrl || !bridgeToken) throw new Error('bridge not configured');
    const r = await fetch(`${bridgeUrl.replace(/\/$/, '')}${path}`, {
        ...opts,
        headers: {
            'Authorization': `Bearer ${bridgeToken}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {})
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!r.ok) throw new Error(`bridge ${r.status}`);
    return r.json();
}

let pollTimer = null;
async function startLoop() {
    if (pollTimer) clearTimeout(pollTimer);
    const tick = async () => {
        try {
            await bridgeFetch('/heartbeat', { method: 'POST', body: {} });

            // Find an idle x.com tab (prefer non-active so background work keeps going)
            const tabs = await chrome.tabs.query({ url: ['https://twitter.com/*', 'https://x.com/*'], status: 'complete' });
            if (!tabs.length) { pollTimer = setTimeout(tick, POLL_MS); return; }

            const { task } = await bridgeFetch('/task', { method: 'POST', body: {} });
            if (!task) { pollTimer = setTimeout(tick, POLL_MS); return; }

            const tab = tabs.find(t => !t.active) || tabs[0];

            // Navigate then wait for content to render
            chrome.tabs.update(tab.id, { url: task.url }, () => {
                setTimeout(() => {
                    chrome.tabs.sendMessage(tab.id, { action: 'handleTask', task }, () => void chrome.runtime.lastError);
                }, 4500);
            });
        } catch (e) {
            console.warn('[bg]', e.message);
        }
        pollTimer = setTimeout(tick, POLL_MS);
    };
    tick();
}

chrome.runtime.onMessage.addListener((req, _s, sendResponse) => {
    if (req.action === 'taskComplete') {
        bridgeFetch('/complete', { method: 'POST', body: req.payload })
            .then(() => sendResponse({ ok: true }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (req.action === 'testBridge') {
        bridgeFetch('/heartbeat', { method: 'POST', body: {} })
            .then(data => sendResponse({ ok: true, data }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
});

chrome.runtime.onInstalled.addListener(startLoop);
chrome.runtime.onStartup.addListener(startLoop);
startLoop();