const bridgeUrl = document.getElementById('bridgeUrl');
const bridgeToken = document.getElementById('bridgeToken');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const statusDiv = document.getElementById('status');

function setStatus(msg, type) {
    statusDiv.innerHTML = msg;
    statusDiv.className = 'status ' + (type || '');
}

function load() {
    chrome.storage.sync.get(['bridgeUrl', 'bridgeToken'], s => {
        bridgeUrl.value = s.bridgeUrl || '';
        bridgeToken.value = s.bridgeToken || '';
        if (!s.bridgeUrl || !s.bridgeToken) {
            setStatus('fill in Bridge URL + Token, then <b>Save</b> + <b>Test</b>');
        } else {
            setStatus('saved — click <b>Test</b> to verify', 'ok');
        }
    });
}

saveBtn.onclick = () => {
    const url = bridgeUrl.value.trim().replace(/\/$/, '');
    const tok = bridgeToken.value.trim();
    if (!url || !tok) { setStatus('both fields required', 'err'); return; }
    chrome.storage.sync.set({ bridgeUrl: url, bridgeToken: tok }, () => {
        setStatus('saved ✓', 'ok');
        testBridge();
    });
};

async function testBridge() {
    const { bridgeUrl: u, bridgeToken: t } = await new Promise(r => chrome.storage.sync.get(['bridgeUrl', 'bridgeToken'], r));
    if (!u || !t) { setStatus('not configured', 'err'); return; }
    setStatus('testing…');
    try {
        const r = await fetch(`${u}/heartbeat`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' },
            body: '{}'
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        setStatus(
            `✅ bridge reachable<br><span style="color:#71767b">queue: ${data.queueLen} · limits: ${data.rateLimits.perHour}/h ${data.rateLimits.perDay}/d</span>`,
            'ok'
        );
    } catch (e) {
        setStatus('❌ ' + e.message + '<br><span style="color:#71767b">is the bridge running?</span>', 'err');
    }
}

testBtn.onclick = testBridge;

load();