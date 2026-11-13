const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const START_DELAY_MS = 3000;
const ROOM_TTL_MS = 10 * 60 * 1000;
const DISCONNECT_MS = (+process.env.T_DISC) || 15 * 1000;
const LIST_STALE_MS = (+process.env.T_STALE) || 30 * 1000;
const DEAD_LOBBY_MS = 90 * 1000;
const MAX_REQ_PER_SEC_PER_IP = 120;
const VERSION = 8;
const ALTERNATE_PICKS = process.env.T_ALT !== '0';
const SELECT_MS = (+process.env.T_SELECT) || 20 * 1000;
const SELECT_GRACE_MS = 1500;
const RND_MS = 2500;
const VERIFY_MS = 4000;
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const XFER_MAX_MS = 240 * 1000;
const XFER_BYTES_MAX = (+process.env.T_XMAX) || 96 * 1024 * 1024;
const XFER_CHUNK_MAX = 262144;
const XFER_BODY_MAX = 300000;
const XFER_PREFIXES = ['data/songs/', 'data/characters/', 'data/stages/', 'images/', 'songs/'];
const XFER_EXT = /\.(png|jpg|xml|txt|json|ogg|mp3|wav)$/i;
const XFER_CHARS = /^[A-Za-z0-9_\-. \/()'!,]+$/;

const rooms = new Map();
const PRESENCE_MS = 45 * 1000;
const presence = new Map();
function onlineCount() {
  const cut = Date.now() - PRESENCE_MS;
  for (const [id, t] of presence) if (t < cut) presence.delete(id);
  return presence.size;
}
const rate = new Map();

function makeCode(len) {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < len; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function makeTok() {
  return crypto.randomBytes(8).toString('hex');
}

function cleanName(n) {
  n = String(n || 'PLAYER').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 12);
  return n.length ? n : 'PLAYER';
}

function otherSlot(s) {
  return s === 'p1' ? 'p2' : 'p1';
}

function slotGone(r, slot) {
  const p = r.players[slot];
  if (!p) return false;
  if (p.xfHold && Date.now() < p.xfHold) return false;
  return Date.now() - p.last >= DISCONNECT_MS;
}

function cleanXPath(p) {
  p = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.length > 200 || p.indexOf('..') >= 0 || p.indexOf('//') >= 0) return '';
  if (!XFER_CHARS.test(p) || !XFER_EXT.test(p)) return '';
  if (!XFER_PREFIXES.some((x) => p.startsWith(x))) return '';
  return p;
}

function clearXfer(r) {
  r.xm = { p1: null, p2: null };
  r.xneed = { p1: null, p2: null };
  r.xfiles = new Map();
  r.xbytes = 0;
}

function dropXf(p) {
  p.xf = false;
  p.xfAt = 0;
  p.xfHold = 0;
}

function preMatch(r) {
  return r.status === 'lobby' || r.status === 'selecting' || r.status === 'picked';
}

function guestSlotFree(r) {
  const gs = otherSlot(r.host);
  const g = r.players[gs];
  if (!g) return true;
  return preMatch(r) && slotGone(r, gs);
}

function bothHere(r) {
  return !!r.players.p1 && !!r.players.p2 && !slotGone(r, 'p1') && !slotGone(r, 'p2');
}

function songKey(r) {
  return r.song + '|' + r.diff;
}

function clearPicks(r) {
  r.picks = { p1: null, p2: null };
  r.alt = null;
  r.fell = false;
  r.rnd = false;
  r.pickedBy = '';
}

function backToLobby(r) {
  r.status = 'lobby';
  r.song = '';
  r.diff = '';
  r.selectAt = 0;
  r.resolveAt = 0;
  r.alt = null;
  r.fell = false;
  r.rnd = false;
  r.pickedBy = '';
}

function beginSelect(r, now, notice) {
  r.status = 'selecting';
  r.selectAt = now + SELECT_MS;
  r.resolveAt = r.selectAt + SELECT_GRACE_MS;
  r.selId++;
  r.song = '';
  r.diff = '';
  r.alt = null;
  r.fell = false;
  r.rnd = false;
  r.pickedBy = '';
  if (notice) { r.noticeN++; r.notice = notice; }
}

