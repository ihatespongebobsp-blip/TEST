const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const START_DELAY_MS = 3000;
const ROOM_TTL_MS = 10 * 60 * 1000;
const DISCONNECT_MS = (+process.env.T_DISC) || 15 * 1000;
const LIST_STALE_MS = (+process.env.T_STALE) || 30 * 1000;
const DEAD_LOBBY_MS = 90 * 1000;
const MAX_REQ_PER_SEC_PER_IP = 120;
const VERSION = 7;
const SELECT_MS = (+process.env.T_SELECT) || 20 * 1000;      // song selection countdown (the "Song Selection: (20)" title)
const SELECT_GRACE_MS = 1500;   // late picks / random picks from the clients are still accepted this long after 0
const RND_MS = 2500;            // nobody picked: clients get this long to submit a random song
const VERIFY_MS = 4000;         // after the song is chosen, both players confirm they own the chart
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ';

const rooms = new Map();
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
  return !!p && Date.now() - p.last >= DISCONNECT_MS;
}

// statuses before a match actually starts
function preMatch(r) {
  return r.status === 'lobby' || r.status === 'selecting' || r.status === 'picked';
}

// the guest slot only counts as free if that player vanished while still in the lobby / picking a song
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

// both players are in the room: open the song selection countdown
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

// countdown ran out: pick one of the submitted songs at random
function resolveSelect(r, now) {
  const cand = ['p1', 'p2'].filter((s) => r.players[s] && r.picks[s] && r.picks[s].song);
  if (!cand.length) {
    if (!r.rnd) { r.rnd = true; r.resolveAt = now + RND_MS; return; }   // ask the clients for a random song
    beginSelect(r, now, 'NO SONG WAS PICKED - PICK ONE!');
    return;
  }
  const win = cand[crypto.randomInt(cand.length)];
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
  r.status = 'starting';
  r.startAt = now + START_DELAY_MS;
  r.startId++;
}

// advances the song selection state machine; called on every sync and by the sweeper
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
    const missing = [p1, p2].some((p) => p.conf === key && p.hasSong === false);
    if (missing) {
      if (r.alt && !r.fell) {
        // the chosen song is missing on one device: use the other player's pick instead
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
    // the match is over for both players (both are back on the lobby screen): open the next song selection
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
    connected: Date.now() - p.last < DISCONNECT_MS,
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

// only known event kinds get through, with every field clamped, so a modified client can't push junk to the other player
function cleanEvent(e, me) {
  if (!e || typeof e !== 'object') return null;
  const k = String(e.k);
  const num = (v, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) v = 0; return Math.max(lo, Math.min(hi, v)); };
  const eid = num(e.eid, 0, 1e9) | 0;
  if (k === 'hit') return { k, l: num(e.l, -1, 3) | 0, n: num(e.n, 0, 60000) | 0, eid };
  if (k === 'miss') return { k, l: num(e.l, -1, 3) | 0, eid };
  if (k === 'done') return { k, s: num(e.s, -1e9, 1e9) | 0, a: Math.round(num(e.a, 0, 100) * 100) / 100, c: num(e.c, 0, 100000) | 0, eid };
  if (k === 'quit') return { k, eid };
  return null;
}

// the host left: the guest (if any) takes over the room and keeps playing the character they already had
function promoteGuest(r, leavingSlot) {
  const gs = otherSlot(leavingSlot);
  r.players[leavingSlot] = null;
  r.inbox[leavingSlot] = [];
  r.picks[leavingSlot] = null;
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
      status: 'lobby',
      startAt: 0,
      startId: 0,
      selectAt: 0,
      resolveAt: 0,
      pickAt: 0,
      selId: 0,
      picks: { p1: null, p2: null },
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
    if (r.status !== 'lobby') backToLobby(r);   // the previous guest vanished mid-selection
    r.players[gs] = { name: cleanName(body.name), ready: false, hasSong: true, conf: '', lob: false, last: Date.now(), tok, ip };
    r.inbox[gs] = [];
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
      // the client says which song it checked; a stale answer for an older song is ignored
      if (typeof p.hasFor !== 'string' || p.hasFor === songKey(r)) {
        me.hasSong = !!p.hasSong;
        me.conf = typeof p.hasFor === 'string' ? p.hasFor : songKey(r);
      }
    }
    if ('lob' in body) me.lob = !!body.lob;   // true while this player has the multiplayer screen open
    // a song pick for the random draw (kept secret from the other player until the draw)
    if (p.pick && typeof p.pick === 'object' && (r.status === 'lobby' || r.status === 'selecting')) {
      const song = String(p.pick.song || '').slice(0, 120);
      const diff = String(p.pick.diff || '').slice(0, 40);
      if (song && diff) r.picks[pid] = { song, diff };
    }

    if (isHost) {
      if ('song' in p) r.song = String(p.song).slice(0, 120);
      if ('diff' in p) r.diff = String(p.diff).slice(0, 40);
      if ((p.side === 'bf' || p.side === 'dad') && p.side !== r.hostSide && r.status === 'lobby') {
        // host swapped characters: the guest gets the other one, everyone must ready up again
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
        // the match is over
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
    // health check: "rooms" = rooms held in memory, "open" = rooms a guest can actually see/join
    return reply(res, { ok: true, v: VERSION, rooms: rooms.size, open: listOpen().length });
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 65536) req.destroy();
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
      // dead host: hand the room to a live guest instead of throwing everyone out
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
