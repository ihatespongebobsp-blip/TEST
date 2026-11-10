// FNF V-Slice Multiplayer relay server
// Usage: node server.js        (PORT env var optional, default 8080)
// No dependencies. Rooms live in memory; restarting the server closes all rooms.

const http = require('http');

const PORT = process.env.PORT || 8080;
const START_DELAY_MS = 3000;
const ROOM_TTL_MS = 10 * 60 * 1000;
const DISCONNECT_MS = 15 * 1000;
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ';

const rooms = new Map();

function makeCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function cleanName(n) {
  n = String(n || 'PLAYER').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 12);
  return n.length ? n : 'PLAYER';
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

function handle(path, body, res) {
  if (path === '/create') {
    const code = makeCode();
    if (!code) return fail(res, 'SERVER FULL');
    const r = {
      code,
      created: Date.now(),
      last: Date.now(),
      players: {
        p1: { name: cleanName(body.name), ready: false, hasSong: true, last: Date.now() },
        p2: null,
      },
      inbox: { p1: [], p2: [] },
      song: '',
      diff: '',
      status: 'lobby',
      startAt: 0,
      startId: 0,
      seq: 0,
    };
    rooms.set(code, r);
    return reply(res, { ok: true, pid: 'p1', room: snapshot(r) });
  }

  if (path === '/join') {
    const r = rooms.get(String(body.room || '').toUpperCase());
    if (!r) return fail(res, 'ROOM NOT FOUND');
    if (r.players.p2) return fail(res, 'ROOM IS FULL');
    r.players.p2 = { name: cleanName(body.name), ready: false, hasSong: true, last: Date.now() };
    r.inbox.p2 = [];
    r.last = Date.now();
    return reply(res, { ok: true, pid: 'p2', room: snapshot(r) });
  }

  const r = rooms.get(String(body.room || '').toUpperCase());
  if (!r) return fail(res, 'ROOM CLOSED');
  const pid = body.pid === 'p2' ? 'p2' : 'p1';
  const me = r.players[pid];
  if (!me) return fail(res, 'NOT IN ROOM');
  const other = pid === 'p1' ? 'p2' : 'p1';

  if (path === '/leave') {
    if (pid === 'p1') {
      rooms.delete(r.code);
    } else {
      r.players.p2 = null;
      r.players.p1.ready = false;
      r.status = 'lobby';
    }
    return reply(res, { ok: true });
  }

  if (path === '/sync') {
    me.last = Date.now();
    r.last = Date.now();
    if (body.name) me.name = cleanName(body.name);

    const p = body.patch || {};
    if ('ready' in p) me.ready = !!p.ready;
    if ('hasSong' in p) me.hasSong = !!p.hasSong;

    if (pid === 'p1') {
      if ('song' in p) r.song = String(p.song).slice(0, 120);
      if ('diff' in p) r.diff = String(p.diff).slice(0, 40);
      if (p.status === 'starting') {
        const g = r.players.p2;
        if (g && r.song && me.ready && g.ready && me.hasSong && g.hasSong && r.status !== 'starting') {
          r.status = 'starting';
          r.startAt = Date.now() + START_DELAY_MS;
          r.startId++;
        }
      } else if (p.status === 'lobby') {
        r.status = 'lobby';
      }
    }

    if (Array.isArray(body.events) && r.players[other]) {
      for (const e of body.events.slice(0, 64)) {
        if (e && typeof e === 'object') r.inbox[other].push(Object.assign({}, e, { seq: ++r.seq }));
      }
      if (r.inbox[other].length > 500) r.inbox[other].splice(0, r.inbox[other].length - 500);
    }

    const ack = Number(body.ack) || 0;
    r.inbox[pid] = r.inbox[pid].filter((e) => e.seq > ack);

    return reply(res, {
      ok: true,
      room: snapshot(r),
      startIn: r.status === 'starting' ? Math.max(0, r.startAt - Date.now()) : 0,
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
  if (req.method === 'GET') {
    return reply(res, { ok: true, rooms: rooms.size });
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
      handle(req.url.split('?')[0], body, res);
    } catch (e) {
      console.error(e);
      fail(res, 'SERVER ERROR');
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.last > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60 * 1000);

server.listen(PORT, () => console.log('FNF multiplayer relay listening on port ' + PORT));