function resolveSelect(r, now) {
  const cand = ['p1', 'p2'].filter((s) => r.players[s] && r.picks[s] && r.picks[s].song);
  if (!cand.length) {
    if (!r.rnd) { r.rnd = true; r.resolveAt = now + RND_MS; return; }
    beginSelect(r, now, 'NO SONG WAS PICKED - PICK ONE!');
    return;
  }
  let win = cand[crypto.randomInt(cand.length)];
  const contested = cand.length === 2 && (r.picks.p1.song !== r.picks.p2.song || r.picks.p1.diff !== r.picks.p2.diff);
  if (contested) {
    if (ALTERNATE_PICKS && r.lastWin) win = otherSlot(r.lastWin);
    r.lastWin = win;
  }
  const lose = cand.filter((s) => s !== win)[0];
  r.song = r.picks[win].song;
  r.diff = r.picks[win].diff;
  r.pickedBy = win;
  r.alt = (lose && (r.picks[lose].song !== r.song || r.picks[lose].diff !== r.diff)) ? { song: r.picks[lose].song, diff: r.picks[lose].diff, by: lose } : null;
  r.fell = false;
  r.rnd = false;
  r.picks = { p1: null, p2: null };
  enterPicked(r, now);
}

function enterPicked(r, now) {
  r.status = 'picked';
  r.pickAt = now;
  for (const s of ['p1', 'p2']) {
    const p = r.players[s];
    if (p) { p.hasSong = true; p.conf = ''; p.ready = true; }
  }
}

function startMatch(r, now) {
  clearXfer(r);
  for (const s of ['p1', 'p2']) if (r.players[s]) dropXf(r.players[s]);
  r.status = 'starting';
  r.startAt = now + START_DELAY_MS;
  r.startId++;
}

function tickRoom(r) {
  const now = Date.now();
  const p1 = r.players.p1;
  const p2 = r.players.p2;
  if (r.status === 'lobby') {
    if (bothHere(r) && p1.lob && p2.lob) beginSelect(r, now, '');
  } else if (r.status === 'selecting') {
    if (!bothHere(r)) backToLobby(r);
    else if (now >= r.resolveAt) resolveSelect(r, now);
  } else if (r.status === 'picked') {
    if (!bothHere(r)) { backToLobby(r); return; }
    const key = songKey(r);
    if ([p1, p2].some((p) => p.xf)) {
      if (now - r.pickAt < XFER_MAX_MS) return;
      for (const p of [p1, p2]) if (p.xf) { dropXf(p); p.hasSong = false; p.conf = key; }
    }
    const missing = [p1, p2].some((p) => p.conf === key && p.hasSong === false);
    if (missing) {
      if (r.alt && !r.fell) {
        r.fell = true;
        r.song = r.alt.song;
        r.diff = r.alt.diff;
        r.pickedBy = r.alt.by;
        r.alt = null;
        enterPicked(r, now);
      } else {
        beginSelect(r, now, 'THAT SONG IS MISSING ON ONE DEVICE - PICK AGAIN');
      }
      return;
    }
    const confirmed = p1.conf === key && p2.conf === key;
    if (confirmed || now - r.pickAt >= VERIFY_MS) startMatch(r, now);
  } else if (r.status === 'starting') {
    if (now > r.startAt + 5000 && bothHere(r) && p1.lob && p2.lob) backToLobby(r);
  }
}

function listOpen() {
  const now = Date.now();
  const open = [];
  for (const r of rooms.values()) {
    const h = r.players[r.host];
    if (!h || r.status !== 'lobby' || now - h.last >= LIST_STALE_MS) continue;
    if (!guestSlotFree(r)) continue;
    if (r.vis !== 'everyone') continue;
    open.push({ code: r.code, host: h.name, song: r.song, diff: r.diff, mode: r.mode, side: r.hostSide, created: r.created });
  }
  open.sort((a, b) => b.created - a.created);
  return open.slice(0, 50);
}

function snapshotPlayer(p) {
  if (!p) return null;
  return {
    name: p.name,
    ready: p.ready,
    hasSong: p.hasSong,
    xf: !!p.xf,
    connected: Date.now() - p.last < DISCONNECT_MS || !!(p.xfHold && Date.now() < p.xfHold),
  };
}

function snapshot(r) {
  return {
    code: r.code,
    status: r.status,
    song: r.song,
    diff: r.diff,
    startId: r.startId,
    selId: r.selId,
    rnd: r.rnd,
    pickedBy: r.pickedBy,
    noticeN: r.noticeN,
    notice: r.notice,
    hostSide: r.hostSide,
    vis: r.vis,
    mode: r.mode,
    acc: r.acc,
    mech: r.mech,
    host: r.host,
    p1: snapshotPlayer(r.players.p1),
    p2: snapshotPlayer(r.players.p2),
  };
}

