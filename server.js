const http = require('http');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== '' ? n : d; };
const list = (v, d) => String(v || d).split(',').map(s => s.trim()).filter(Boolean);

const PORT = num(process.env.PORT, 8787);
const LAN = process.env.ALLOW_LAN === '1';
const PUBLIC = process.env.PUBLIC === '1' || !!process.env.RENDER;
const TOKEN = process.env.AUTH_TOKEN || '';
const HOST = process.env.HOST || ((LAN || PUBLIC) ? '0.0.0.0' : '127.0.0.1');
const AUTO_SEND = process.env.VOICE_AUTO_SEND === '1';
const SOFT_ERRORS = process.env.SOFT_ERRORS !== '0';
const VERBOSE = process.env.VERBOSE === '1';

const RETRIES = num(process.env.RETRIES, 1);
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = num(process.env.MAX_RETRY_DELAY_MS, 8000);
const MAX_RETRY_AFTER_MS = 20000;


const FREE_PROMPT_CHARS = num(process.env.FREE_PROMPT_CHARS, 30000);
const FREE_TIMEOUT_MS = num(process.env.FREE_TIMEOUT_MS, 40000);
const FREE_TOTAL_MS = num(process.env.FREE_TOTAL_MS, 100000);
const FREE_QUEUE_MAX = num(process.env.FREE_QUEUE_MAX, 3);


let pending = [];

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
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function fail(res, code, message) {
  send(res, SOFT_ERRORS ? 200 : code, { error: { message: String(message) } });
}

