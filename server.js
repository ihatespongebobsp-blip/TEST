// AIChat bridge - zero dependencies, Node 18+.
//   set ANTHROPIC_API_KEY=sk-ant-...   (PowerShell: $env:ANTHROPIC_API_KEY="...")
//   node server.js
//   For a phone on the same Wi-Fi:  set ALLOW_LAN=1  before node server.js, then point BRIDGE in AIChat.hxc at http://<this PC's LAN IP>:8787
//
// Does two things:
//  1) POST /v1/messages  -> forwards to api.anthropic.com, adding your key (key never lives in the mod).
//  2) POST /local/messages -> same request shape, answered by a local open-source model through Ollama (free, no key).
//  3) /mic  -> a push-to-talk web page (browser speech recognition); text is polled by the game at /voice/poll.
//
// Bound to 127.0.0.1 only unless ALLOW_LAN=1 (then only private-network clients are accepted). Requests carrying a foreign Origin/Host are rejected so random websites
// can't use your key through this proxy.

const http = require('http');

const PORT = Number(process.env.PORT || 8787);
const LAN = process.env.ALLOW_LAN === '1';
const HOST = process.env.HOST || (LAN ? '0.0.0.0' : '127.0.0.1');
const KEY = process.env.ANTHROPIC_API_KEY || '';
const AUTO_SEND = process.env.VOICE_AUTO_SEND === '1'; // 1 = game sends the message when speech finishes

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const LOCAL_CTX = Number(process.env.LOCAL_CTX || 8192);

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

function privateClient(addr) {
  const a = String(addr || '').replace('::ffff:', '');
  return a === '127.0.0.1' || a === '::1' || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

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
    if (!LAN && host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'bad host' });
    if (LAN && !privateClient(req.socket.remoteAddress)) return send(res, 403, { error: 'clients must be on your local network' });
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

    if (req.method === 'POST' && url.pathname === '/local/messages') {
      const body = JSON.parse(await readBody(req) || '{}');
      const flat = m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(b => b.text || '').join('') : '');
      const msgs = [];
      if (body.system) msgs.push({ role: 'system', content: String(body.system) });
      for (const m of body.messages || []) msgs.push({ role: m.role, content: flat(m) });
      let up;
      try {
        up = await fetch(OLLAMA + '/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: body.model, messages: msgs, stream: false, options: { temperature: typeof body.temperature === 'number' ? body.temperature : 0.2, num_ctx: LOCAL_CTX, num_predict: body.max_tokens || 2048 } }),
        });
      } catch (e) {
        return send(res, 502, { error: { message: 'Cannot reach Ollama at ' + OLLAMA + ' - is it installed and running?' } });
      }
      const data = await up.json().catch(() => ({}));
      if (!up.ok) return send(res, 502, { error: { message: data.error || ('Ollama error ' + up.status + ' (did you run: ollama pull ' + body.model + ' ?)') } });
      return send(res, 200, { content: [{ type: 'text', text: (data.message && data.message.content) || '' }] });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: { message: String(e.message || e) } });
  }
}).listen(PORT, HOST, () => console.log(`AIChat bridge on http://${HOST}:${PORT}  (key ${KEY ? 'set' : 'MISSING'})`));
