// AIChat bridge - zero dependencies, Node 18+.
//   set ANTHROPIC_API_KEY=sk-ant-...   (PowerShell: $env:ANTHROPIC_API_KEY="...")   <- only needed for Cloud mode
//   node server.js
//   For a phone on the same Wi-Fi:  set ALLOW_LAN=1  before node server.js, then point BRIDGE in AIChat.hxc at http://<this PC's LAN IP>:8787
//
// Routes (all take the same Anthropic-style request: {model, system, messages, max_tokens, temperature}
// and answer with {content:[{type:'text', text}]} or {error:{message}}):
//  1) POST /v1/messages     -> Claude (api.anthropic.com), your key is added here so it never lives in the mod.
//  2) POST /local/messages  -> a local open-source model through Ollama (free, no key).
//  3) POST /free/messages   -> a free hosted model (Pollinations) with retries, a one-at-a-time queue and model fallback.
//  4) /mic, /voice/push, /voice/poll -> push-to-talk page (browser speech recognition) polled by the game.
//  5) GET /health           -> what is reachable right now (handy to debug from a phone browser).
//  6) GET /status?rid=..    -> what the bridge is doing for that request right now (queued, retrying, trying model X ...); the game shows it in its status bar.
//
// Improvements over the first version (ideas borrowed from Claude Code's API client and its context compaction):
//  - Retry with exponential backoff (500ms, 1s, 2s ... capped), honouring Retry-After, on network errors, 408/409/429/5xx.
//  - Per-request timeouts, and upstream work is cancelled if the game closes the connection.
//  - Free mode: requests run one at a time (the free service rejects parallel calls), fall back across models/endpoints.
//  - Long chats are compacted to fit the model's context: old code blocks are shrunk first, then the oldest turns dropped,
//    instead of the model silently forgetting the system prompt.
//  - Local mode: output reserve is capped so prompt + answer fit in num_ctx, <think> blocks are stripped,
//    and a missing model gives a "run: ollama pull ..." message that lists what is installed.
//  - Error replies are sent with HTTP 200 and {error:{message}} by default (SOFT_ERRORS=1) so the game can show the real reason.
//    Set SOFT_ERRORS=0 for real HTTP status codes.
//
// Bound to 127.0.0.1 only unless ALLOW_LAN=1 (then only private-network clients are accepted). Requests carrying a foreign Origin/Host are rejected so random websites
// can't use your key through this proxy.

const http = require('http');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== '' ? n : d; };
const list = (v, d) => String(v || d).split(',').map(s => s.trim()).filter(Boolean);

const PORT = num(process.env.PORT, 8787);
const LAN = process.env.ALLOW_LAN === '1';
const PUBLIC = process.env.PUBLIC === '1' || !!process.env.RENDER; // hosted (e.g. Render): bind 0.0.0.0, skip local-only checks
const TOKEN = process.env.AUTH_TOKEN || ''; // optional shared secret for hosted mode
const HOST = process.env.HOST || ((LAN || PUBLIC) ? '0.0.0.0' : '127.0.0.1');
const KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const AUTO_SEND = process.env.VOICE_AUTO_SEND === '1'; // 1 = game sends the message when speech finishes
const SOFT_ERRORS = process.env.SOFT_ERRORS !== '0';
const VERBOSE = process.env.VERBOSE === '1';

// retry policy (same shape as Claude Code: 500ms base, doubling, capped; shorter cap because a person is waiting in-game)
const RETRIES = num(process.env.RETRIES, 3);
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = num(process.env.MAX_RETRY_DELAY_MS, 8000);
const MAX_RETRY_AFTER_MS = 20000; // never sleep longer than this even if the server asks

// Local (Ollama)
const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const LOCAL_CTX = num(process.env.LOCAL_CTX, 16384); // was 8192; a 4096-token answer + the long system prompt did not fit in 8192
const LOCAL_KEEP_ALIVE = process.env.LOCAL_KEEP_ALIVE || '30m';
const LOCAL_TIMEOUT_MS = num(process.env.LOCAL_TIMEOUT_MS, 300000); // first request may have to load the model
const CHARS_PER_TOKEN = 3; // conservative for code