function reply(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, msg) {
  reply(res, { ok: false, error: msg });
}

function getIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '?';
}

function overRate(ip) {
  const sec = Math.floor(Date.now() / 1000);
  let e = rate.get(ip);
  if (!e || e.sec !== sec) { e = { sec, n: 0 }; rate.set(ip, e); }
  e.n++;
  return e.n > MAX_REQ_PER_SEC_PER_IP;
}

function cleanEvent(e, me) {
  if (!e || typeof e !== 'object') return null;
  const k = String(e.k);
  const num = (v, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) v = 0; return Math.max(lo, Math.min(hi, v)); };
  const eid = num(e.eid, 0, 1e9) | 0;
  if (k === 'hit') {
    const out = { k, l: num(e.l, -1, 3) | 0, n: num(e.n, 0, 60000) | 0, eid };
    const j = String(e.j);
    if (j === 'sick' || j === 'good' || j === 'bad' || j === 'shit') out.j = j;
    return out;
  }
  if (k === 'miss') return { k, l: num(e.l, -1, 3) | 0, eid };
  if (k === 'done') return { k, s: num(e.s, -1e9, 1e9) | 0, a: Math.round(num(e.a, 0, 100) * 100) / 100, c: num(e.c, 0, 100000) | 0, eid };
  if (k === 'quit') return { k, eid };
  return null;
}

function promoteGuest(r, leavingSlot) {
  const gs = otherSlot(leavingSlot);
  r.players[leavingSlot] = null;
  r.inbox[leavingSlot] = [];
  r.picks[leavingSlot] = null;
  r.lastWin = '';
  if (!r.players[gs]) { rooms.delete(r.code); return; }
  r.host = gs;
  r.hostSide = r.hostSide === 'bf' ? 'dad' : 'bf';
  r.players[gs].ready = false;
  backToLobby(r);
}

