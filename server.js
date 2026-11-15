// Static file host + WebSocket room relay for 2-player co-op.
// The server is a dumb relay: the host's browser runs the game simulation,
// the server only pairs two players by room code and forwards messages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const gzCache = new Map(); // path -> {mtimeMs, buf}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(file);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
    };
    const wantsGz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const compressible = ['.js', '.css', '.html', '.json', '.svg'].includes(ext);
    if (wantsGz && compressible) {
      const hit = gzCache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs) {
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
        return res.end(hit.buf);
      }
      fs.readFile(file, (e, data) => {
        if (e) { res.writeHead(500); return res.end(); }
        const buf = zlib.gzipSync(data);
        gzCache.set(file, { mtimeMs: st.mtimeMs, buf });
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
        res.end(buf);
      });
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
});

// ---------------------------------------------------------------- rooms
const rooms = new Map(); // code -> { cfg, clients: [ws|null, ws|null] }
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

function newCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function leave(ws) {
  const code = ws.roomCode;
  if (!code) return;
  ws.roomCode = null;
  const room = rooms.get(code);
  if (!room) return;
  room.clients[ws.pid] = null;
  const other = room.clients[1 - ws.pid];
  if (ws.pid === 0) {
    // Host owns the simulation, so the room ends with the host.
    send(other, { t: 'peer', on: false, closed: true });
    if (other) other.roomCode = null;
    rooms.delete(code);
  } else {
    send(other, { t: 'peer', on: false });
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.pid = -1;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'create') {
      leave(ws);
      const code = newCode();
      if (!code) return send(ws, { t: 'err', msg: 'Server is full, try again.' });
      const cfg = (msg.cfg && typeof msg.cfg === 'object') ? msg.cfg : {};
      rooms.set(code, { cfg, clients: [ws, null] });
      ws.roomCode = code;
      ws.pid = 0;
      return send(ws, { t: 'room', code, pid: 0, cfg });
    }

    if (msg.t === 'join') {
      leave(ws);
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'err', msg: `Room ${code || '?'} not found.` });
      if (room.clients[1]) return send(ws, { t: 'err', msg: `Room ${code} already has two players.` });
      room.clients[1] = ws;
      ws.roomCode = code;
      ws.pid = 1;
      send(ws, { t: 'room', code, pid: 1, cfg: room.cfg });
      return send(room.clients[0], { t: 'peer', on: true });
    }

    if (msg.t === 'leave') return leave(ws);

    // Everything else is relayed verbatim to the other player in the room.
    const room = ws.roomCode && rooms.get(ws.roomCode);
    if (!room) return;
    const other = room.clients[1 - ws.pid];
    if (other && other.readyState === 1) other.send(raw.toString());
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// Heartbeat so dead phone connections are cleaned up and proxies keep the socket open.
const beat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);
wss.on('close', () => clearInterval(beat));

server.listen(PORT, () => {
  console.log(`AR Robot Co-op listening on http://localhost:${PORT}`);
});

export { server, wss, rooms };