// Free (Pollinations). Tried in order: every model on every endpoint.
// The service has moved to gen.pollinations.ai, so the endpoint list is configurable.
// FREE_KEY is optional (a pollinations key); it is sent as a Bearer token if set.
const FREE_URLS = list(process.env.FREE_URLS, 'https://text.pollinations.ai/openai,https://gen.pollinations.ai/v1/chat/completions');
const FREE_MODELS = list(process.env.FREE_MODELS, 'openai-fast,openai');
const FREE_KEY = process.env.FREE_KEY || '';
const FREE_PROMPT_CHARS = num(process.env.FREE_PROMPT_CHARS, 30000); // system + conversation
const FREE_TIMEOUT_MS = num(process.env.FREE_TIMEOUT_MS, 120000);
const FREE_TOTAL_MS = num(process.env.FREE_TOTAL_MS, 150000); // give up after this long overall
const FREE_QUEUE_MAX = num(process.env.FREE_QUEUE_MAX, 3);

const CLOUD_TIMEOUT_MS = num(process.env.CLOUD_TIMEOUT_MS, 180000);

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

// ---------------------------------------------------------------- helpers

function privateClient(addr) {
  const a = String(addr || '').replace('::ffff:', '');
  return a === '127.0.0.1' || a === '::1' || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

function send(res, code, body, type = 'application/json') {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Error reply the game can read. With SOFT_ERRORS the HTTP status is 200 so the game does not swallow the message.
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

// live "what am I doing" text per request id (the game polls /status?rid=...)
const activity = new Map();
function setActivity(rid, text) {
  if (!rid) return;
  activity.set(rid, { text: String(text).slice(0, 160), t: Date.now() });
  if (activity.size > 40) activity.delete(activity.keys().next().value);
  log('status', rid, text);
}

// ---------------------------------------------------------------- retry (from Claude Code services/claude.ts withRetry)

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
  return exp + Math.floor(Math.random() * exp * 0.25); // small jitter so retries do not line up
}

// fetch + read the body, retrying transient failures. Resolves {status, ok, text, headers}. Throws on network failure / timeout / client gone.
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

// one-at-a-time queue; rejects when too many are already waiting
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

// ---------------------------------------------------------------- conversation cleanup + compaction (idea from Claude Code services/compact)

const textOf = m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(b => (b && b.text) || '').join('') : '');
const ERROR_ECHO = /^\[(API error|free service error|empty response|network\/API error)/;
const CODE_RE = /```[\s\S]*?```/g;

// flatten to plain text, drop empties and error echoes the game stored as assistant turns, merge same-role neighbours, start with a user turn
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

// Fit the conversation into `budgetChars`. Order of sacrifice: old code blocks -> oldest turns -> middle of one giant message.
function compact(messages, budgetChars) {
  let msgs = normalize(messages);
  const size = () => msgs.reduce((n, m) => n + m.content.length + 16, 0);
  budgetChars = Math.max(2000, budgetChars);
  if (size() <= budgetChars) return { messages: msgs, dropped: 0, shrunk: false };

  let shrunk = false;
  let lastAsst = -1;
  msgs.forEach((m, i) => { if (m.role === 'assistant') lastAsst = i; });
  msgs = msgs.map((m, i) => {
    if (m.role !== 'assistant' || i >= lastAsst) return m; // keep the newest answer intact: the user is probably editing it
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

// ---------------------------------------------------------------- routes

// Cloud: Claude through the Anthropic API.
async function routeCloud(req, res, gone, act) {
  if (!KEY) return fail(res, 500, 'ANTHROPIC_API_KEY is not set for the bridge.');
  const body = await readJson(req);
  if (Array.isArray(body.messages)) body.messages = normalize(body.messages);
  act('sending to Claude');
  const r = await fetchRetry(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  }, { timeoutMs: CLOUD_TIMEOUT_MS, gone, note: act, label: 'Claude' });
  if (r.ok) return send(res, 200, r.text);
  let msg = r.text;
  try { const j = JSON.parse(r.text); msg = (j.error && j.error.message) || msg; } catch (e) {}
  if (r.status === 401) msg = 'Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY. ' + msg;
  else if (r.status === 429) msg = 'Rate limited by Anthropic (429) even after retries. ' + msg;
  else if (r.status === 529) msg = 'Anthropic is overloaded (529) even after retries. ' + msg;
  return fail(res, r.status, msg);
}

// Local: Ollama.
async function ollamaInstalled(gone) {
  try {
    const r = await fetchRetry(OLLAMA + '/api/tags', { method: 'GET' }, { retries: 0, timeoutMs: 4000, gone });
    if (!r.ok) return null;
    return (JSON.parse(r.text).models || []).map(m => m.name);
  } catch (e) { return null; }
}

async function routeLocal(req, res, gone, act) {
  const body = await readJson(req);
  const system = body.system ? String(body.system) : '';
  const model = body.model;
  const wanted = num(body.max_tokens, 2048);
  // keep prompt + answer inside num_ctx: Ollama silently drops the start of an over-long prompt (that is where the system prompt is)
  const reserve = Math.max(256, Math.min(wanted, Math.floor(LOCAL_CTX * 0.35)));
  const promptChars = (LOCAL_CTX - reserve - 64) * CHARS_PER_TOKEN - system.length;
  const c = compact(body.messages, promptChars);
  log('local', model, 'msgs', c.messages.length, 'dropped', c.dropped, 'reserve', reserve);

  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of c.messages) msgs.push(m);

  let r;
  try {
    r = await fetchRetry(OLLAMA + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, messages: msgs, stream: false, keep_alive: LOCAL_KEEP_ALIVE,
        options: { temperature: typeof body.temperature === 'number' ? body.temperature : 0.2, num_ctx: LOCAL_CTX, num_predict: reserve },
      }),
    }, { retries: 1, timeoutMs: LOCAL_TIMEOUT_MS, gone, note: act, label: model + (c.dropped ? ', trimmed ' + c.dropped + ' old turns' : '') + ' (first reply loads the model)' });
  } catch (e) {
    if (gone.aborted) return;
    if (/timed out/.test(String(e.message))) return fail(res, 504, 'Ollama did not answer in time (' + e.message + '). The model may still be loading - try again, or use a smaller model.');
    return fail(res, 502, 'Cannot reach Ollama at ' + OLLAMA + ' - is it installed and running?');
  }

  let data = {};
  try { data = JSON.parse(r.text); } catch (e) {}
  if (!r.ok) {
    const detail = typeof data.error === 'string' ? data.error : (data.error && data.error.message) || '';
    if (r.status === 404 || /not found/i.test(detail)) {
      const have = await ollamaInstalled(gone);
      return fail(res, 502, "Model '" + model + "' is not installed in Ollama. Run:  ollama pull " + model +
        (have && have.length ? '   (installed: ' + have.join(', ') + ' - set LOCAL_MODEL in AIChat.hxc to one of these)' : ''));
    }
    return fail(res, 502, detail || ('Ollama error ' + r.status));
  }
  const text = stripThinking(data.message && data.message.content);
  if (!text) return fail(res, 502, 'The local model returned nothing' + (data.done_reason === 'length' ? ' (it ran out of room while thinking - raise LOCAL_CTX or use a non-reasoning model).' : '.'));
  return ok(res, text, model);
}

