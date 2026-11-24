// AIChat bridge - zero dependencies, Node 18+.
//   set ANTHROPIC_API_KEY=sk-ant-...   (PowerShell: $env:ANTHROPIC_API_KEY="...")
//   node server.js
//
// Does two things:
//  1) POST /v1/messages  -> forwards to api.anthropic.com, adding your key (key never lives in the mod).
//  2) /mic  -> a push-to-talk web page (browser speech recognition); text is polled by the game at /voice/poll.
//
// Bound to 127.0.0.1 only. Requests carrying a foreign Origin/Host are rejected so random websites
// can't use your key through this proxy.

const http = require('http');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const KEY = process.env.ANTHROPIC_API_KEY || '';
const AUTO_SEND = process.env.VOICE_AUTO_SEND === '1'; // 1 = game sends the message when speech finishes

let pending = []; // final transcripts waiting for the game

const MIC_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Chat mic</title>
<style>body{font:18px system-ui;background:#0b0f17;color:#fff;margin:0;padding:24px;max-width:640px}
button{font-size:22px;padding:16px 28px;border:0;border-radius:12px;background:#2d6cdf;color:#fff}
#t{margin-top:20px;min-height:3em;color:#9aa4b2}</style>
<h2>AI Chat - voice</h2>
<p>Click Start, allow the mic, and talk. Keep this tab open; text goes straight into the game.</p>
<button id="b">Start</button><div id="t"></div>
<script>
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const t = document.getElementById('t'), b = document.getElementById('b');
if (!SR) { t.textContent = 'This browser has no speech recognition. Use Chrome or Edge.'; b.disabled = true; }
else {
  const r = new SR(); r.continuous = true; r.interimResults = true; r.lang = navigator.language || 'en-US';
  let on = false;
  r.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) fetch('/voice/push', {method:'POST', body: JSON.stringify({text: res[0].transcript.trim()})});
      else interim += res[0].transcript;
    }
    t.textContent = interim;
  };
  r.onend = () => { if (on) r.start(); };
  r.onerror = e => { t.textContent = 'Mic error: ' + e.error; };
  b.onclick = () => { on = !on; b.textContent = on ? 'Stop' : 'Start'; on ? r.start() : r.stop(); };
}
</script>`;

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 2e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  try {
    // DNS-rebinding / cross-site protection
    const host = (req.headers.host || '').split(':')[0];
    if (HOST === '127.0.0.1' && host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'bad host' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'bad origin' });

    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && url.pathname === '/mic') return send(res, 200, MIC_PAGE, 'text/html; charset=utf-8');

    if (req.method === 'POST' && url.pathname === '/voice/push') {
      const { text } = JSON.parse(await readBody(req) || '{}');
      if (text) pending.push(String(text).slice(0, 2000));
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/voice/poll') {
      const text = pending.join(' '); pending = [];
      return send(res, 200, { text, send: AUTO_SEND && !!text });
    }

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      if (!KEY) return send(res, 500, { error: { message: 'ANTHROPIC_API_KEY is not set for the bridge.' } });
      const body = await readBody(req);
      const up = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
        body,
      });
      return send(res, up.status, await up.text());
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: { message: String(e.message || e) } });
  }
}).listen(PORT, HOST, () => console.log(`AIChat bridge on http://${HOST}:${PORT}  (key ${KEY ? 'set' : 'MISSING'})`));