function ok(res, text, model) {
  send(res, 200, { content: [{ type: 'text', text }], model: model || undefined });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 2e6) { reject(new Error('request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try { return raw ? JSON.parse(raw) : {}; }
  catch (e) { const err = new Error('request body is not valid JSON'); err.status = 400; throw err; }
}

const log = (...a) => { if (VERBOSE) console.log(new Date().toISOString().slice(11, 19), ...a); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const activity = new Map();
function setActivity(rid, text) {
  if (!rid) return;
  activity.set(rid, { text: String(text).slice(0, 160), t: Date.now() });
  if (activity.size > 40) activity.delete(activity.keys().next().value);
  log('status', rid, text);
}

function retryableStatus(s) { return s === 408 || s === 409 || s === 429 || s >= 500; }

function whyStatus(s) {
  if (s === 429) return 'rate limited (429)';
  if (s === 529) return 'overloaded (529)';
  if (s === 408) return 'request timed out (408)';
  if (s >= 500) return 'server error (' + s + ')';
  return 'HTTP ' + s;
}

function retryDelay(attempt, retryAfter) {
  if (retryAfter) {
    const secs = parseInt(retryAfter, 10);
    if (!isNaN(secs)) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  }
  const exp = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
  return exp + Math.floor(Math.random() * exp * 0.25);
}

async function fetchRetry(url, init, opt = {}) {
  const retries = opt.retries === undefined ? RETRIES : opt.retries;
  const timeoutMs = opt.timeoutMs || 120000;
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (opt.gone && opt.gone.aborted) throw new Error('client closed the connection');
    if (opt.deadline && Date.now() > opt.deadline) break;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onGone = () => ac.abort();
    if (opt.gone) opt.gone.addEventListener('abort', onGone, { once: true });
    if (opt.note) opt.note('waiting for ' + (opt.label || 'reply') + (attempt > 1 ? ' \u00b7 try ' + attempt + ' of ' + (retries + 1) : ''));
    try {
      const r = await fetch(url, { ...init, signal: ac.signal });
      const text = await r.text();
      const out = { status: r.status, ok: r.ok, text, headers: r.headers };
      if (!retryableStatus(r.status) || attempt > retries) return out;
      lastErr = new Error('HTTP ' + r.status);
      const wait = retryDelay(attempt, r.headers.get('retry-after'));
      if (opt.note) opt.note(whyStatus(r.status) + ' \u00b7 retrying in ' + Math.ceil(wait / 1000) + 's (' + attempt + ' of ' + retries + ')');
      log('retry', attempt, '/', retries, url, 'HTTP', r.status, 'in', wait + 'ms');
      await sleep(wait);
    } catch (e) {
      if (opt.gone && opt.gone.aborted) throw new Error('client closed the connection');
      lastErr = ac.signal.aborted ? new Error('timed out after ' + Math.round(timeoutMs / 1000) + 's') : e;
      if (attempt > retries) throw lastErr;
      const wait = retryDelay(attempt);
      if (opt.note) opt.note((/timed out/.test(String(lastErr.message)) ? 'timed out' : 'connection problem') + ' \u00b7 retrying in ' + Math.ceil(wait / 1000) + 's (' + attempt + ' of ' + retries + ')');
      log('retry', attempt, '/', retries, url, String(lastErr.message || lastErr), 'in', wait + 'ms');
      await sleep(wait);
    } finally {
      clearTimeout(timer);
      if (opt.gone) opt.gone.removeEventListener('abort', onGone);
    }
  }
  throw lastErr || new Error('gave up (time limit reached)');
}

function makeQueue(max) {
  let tail = Promise.resolve();
  let inFlight = 0;
  const enqueue = fn => {
    if (inFlight >= max) { const e = new Error('Free AI is busy with other requests - try again in a moment.'); e.busy = true; return Promise.reject(e); }
    inFlight++;
    const run = tail.then(fn);
    tail = run.catch(() => {}).then(() => { inFlight--; });
    return run;
  };
  enqueue.depth = () => inFlight;
  return enqueue;
}
const freeQueue = makeQueue(FREE_QUEUE_MAX);

const textOf = m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(b => (b && b.text) || '').join('') : '');
const ERROR_ECHO = /^\[(API error|free service error|empty response|network\/API error)/;
const CODE_RE = /```[\s\S]*?```/g;

function normalize(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = textOf(m).trim();
    if (!text) continue;
    if (m.role === 'assistant' && ERROR_ECHO.test(text)) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + text;
    else out.push({ role: m.role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function compact(messages, budgetChars) {
  let msgs = normalize(messages);
  const size = () => msgs.reduce((n, m) => n + m.content.length + 16, 0);
  budgetChars = Math.max(2000, budgetChars);
  if (size() <= budgetChars) return { messages: msgs, dropped: 0, shrunk: false };

  let shrunk = false;
  let lastAsst = -1;
  msgs.forEach((m, i) => { if (m.role === 'assistant') lastAsst = i; });
  msgs = msgs.map((m, i) => {
    if (m.role !== 'assistant' || i >= lastAsst) return m;
    const c = m.content.replace(CODE_RE, b => {
      if (b.length <= 400) return b;
      shrunk = true;
      return '[earlier code block omitted: ' + b.split('\n').length + ' lines]';
    });
    return { role: m.role, content: c };
  });

  let dropped = 0;
  while (size() > budgetChars && msgs.length > 1) {
    msgs.shift(); dropped++;
    while (msgs.length > 1 && msgs[0].role !== 'user') { msgs.shift(); dropped++; }
  }

  if (size() > budgetChars && msgs.length) {
    const m = msgs[msgs.length - 1];
    const keep = Math.max(1000, budgetChars - 300);
    if (m.content.length > keep) {
      const half = Math.floor(keep / 2);
      m.content = m.content.slice(0, half) + '\n[... middle of the message trimmed to fit ...]\n' + m.content.slice(-half);
    }
  }
  if (dropped > 0 && msgs.length) msgs[0] = { role: 'user', content: '[Earlier conversation was trimmed to fit the context window.]\n' + msgs[0].content };
  return { messages: msgs, dropped, shrunk };
}

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
}

// Keyless, open-weight chat providers. Tried in order; the first that answers wins.
// Override with FREE_PROVIDERS='[{"name":"x","url":"https://.../v1/chat/completions","models":["m1"],"key":""}]'
const DEFAULT_PROVIDERS = [
  { name: 'OVH', url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions', models: ['gpt-oss-120b', 'Meta-Llama-3_3-70B-Instruct', 'Qwen3.8-27B'] },
  { name: 'Kilo', url: 'https://api.kilo.ai/api/gateway/chat/completions', models: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'kilo-auto/free'] },
  { name: 'LLM7', url: 'https://api.llm7.io/v1/chat/completions', models: ['gpt-oss:20b', 'mistral-Nemo-Instruct-2407'] },
];
let PROVIDERS = DEFAULT_PROVIDERS;
try { if (process.env.FREE_PROVIDERS) PROVIDERS = JSON.parse(process.env.FREE_PROVIDERS); } catch (e) { console.log('FREE_PROVIDERS is not valid JSON, using defaults'); }
const candidates = PROVIDERS.flatMap(p => (p.models || []).map(m => ({ name: p.name || new URL(p.url).host, url: p.url, model: m, key: p.key || '' })));

const lastGood = { name: '', model: '', at: 0 };

async function routeFree(req, res, gone, act) {
  const body = await readJson(req);
  const system = body.system ? String(body.system) : '';
  const c = compact(body.messages, FREE_PROMPT_CHARS - system.length);
  if (!c.messages.length) return fail(res, 400, 'No message to send.');
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of c.messages) msgs.push(m);
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.2;
  const max_tokens = Math.max(256, Math.min(num(body.max_tokens, 4096), 8192));

  const ahead = freeQueue.depth();
  if (ahead > 0) act('queued \u00b7 ' + ahead + ' request' + (ahead > 1 ? 's' : '') + ' ahead');
  let result;
  try {
    result = await freeQueue(async () => {
      if (gone.aborted) throw new Error('client closed the connection');
      const deadline = Date.now() + FREE_TOTAL_MS;
      const tried = [];
      let n = 0;
      for (const cand of candidates) {
        if (Date.now() > deadline || gone.aborted) break;
        n++;
        act((tried.length ? 'that one failed \u00b7 ' : '') + 'asking ' + cand.model + ' on ' + cand.name + ' (' + n + ' of ' + candidates.length + ')');
        const headers = { 'content-type': 'application/json' };
        if (cand.key) headers.authorization = 'Bearer ' + cand.key;
        let r;
        try {
          r = await fetchRetry(cand.url, { method: 'POST', headers, body: JSON.stringify({ model: cand.model, messages: msgs, stream: false, temperature, max_tokens }) },
            { retries: 0, timeoutMs: FREE_TIMEOUT_MS, deadline, gone });
        } catch (e) { tried.push(cand.name + '/' + cand.model + ': ' + (e.message || e)); continue; }
        let d = {};
        try { d = JSON.parse(r.text); } catch (e) {}
        const text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (r.ok && text && String(text).trim()) {
          lastGood.name = cand.name; lastGood.model = cand.model; lastGood.at = Date.now();
          return { text: stripThinking(text) || String(text).trim(), model: cand.model + ' @ ' + cand.name };
        }
        const why = (d.error && (d.error.message || d.error)) || (r.ok ? 'empty answer' : whyStatus(r.status));
        tried.push(cand.name + '/' + cand.model + ': ' + String(typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 120));
        log('free candidate failed', tried[tried.length - 1]);
      }
      throw new Error('None of the free open-source AI services answered right now (they limit requests per minute, try again in a minute). Tried: ' + (tried.join(' | ') || 'nothing (time limit)'));
    });
  } catch (e) {
    if (gone.aborted) return;
    return fail(res, e.busy ? 429 : 502, e.message || e);
  }
  log('free ok via', result.model);
  return ok(res, result.text, result.model);
}

async function routeHealth(res) {
  send(res, 200, { ok: true, mode: 'free open-source only (no keys)', providers: PROVIDERS.map(p => ({ name: p.name, models: p.models })), lastGood, voice: { autoSend: AUTO_SEND } });
}

http.createServer(async (req, res) => {
  const gone = new AbortController();
  res.on('close', () => { if (!res.writableEnded) gone.abort(); });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, anthropic-version, x-auth-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {

    const host = (req.headers.host || '').split(':')[0];
    if (!PUBLIC && !LAN && host !== '127.0.0.1' && host !== 'localhost') return fail(res, 403, 'bad host');
    if (!PUBLIC && LAN && !privateClient(req.socket.remoteAddress)) return fail(res, 403, 'clients must be on your local network');
    const origin = req.headers.origin;
    if (!PUBLIC && origin && origin !== `http://${req.headers.host}`) return fail(res, 403, 'bad origin');

    const url = new URL(req.url, 'http://x');
    if (PUBLIC && TOKEN && url.pathname !== '/health' && (req.headers['x-auth-token'] || url.searchParams.get('token')) !== TOKEN) return fail(res, 401, 'unauthorized');
    const post = req.method === 'POST';

    if (req.method === 'GET' && url.pathname === '/mic') return send(res, 200, MIC_PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/health') return await routeHealth(res);
    const rid = String(url.searchParams.get('rid') || '').slice(0, 40);
    const act = t => setActivity(rid, t);
    if (post && rid) act('bridge received your message');
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { ok: true, name: 'AIChat bridge' });
    if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, { text: (activity.get(rid) || {}).text || '' });

    if (post && url.pathname === '/voice/push') {
      let text = '';
      try { text = (JSON.parse(await readBody(req) || '{}')).text; } catch (e) { return fail(res, 400, 'bad JSON'); }
      if (text) { pending.push(String(text).slice(0, 2000)); if (pending.length > 50) pending.shift(); }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/voice/poll') {
      const text = pending.join(' '); pending = [];
      return send(res, 200, { text, send: AUTO_SEND && !!text });
    }

    if (post && (url.pathname === '/free/messages' || url.pathname === '/v1/messages' || url.pathname === '/local/messages')) return await routeFree(req, res, gone.signal, act);

    fail(res, 404, 'not found');
  } catch (e) {
    if (gone.signal.aborted) return;
    fail(res, e.status || 500, e.message || e);
  }
}).listen(PORT, HOST, () => {
  console.log(`AIChat bridge on http://${HOST}:${PORT}`);
  console.log(`  free open-source AI, no keys: ${[...new Set(candidates.map(c => c.name))].join(', ')} (${candidates.length} models)`);
  console.log(`  check : http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/health`);
});