function handle(path, body, res, ip) {
  if (path === '/create') {
    const code = makeCode(4);
    if (!code) return fail(res, 'SERVER FULL');
    const tok = makeTok();
    const vis = ['none', 'friends', 'everyone'].includes(body.vis) ? body.vis : 'everyone';
    const mode = ['score', 'accuracy', 'misses'].includes(body.mode) ? body.mode : 'score';
    const acc = ['ms', 'ratings'].includes(body.acc) ? body.acc : (mode === 'accuracy' ? 'ms' : 'ratings');
    const r = {
      code,
      ip,
      created: Date.now(),
      last: Date.now(),
      host: 'p1',
      players: {
        p1: { name: cleanName(body.name), ready: false, hasSong: true, conf: '', lob: false, last: Date.now(), tok, ip },
        p2: null,
      },
      inbox: { p1: [], p2: [] },
      kicked: new Set(),
      banIps: new Set(),
      song: '',
      diff: '',
      hostSide: body.side === 'dad' ? 'dad' : 'bf',
      vis,
      mode,
      acc,
      mech: !!body.mech,
      xm: { p1: null, p2: null },
      xneed: { p1: null, p2: null },
      xfiles: new Map(),
      xbytes: 0,
      status: 'lobby',
      startAt: 0,
      startId: 0,
      selectAt: 0,
      resolveAt: 0,
      pickAt: 0,
      selId: 0,
      picks: { p1: null, p2: null },
      lastWin: '',
      alt: null,
      fell: false,
      rnd: false,
      pickedBy: '',
      noticeN: 0,
      notice: '',
      seq: 0,
    };
    rooms.set(code, r);
    return reply(res, { ok: true, pid: 'p1', tok, room: snapshot(r) });
  }

  if (path === '/list') {
    return reply(res, { ok: true, rooms: listOpen() });
  }

  if (path === '/ping') {
    const cid = String(body.cid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    if (cid.length >= 6 && (presence.has(cid) || presence.size < 100000)) presence.set(cid, Date.now());
    return reply(res, { ok: true, online: onlineCount() });
  }

  if (path === '/join') {
    const r = rooms.get(String(body.room || '').toUpperCase().trim());
    if (!r) return fail(res, 'ROOM NOT FOUND');
    if (r.vis === 'none') return fail(res, 'NO ONE CAN JOIN THIS ROOM');
    if (r.banIps.has(ip)) return fail(res, 'YOU WERE KICKED FROM THIS ROOM');
    if (!guestSlotFree(r)) return fail(res, 'ROOM IS FULL');
    const gs = otherSlot(r.host);
    const tok = makeTok();
    r.players[r.host].ready = false;
    r.picks[gs] = null;
    r.lastWin = '';
    if (r.status !== 'lobby') backToLobby(r);
    r.players[gs] = { name: cleanName(body.name), ready: false, hasSong: true, conf: '', lob: false, last: Date.now(), tok, ip };
    r.inbox[gs] = [];
    r.xm[gs] = null;
    r.xneed[gs] = null;
    r.last = Date.now();
    return reply(res, { ok: true, pid: gs, tok, room: snapshot(r) });
  }

  const r = rooms.get(String(body.room || '').toUpperCase());
  if (!r) return fail(res, 'ROOM CLOSED');
  const pid = body.pid === 'p2' ? 'p2' : 'p1';
  const me = r.players[pid];
  if (!me || !body.tok || me.tok !== body.tok) {
    return fail(res, r.kicked.has(body.tok) ? 'KICKED' : 'NOT IN ROOM');
  }
  const other = otherSlot(pid);
  const isHost = pid === r.host;

  if (path === '/leave') {
    if (isHost) {
      promoteGuest(r, pid);
    } else {
      r.players[pid] = null;
      r.inbox[pid] = [];
      r.picks[pid] = null;
      r.players[r.host].ready = false;
      backToLobby(r);
    }
    return reply(res, { ok: true });
  }

  if (path === '/sync') {
    me.last = Date.now();
    r.last = Date.now();
    if (body.name) me.name = cleanName(body.name);

    const p = body.patch || {};
    if ('ready' in p) me.ready = !!p.ready;
    if ('hasSong' in p) {
      if (typeof p.hasFor !== 'string' || p.hasFor === songKey(r)) {
        me.hasSong = !!p.hasSong;
        me.conf = typeof p.hasFor === 'string' ? p.hasFor : songKey(r);
      }
    }
    if ('xf' in p) {
      me.xf = !!p.xf;
      if (me.xf) { if (!me.xfAt) me.xfAt = Date.now(); } else { me.xfAt = 0; me.xfHold = 0; }
    }
    if (typeof p.xhold === 'number' && me.xf) me.xfHold = Date.now() + Math.max(0, Math.min(90, p.xhold)) * 1000;
    if ('lob' in body) me.lob = !!body.lob;
    if (p.pick && typeof p.pick === 'object' && (r.status === 'lobby' || r.status === 'selecting')) {
      const song = String(p.pick.song || '').slice(0, 120);
      const diff = String(p.pick.diff || '').slice(0, 40);
      if (song && diff) r.picks[pid] = { song, diff };
    }

    if (isHost) {
      if ('song' in p) r.song = String(p.song).slice(0, 120);
      if ('diff' in p) r.diff = String(p.diff).slice(0, 40);
      if ((p.side === 'bf' || p.side === 'dad') && p.side !== r.hostSide && r.status === 'lobby') {
        r.hostSide = p.side;
        me.ready = false;
        if (r.players[other]) r.players[other].ready = false;
      }
      if (p.kick && r.players[other]) {
        const g = r.players[other];
        r.kicked.add(g.tok);
        if (g.ip) r.banIps.add(g.ip);
        r.players[other] = null;
        r.inbox[other] = [];
        r.picks[other] = null;
        backToLobby(r);
        me.ready = false;
      }
      if (p.status === 'starting') {
        const g = r.players[other];
        if (g && r.song && me.ready && g.ready && me.hasSong && g.hasSong && r.status !== 'starting') {
          r.status = 'starting';
          r.startAt = Date.now() + START_DELAY_MS;
          r.startId++;
        }
      } else if (p.status === 'lobby' && r.status === 'starting') {
        backToLobby(r);
      }
    }

    if (Array.isArray(body.events) && r.players[other]) {
      for (const raw of body.events.slice(0, 64)) {
        const e = cleanEvent(raw, me);
        if (e) r.inbox[other].push(Object.assign(e, { seq: ++r.seq }));
      }
      if (r.inbox[other].length > 500) r.inbox[other].splice(0, r.inbox[other].length - 500);
    }

    const ack = Number(body.ack) || 0;
    r.inbox[pid] = r.inbox[pid].filter((e) => e.seq > ack);

    tickRoom(r);

    return reply(res, {
      ok: true,
      room: snapshot(r),
      startIn: r.status === 'starting' ? Math.max(0, r.startAt - Date.now()) : 0,
      selectIn: r.status === 'selecting' ? Math.max(0, r.selectAt - Date.now()) : 0,
      events: r.inbox[pid].slice(0, 200),
    });
  }

  if (path === '/xm') {
    const key = String(body.key || '').slice(0, 170);
    const files = [];
    for (const f of (Array.isArray(body.files) ? body.files.slice(0, 800) : [])) {
      const p = f && cleanXPath(f.p);
      if (p) files.push({ p });
    }
    r.xm[pid] = { key, files };
    return reply(res, { ok: true });
  }

  if (path === '/xmget') {
    const m = r.xm[other];
    if (!m || m.key !== String(body.key || '')) return reply(res, { ok: true, ready: false });
    return reply(res, { ok: true, ready: true, files: m.files });
  }

  if (path === '/xneed') {
    const key = String(body.key || '').slice(0, 170);
    const paths = (Array.isArray(body.paths) ? body.paths.slice(0, 800) : []).map(cleanXPath).filter(Boolean);
    r.xneed[pid] = { key, paths };
    return reply(res, { ok: true });
  }

  if (path === '/xneedget') {
    const n = r.xneed[other];
    if (!n || n.key !== String(body.key || '')) return reply(res, { ok: true, ready: false });
    return reply(res, { ok: true, ready: true, paths: n.paths });
  }

  if (path === '/xput') {
    const p = cleanXPath(body.p);
    const i = Number(body.i) | 0;
    const n = Number(body.n) | 0;
    const d = typeof body.d === 'string' ? body.d : '';
    if (!p || n < 1 || n > 400 || i < 0 || i >= n || !d.length || d.length > XFER_CHUNK_MAX) return fail(res, 'BAD TRANSFER');
    let f = r.xfiles.get(p);
    if (!f || f.n !== n) {
      if (f) r.xbytes -= f.bytes;
      f = { n, chunks: new Array(n).fill(null), got: 0, bytes: 0 };
      r.xfiles.set(p, f);
    }
    if (!f.chunks[i]) {
      if (r.xbytes + d.length > XFER_BYTES_MAX) return fail(res, 'TRANSFER TOO LARGE');
      f.chunks[i] = d;
      f.got++;
      f.bytes += d.length;
      r.xbytes += d.length;
    }
    return reply(res, { ok: true, done: f.got === f.n });
  }

  if (path === '/xget') {
    const p = cleanXPath(body.p);
    const i = Number(body.i) | 0;
    const f = p ? r.xfiles.get(p) : null;
    if (!f) return reply(res, { ok: true, ready: false });
    if (i < 0 || i >= f.n) return fail(res, 'BAD TRANSFER');
    const c = f.chunks[i];
    if (!c) return reply(res, { ok: true, ready: false, n: f.n });
    return reply(res, { ok: true, ready: true, n: f.n, d: c });
  }

  return fail(res, 'UNKNOWN ENDPOINT');
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const ip = getIp(req);
  if (overRate(ip)) {
    res.writeHead(429);
    return res.end();
  }
  if (req.method === 'GET') {
    const path = req.url.split('?')[0];
    if (path === '/list') return reply(res, { ok: true, rooms: listOpen() });
    return reply(res, { ok: true, v: VERSION, rooms: rooms.size, open: listOpen().length, online: onlineCount() });
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > (req.url.startsWith('/x') ? XFER_BODY_MAX : 65536)) req.destroy();
  });
  req.on('end', () => {
    let body = {};
    try {
      body = raw.length ? JSON.parse(raw) : {};
    } catch (e) {
      return fail(res, 'BAD JSON');
    }
    try {
      handle(req.url.split('?')[0], body, res, ip);
    } catch (e) {
      console.error(e);
      fail(res, 'SERVER ERROR');
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.last > ROOM_TTL_MS) { rooms.delete(code); continue; }
    tickRoom(r);
    const h = r.players[r.host];
    if (preMatch(r) && h && now - h.last > DEAD_LOBBY_MS) {
      const gs = otherSlot(r.host);
      if (r.players[gs] && now - r.players[gs].last < DISCONNECT_MS) promoteGuest(r, r.host);
      else rooms.delete(code);
    }
  }
  const sec = Math.floor(now / 1000) - 5;
  for (const [ip, e] of rate) if (e.sec < sec) rate.delete(ip);
}, 60 * 1000);

if (require.main === module) {
  server.listen(PORT, () => console.log('FNF multiplayer relay listening on port ' + PORT));
}
module.exports = server;