// Free: hosted model with retries, queue and fallback across models/endpoints.
function freeHeaders() {
  const h = { 'content-type': 'application/json' };
  if (FREE_KEY) h.authorization = 'Bearer ' + FREE_KEY;
  return h;
}

async function routeFree(req, res, gone, act) {
  const body = await readJson(req);
  const system = body.system ? String(body.system) : '';
  const c = compact(body.messages, FREE_PROMPT_CHARS - system.length);
  if (!c.messages.length) return fail(res, 400, 'No message to send.');
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of c.messages) msgs.push(m);
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.2;

  const ahead = freeQueue.depth();
  if (ahead > 0) act('queued \u00b7 ' + ahead + ' request' + (ahead > 1 ? 's' : '') + ' ahead (free service takes one at a time)');
  let result;
  try {
    result = await freeQueue(async () => {
      if (gone.aborted) throw new Error('client closed the connection');
      const deadline = Date.now() + FREE_TOTAL_MS;
      const tried = [];
      // with several candidates, do not burn the whole retry budget on the first one
      // the game's FREE_MODEL goes first, then the bridge's FREE_MODELS as fallbacks
      const models = body.model ? [String(body.model)].concat(FREE_MODELS.filter(m => m !== body.model)) : FREE_MODELS;
      const perTry = FREE_URLS.length * models.length > 1 ? Math.min(RETRIES, 2) : RETRIES;
      let optionNo = 0;
      const optionTotal = FREE_URLS.length * models.length;
      for (const url of FREE_URLS) {
        for (const model of models) {
          if (Date.now() > deadline || gone.aborted) break;
          optionNo++;
          if (tried.length) act('that one failed \u00b7 trying the next model');
          let r;
          try {
            r = await fetchRetry(url, { method: 'POST', headers: freeHeaders(), body: JSON.stringify({ model, messages: msgs, stream: false, temperature }) },
              { retries: perTry, timeoutMs: FREE_TIMEOUT_MS, deadline, gone, note: act, label: model + (optionTotal > 1 ? ' \u00b7 option ' + optionNo + ' of ' + optionTotal : '') });
          } catch (e) { tried.push(model + ' @ ' + new URL(url).host + ': ' + (e.message || e)); continue; }
          let d = {};
          try { d = JSON.parse(r.text); } catch (e) {}
          const text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
          if (r.ok && text && String(text).trim()) return { text: stripThinking(text) || String(text).trim(), model };
          const why = (d.error && (d.error.message || d.error)) || (r.ok ? 'empty answer' : 'HTTP ' + r.status);
          tried.push(model + ' @ ' + new URL(url).host + ': ' + String(why).slice(0, 160) + (r.status === 401 || r.status === 402 || r.status === 403 ? ' (this service may now need a key: set FREE_KEY)' : ''));
          log('free candidate failed', tried[tried.length - 1]);
        }
      }
      const e = new Error('The free AI service did not give an answer. Tried: ' + (tried.join(' | ') || 'nothing (time limit)'));
      throw e;
    });
  } catch (e) {
    if (gone.aborted) return;
    return fail(res, e.busy ? 429 : 502, e.message || e);
  }
  log('free ok via', result.model);
  return ok(res, result.text, result.model);
}

