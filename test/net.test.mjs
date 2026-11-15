import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';

process.env.PORT = '0';
const { server, wss } = await import('../server.js');
if (!server.listening) await once(server, 'listening');
const port = server.address().port;

function client() {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const queue = [], waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  return {
    ws,
    open: () => once(ws, 'open'),
    send: (o) => ws.send(JSON.stringify(o)),
    next: () => new Promise((res, rej) => {
      if (queue.length) return res(queue.shift());
      const t = setTimeout(() => rej(new Error('timeout waiting for message')), 2000);
      waiters.push((m) => { clearTimeout(t); res(m); });
    }),
  };
}

test('room relay: create, join, relay both ways, full room, host leaving closes the room', async () => {
  const host = client(), guest = client(), third = client();
  await Promise.all([host.open(), guest.open(), third.open()]);

  host.send({ t: 'create', cfg: { R: 2.5 } });
  const room = await host.next();
  assert.equal(room.t, 'room'); assert.equal(room.pid, 0); assert.match(room.code, /^[A-Z]{4}$/);

  guest.send({ t: 'join', code: 'ZZZZ' });
  assert.equal((await guest.next()).t, 'err');

  guest.send({ t: 'join', code: room.code.toLowerCase() });
  const joined = await guest.next();
  assert.equal(joined.pid, 1); assert.equal(joined.cfg.R, 2.5);
  assert.deepEqual(await host.next(), { t: 'peer', on: true });

  third.send({ t: 'join', code: room.code });
  assert.equal((await third.next()).t, 'err');

  host.send({ t: 'calib', d: 1.02 });
  assert.deepEqual(await guest.next(), { t: 'calib', d: 1.02 });
  guest.send({ t: 'in', x: 0.1, z: 0.2 });
  assert.deepEqual(await host.next(), { t: 'in', x: 0.1, z: 0.2 });

  host.ws.close();
  assert.deepEqual(await guest.next(), { t: 'peer', on: false, closed: true });
  third.send({ t: 'join', code: room.code });
  assert.equal((await third.next()).t, 'err', 'room is gone');

  guest.ws.close(); third.ws.close();
});

test('serves the game page and health check', async () => {
  const page = await fetch(`http://localhost:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Scrapyard Sentinels/);
  assert.equal((await fetch(`http://localhost:${port}/healthz`)).status, 200);
  assert.equal((await fetch(`http://localhost:${port}/../server.js`)).status, 404);
});

test.after(() => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(); });