async function routeHealth(res, gone) {
  const have = await ollamaInstalled(gone);
  send(res, 200, {
    ok: true,
    cloud: { keySet: !!KEY },
    local: { url: OLLAMA, reachable: have !== null, models: have || [], num_ctx: LOCAL_CTX },
    free: { endpoints: FREE_URLS, models: FREE_MODELS, keySet: !!FREE_KEY },
    voice: { autoSend: AUTO_SEND },
  });
}

http.createServer(async (req, res) => {
  const gone = new AbortController();
  res.on('close', () => { if (!res.writableEnded) gone.abort(); });
  try {
    // DNS-rebinding / cross-site protection
    const host = (req.headers.host || '').split(':')[0];
    if (!PUBLIC && !LAN && host !== '127.0.0.1' && host !== 'localhost') return fail(res, 403, 'bad host');
    if (!PUBLIC && LAN && !privateClient(req.socket.remoteAddress)) return fail(res, 403, 'clients must be on your local network');
    const origin = req.headers.origin;
    if (!PUBLIC && origin && origin !== `http://${req.headers.host}`) return fail(res, 403, 'bad origin');

    const url = new URL(req.url, 'http://x');
    if (PUBLIC && TOKEN && url.pathname !== '/health' && (req.headers['x-auth-token'] || url.searchParams.get('token')) !== TOKEN) return fail(res, 401, 'unauthorized');
    const post = req.method === 'POST';

    if (req.method === 'GET' && url.pathname === '/mic') return send(res, 200, MIC_PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/health') return await routeHealth(res, gone.signal);
    const rid = String(url.searchParams.get('rid') || '').slice(0, 40);
    const act = t => setActivity(rid, t);
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

    if (post && url.pathname === '/v1/messages') return await routeCloud(req, res, gone.signal, act);
    if (post && url.pathname === '/local/messages') return await routeLocal(req, res, gone.signal, act);
    if (post && url.pathname === '/free/messages') return await routeFree(req, res, gone.signal, act);

    fail(res, 404, 'not found');
  } catch (e) {
    if (gone.signal.aborted) return;
    fail(res, e.status || 500, e.message || e);
  }
}).listen(PORT, HOST, () => {
  console.log(`AIChat bridge on http://${HOST}:${PORT}`);
  console.log(`  cloud : ${KEY ? 'key set' : 'no ANTHROPIC_API_KEY (Cloud mode off)'}`);
  console.log(`  local : ${OLLAMA}  num_ctx ${LOCAL_CTX}`);
  console.log(`  free  : ${FREE_MODELS.join(', ')}  via ${FREE_URLS.map(u => new URL(u).host).join(', ')}${FREE_KEY ? '  (key set)' : ''}`);
  console.log(`  check : http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/health`);
});
