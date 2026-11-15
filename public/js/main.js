// Scrapyard Sentinels: app shell, WebXR session, scanning, co-op calibration
// and the game loop. See README.md for the big picture.
import * as THREE from 'three';
import { Grid } from './grid.js';
import { Sim, Mirror, moveRobot, findTarget } from './sim.js';
import { solveFrame, soloFrame, compareSpans } from './calib.js';
import { Net } from './net.js';
import { Visuals } from './visuals.js';
import { Hud3D, DomHud } from './hud.js';
import { Input } from './input.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ───────────────────────────────────────────── three.js setup
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
renderer.xr.enabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 60);
const arena = new THREE.Group(); // the shared, calibrated game frame
scene.add(arena);

const vis = new Visuals(scene, arena);
const hud3d = new Hud3D(scene);
const dom = new DomHud();
const input = new Input();
const net = new Net();

// ───────────────────────────────────────────── state
const freshPeer = (on = false) => ({ on, calib: null, okVerify: false, okScan: false, cells: null, head: null, headAt: 0 });
const S = {
  mode: 'solo',      // solo | host | guest
  pid: 0,            // 0 = host / solo, 1 = guest
  room: null,
  R: 1.8,            // arena radius (m)
  phase: 'menu',     // place | calibA | calibB | calibWait | verify | scan | play | over
  phaseAt: 0,
  arSupported: false,
  preview: false,
  headset: false,    // true when there is no DOM overlay (Quest)
  frame: null,       // { origin, yaw, d } from calib.js
  me: { calib: null, okVerify: false, okScan: false },
  peer: freshPeer(),
  verified: false,   // both players confirmed alignment
  hostGone: false,
  grid: null, sim: null, mirror: null, view: null,
  peerIn: null,
  ptr: null,
  scan: { points: 0, planes: 0, meshes: 0 },
  toast: '', toastUntil: 0,
  markA: null,
};
const coop = () => S.mode !== 'solo';
const coopLive = () => S.mode === 'host' && S.peer.on && S.verified;

// WebXR handles
let session = null, refSpace = null, viewerSpace = null, centerHit = null;
let fan = [], fanBusy = false, anchor = null, wantAnchor = false, lastSrc = null;
const planeSeen = new Map(), meshSeen = new Map(), selecting = new Set();

const headPos = new THREE.Vector3(0, 1.5, 1.5), headQuat = new THREE.Quaternion();
const headLocal = new THREE.Vector3();
const ret = { p: new THREE.Vector3(), has: false, valid: false };
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
const m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4(), q1 = new THREE.Quaternion(), e1 = new THREE.Euler();
let nowS = 0, lastT = 0, snapT = 0, sendT = 0, poseT = 0, scanT = 0, lastAct = 0, empUntil = 0;

// ───────────────────────────────────────────── tiny synth for feedback
let actx = null, lastShot = 0;
function beep(freq, dur, type = 'square', vol = 0.05, slide = 0) {
  if (!actx) return;
  const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
}
function initAudio() {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch { actx = null; }
}
function rumble(strength, ms) {
  if (!session) return;
  for (const src of session.inputSources) {
    const h = src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0];
    if (h && h.pulse) h.pulse(strength, ms).catch(() => {});
  }
}

function toast(text, secs = 4) { S.toast = text; S.toastUntil = nowS + secs; }

// ───────────────────────────────────────────── frame + phases
function applyFrame(f) {
  S.frame = f;
  arena.position.set(f.origin[0], f.origin[1], f.origin[2]);
  arena.rotation.set(0, f.yaw, 0);
  arena.updateMatrixWorld(true);
  if (anchor && anchor.delete) { try { anchor.delete(); } catch { /* already gone */ } }
  anchor = null;
  wantAnchor = !!session;
  vis.setArenaRadius(S.R);
}

function setPhase(p) {
  const prev = S.phase;
  S.phase = p;
  S.phaseAt = nowS;
  if (prev === 'scan' && p !== 'scan') stopFan();
  vis.setReticle(null);
  if (p === 'place' || p === 'calibA') { vis.hideBeacons(); vis.rim.visible = false; vis.showGrid(null, 'off'); S.markA = null; }
  if (p === 'verify' && S.frame) {
    vis.showBeacon(0, arena, -S.frame.d / 2, 0, 0);
    vis.showBeacon(1, arena, S.frame.d / 2, 0, 0);
    vis.rim.visible = true;
  }
  if (p === 'scan') {
    vis.hideBeacons();
    vis.rim.visible = true;
    vis.clearEntities();
    S.grid = new Grid(S.R);
    S.scan = { points: 0, planes: 0, meshes: 0 };
    planeSeen.clear(); meshSeen.clear();
    S.me.okScan = false;
    if (S.preview) demoObstacles(S.grid);
    startFan();
  }
  if (p === 'play') { vis.hideBeacons(); vis.rim.visible = true; }
}

function demoObstacles(g) {
  const box = (x0, x1, z0, z1, h) => {
    for (let x = x0; x <= x1; x += 0.04) for (let z = z0; z <= z1; z += 0.04) g.addPoint(x, h, z, true);
  };
  const k = S.R / 1.8;
  box(0.5 * k, 0.9 * k, -0.25 * k, 0.1 * k, 0.3);
  box(-1.05 * k, -0.75 * k, 0.4 * k, 0.9 * k, 0.5);
  box(-0.3 * k, 0.0 * k, -1.1 * k, -0.95 * k, 0.18);
  for (let x = -S.R; x <= S.R; x += 0.07) for (let z = -S.R; z <= S.R; z += 0.07) g.addPoint(x, 0, z);
  g.finalize();
}

// ───────────────────────────────────────────── actions (primary / secondary)
function primary() {
  if (nowS - lastAct < 0.3) return;
  lastAct = nowS;
  switch (S.phase) {
    case 'place': {
      if (!ret.has || !ret.valid) return toast('Aim at the floor first.', 2);
      applyFrame(soloFrame(ret.p.toArray(), headPos.toArray()));
      beep(660, 0.12, 'triangle');
      setPhase('scan');
      break;
    }
    case 'calibA': {
      if (!ret.has || !ret.valid) return toast('Aim at the floor first.', 2);
      S.markA = ret.p.toArray();
      vis.showBeacon(0, scene, ret.p.x, ret.p.y, ret.p.z);
      beep(520, 0.1, 'triangle');
      setPhaseKeepBeacons('calibB');
      break;
    }
    case 'calibB': {
      if (!ret.has || !ret.valid) return toast('Aim at the floor first.', 2);
      const f = solveFrame(S.markA, ret.p.toArray());
      if (!f.ok) { toast(f.err, 6); beep(180, 0.25, 'sawtooth'); return; }
      vis.showBeacon(1, scene, ret.p.x, ret.p.y, ret.p.z);
      applyFrame(f);
      S.me.calib = f.d;
      net.send({ t: 'calib', d: f.d });
      beep(780, 0.12, 'triangle');
      setPhaseKeepBeacons('calibWait');
      checkCalib();
      break;
    }
    case 'verify': {
      if (S.me.okVerify) return;
      S.me.okVerify = true;
      net.send({ t: 'ok', k: 'verify' });
      beep(660, 0.1, 'triangle');
      checkVerify();
      break;
    }
    case 'scan': {
      if (S.mode === 'solo') return startGame();
      if (S.me.okScan) return;
      S.grid.finalize();
      S.me.okScan = true;
      if (S.mode === 'guest') net.send({ t: 'ok', k: 'scan', cells: S.grid.serialize() });
      else { net.send({ t: 'ok', k: 'scan' }); checkScan(); }
      beep(660, 0.1, 'triangle');
      break;
    }
    case 'over': {
      if (nowS - S.phaseAt < 1.5) return;
      if (S.hostGone) return exitGame();
      if (S.mode === 'guest') return;
      restart();
      break;
    }
  }
}

function setPhaseKeepBeacons(p) { S.phase = p; S.phaseAt = nowS; vis.setReticle(null); }

function secondary() {
  if (nowS - lastAct < 0.3) return;
  lastAct = nowS;
  switch (S.phase) {
    case 'calibB': setPhase('calibA'); break;
    case 'calibWait':
    case 'verify': redoMarks(); break;
    case 'scan': {
      const noRoom = S.headset && !S.scan.planes && !S.scan.meshes && session && session.initiateRoomCapture;
      if (noRoom) { session.initiateRoomCapture().catch(() => toast('Room setup could not start.')); break; }
      S.grid.clear();
      S.scan = { points: 0, planes: 0, meshes: 0 };
      planeSeen.clear(); meshSeen.clear();
      if (S.preview) demoObstacles(S.grid);
      if (S.me.okScan) { S.me.okScan = false; net.send({ t: 'ok', k: 'scan', v: false }); }
      break;
    }
  }
}

function redoMarks() {
  S.me.calib = null; S.me.okVerify = false; S.peer.okVerify = false; S.verified = false;
  net.send({ t: 'recal' });
  setPhase('calibA');
}

// Both devices run this on the same two numbers, so they reach the same verdict.
function checkCalib() {
  if (!S.me.calib || !S.peer.calib) return;
  const c = compareSpans(S.me.calib, S.peer.calib);
  if (c.ok) {
    S.me.okVerify = false; S.peer.okVerify = false;
    beep(880, 0.15, 'triangle');
    setPhase('verify');
  } else {
    toast(`Marks do not match: you measured ${S.me.calib.toFixed(2)} m between A and B, your partner ${S.peer.calib.toFixed(2)} m. Both players mark again.`, 9);
    beep(180, 0.3, 'sawtooth');
    S.me.calib = null; S.peer.calib = null;
    setPhase('calibA');
  }
}

function checkVerify() {
  if (S.me.okVerify && S.peer.okVerify) { S.verified = true; setPhase('scan'); }
}

function checkScan() {
  if (S.mode === 'host' && S.me.okScan && S.peer.okScan) startGame();
}

function startGame() {
  const g = S.grid;
  g.finalize();
  const two = coopLive();
  if (two && S.peer.cells) g.merge(S.peer.cells);
  for (const [x, z] of (two ? [[-0.2, 0], [0.2, 0]] : [[0, 0]])) g.carve(x, z, 0.17);
  S.sim = new Sim(g, S.R, two ? 2 : 1);
  if (two) S.sim.robots[1].remote = true;
  S.mirror = null;
  S.view = S.sim;
  S.peerIn = null;
  if (two) net.send({ t: 'start', cells: g.serialize() });
  vis.clearEntities();
  setPhase('play');
  beep(440, 0.1, 'triangle'); setTimeout(() => beep(660, 0.14, 'triangle'), 110);
}

function guestStart(m) {
  S.grid = new Grid(S.R);
  S.grid.merge(m.cells || []);
  S.mirror = new Mirror(S.grid, S.R, 2, 1);
  S.sim = null;
  S.view = S.mirror;
  vis.clearEntities();
  setPhase('play');
  beep(440, 0.1, 'triangle'); setTimeout(() => beep(660, 0.14, 'triangle'), 110);
}

function restart() {
  if (S.mode === 'host' && S.peer.on && !S.verified) {
    // A partner joined mid-game: line up with them before the next round.
    S.sim = null; S.view = null; vis.clearEntities();
    setPhase(S.me.calib ? 'calibWait' : 'calibA');
    if (S.me.calib) { vis.rim.visible = true; checkCalib(); }
    return;
  }
  startGame();
}

function exitGame() {
  if (session) session.end().catch(() => {});
  else location.href = location.pathname;
}

// ───────────────────────────────────────────── networking
function peerLeft(closed) {
  if (S.mode === 'guest') {
    S.hostGone = true;
    toast(closed ? 'The host left the game.' : 'Connection to the host was lost.', 10);
    if (S.phase !== 'menu') setPhase('over');
    else if (!$('lobby').hidden) { $('lobbyHint').textContent = 'The host left this room. Go back and join again.'; $('btnEnter').disabled = true; }
    return;
  }
  S.peer = freshPeer(false);
  S.verified = false; S.me.okVerify = false;
  if (S.phase === 'play' && S.sim) { S.sim.removeRobot(1); toast('Your partner left. Continuing solo.', 6); }
  else if (S.phase === 'verify' || S.phase === 'scan') { toast('Your partner disconnected.', 6); setPhase('calibWait'); vis.rim.visible = true; }
  updateLobby();
}

function onNet(m) {
  switch (m.t) {
    case 'peer':
      if (m.on) {
        S.peer = freshPeer(true);
        S.verified = false;
        toast('Partner connected.', 3);
        if (S.me.calib) net.send({ t: 'calib', d: S.me.calib });
        if (S.phase === 'play' || S.phase === 'over') net.send({ t: 'busy' });
        updateLobby();
      } else peerLeft(m.closed);
      break;
    case 'calib':
      S.peer.calib = m.d;
      if (S.me.calib && S.phase === 'calibWait') checkCalib();
      break;
    case 'recal':
      S.peer.calib = null; S.peer.okVerify = false; S.me.okVerify = false; S.verified = false;
      if (S.phase === 'verify' || S.phase === 'scan') { toast('Your partner is marking again.', 5); setPhase('calibWait'); vis.rim.visible = true; }
      break;
    case 'ok':
      if (m.k === 'verify') { S.peer.okVerify = m.v !== false; if (S.phase === 'verify') checkVerify(); }
      else if (m.k === 'scan') {
        S.peer.okScan = m.v !== false;
        if (m.cells) S.peer.cells = m.cells;
        if (S.phase === 'scan') checkScan();
      }
      break;
    case 'pose': S.peer.head = m.h; S.peer.headAt = nowS; break;
    case 'start': if (S.mode === 'guest' && S.frame) guestStart(m); break;
    case 'in': S.peerIn = m; break;
    case 'snap': if (S.mirror) S.mirror.apply(m); break;
    case 'ev': if (S.mode === 'guest') handleEvents(m.l || []); break;
    case 'busy': toast('The host is mid-game. You will join the next round.', 10); break;
  }
}
net.onmsg = onNet;
net.onclose = () => { if (coop() && S.phase !== 'menu') { toast('Lost connection to the server.', 10); peerLeft(false); } };

function handleEvents(list) {
  vis.fx(list);
  const me = S.pid;
  for (const ev of list) {
    if (ev.t === 'shot') { if (nowS - lastShot > 0.07) { lastShot = nowS; beep(ev.id === me ? 880 : 700, 0.05, 'square', 0.025, -400); } }
    else if (ev.t === 'kill') beep(ev.type === 'tank' ? 90 : 220, ev.type === 'tank' ? 0.35 : 0.12, 'sawtooth', 0.05, -120);
    else if (ev.t === 'hurt' && ev.id === me) { beep(140, 0.12, 'sawtooth', 0.07); rumble(0.6, 60); }
    else if (ev.t === 'emp') { beep(300, 0.4, 'sine', 0.09, 900); if (ev.id === me) rumble(1, 120); }
    else if (ev.t === 'wave') { beep(392, 0.12, 'triangle', 0.06); setTimeout(() => beep(523, 0.18, 'triangle', 0.06), 130); }
    else if (ev.t === 'clear') { beep(523, 0.1, 'triangle', 0.06); setTimeout(() => beep(784, 0.2, 'triangle', 0.06), 110); }
    else if (ev.t === 'over') beep(200, 0.8, 'sawtooth', 0.07, -150);
  }
}

// ───────────────────────────────────────────── WebXR: scanning helpers
async function startFan() {
  if (!session || !viewerSpace || !session.requestHitTestSource || fan.length || fanBusy) return;
  fanBusy = true;
  const rays = [];
  for (const ay of [-13, 0, 13]) for (const ax of [-18, 0, 18]) {
    const a = (ax * Math.PI) / 180, b = (ay * Math.PI) / 180;
    rays.push(new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: Math.sin(a) * Math.cos(b), y: Math.sin(b), z: -Math.cos(a) * Math.cos(b), w: 0 }));
  }
  // Ask for feature points and meshes too, so furniture is hit and not just flat planes.
  let types;
  for (const t of [['plane', 'point', 'mesh'], ['plane', 'point'], undefined]) {
    try {
      const opts = { space: viewerSpace, offsetRay: rays[0] };
      if (t) opts.entityTypes = t;
      fan.push(await session.requestHitTestSource(opts));
      types = t;
      break;
    } catch { /* try a narrower set */ }
  }
  if (fan.length) {
    for (let i = 1; i < rays.length; i++) {
      try {
        const opts = { space: viewerSpace, offsetRay: rays[i] };
        if (types) opts.entityTypes = types;
        fan.push(await session.requestHitTestSource(opts));
      } catch { break; }
    }
  }
  fanBusy = false;
  if (S.phase !== 'scan') stopFan();
}

function stopFan() {
  for (const s of fan) { try { s.cancel(); } catch { /* session ended */ } }
  fan = [];
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function ingestScan(frame) {
  const g = S.grid;
  arena.updateMatrixWorld(true);
  m2.copy(arena.matrixWorld).invert();

  // 1. hit-test fan: where the device's view rays land on the real world
  for (const src of fan) {
    const res = frame.getHitTestResults(src);
    if (!res.length) continue;
    const pose = res[0].getPose(refSpace);
    if (!pose) continue;
    const p = pose.transform.position;
    v1.set(p.x, p.y, p.z).applyMatrix4(m2);
    g.addPoint(v1.x, v1.y, v1.z);
    S.scan.points++;
  }

  // 2. detected planes (Quest room setup: floor, walls, tables, couches...)
  const planes = frame.detectedPlanes;
  if (planes) {
    S.scan.planes = planes.size;
    for (const pl of planes) {
      if (planeSeen.get(pl) === pl.lastChangedTime) continue;
      const pose = frame.getPose(pl.planeSpace, refSpace);
      if (!pose) continue;
      planeSeen.set(pl, pl.lastChangedTime);
      m1.fromArray(pose.transform.matrix).premultiply(m2);
      const poly = pl.polygon;
      if (!poly || poly.length < 3) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const q of poly) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
      const step = Math.max(g.cs * 0.5, Math.max(x1 - x0, z1 - z0) / 160);
      for (let x = x0; x <= x1; x += step) for (let z = z0; z <= z1; z += step) {
        if (!pointInPoly(x, z, poly)) continue;
        v1.set(x, 0, z).applyMatrix4(m1);
        g.addPoint(v1.x, v1.y, v1.z, true);
      }
    }
  }

  // 3. detected meshes (Quest 3 scene mesh)
  const meshes = frame.detectedMeshes;
  if (meshes) {
    S.scan.meshes = meshes.size;
    for (const me of meshes) {
      if (meshSeen.get(me) === me.lastChangedTime) continue;
      const pose = frame.getPose(me.meshSpace, refSpace);
      if (!pose) continue;
      meshSeen.set(me, me.lastChangedTime);
      m1.fromArray(pose.transform.matrix).premultiply(m2);
      const vs = me.vertices, ix = me.indices;
      if (!vs || !ix) continue;
      const t = new Float32Array(vs.length);
      for (let i = 0; i + 2 < vs.length; i += 3) {
        v1.set(vs[i], vs[i + 1], vs[i + 2]).applyMatrix4(m1);
        t[i] = v1.x; t[i + 1] = v1.y; t[i + 2] = v1.z;
      }
      for (let i = 0; i + 2 < ix.length; i += 3) {
        const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
        g.addTriangle(t[a], t[a + 1], t[a + 2], t[b], t[b + 1], t[b + 2], t[c], t[c + 1], t[c + 2]);
      }
    }
  }
}

// ───────────────────────────────────────────── WebXR: per-frame
function pickPointer() {
  if (!S.headset || !session) return null;
  let first = null, right = null;
  for (const src of session.inputSources) {
    if (src.targetRayMode !== 'tracked-pointer') continue;
    if (src === lastSrc) return src;
    first = first || src;
    if (src.handedness === 'right') right = src;
  }
  return right || first;
}

function rayToFloor(origin, dir, floorY, out) {
  if (dir.y > -0.03) return false;
  const t = (floorY - origin.y) / dir.y;
  if (t < 0 || t > 10) return false;
  out.copy(origin).addScaledVector(dir, t);
  return true;
}

function updateReticle(frame) {
  ret.has = false; ret.valid = false;
  const src = pickPointer();
  if (src) {
    // Quest: local-floor already sits on the real floor, so aim a controller ray at y = 0.
    // Touching the controller to the floor marks the spot directly under it (most precise).
    const grip = src.gripSpace && frame.getPose(src.gripSpace, refSpace);
    const pose = frame.getPose(src.targetRaySpace, refSpace);
    if (grip && grip.transform.position.y < 0.14) {
      ret.p.set(grip.transform.position.x, 0, grip.transform.position.z);
      ret.has = ret.valid = true;
    } else if (pose) {
      const o = pose.transform.position, r = pose.transform.orientation;
      v1.set(o.x, o.y, o.z);
      v2.set(0, 0, -1).applyQuaternion(q1.set(r.x, r.y, r.z, r.w));
      if (rayToFloor(v1, v2, 0, ret.p)) ret.has = ret.valid = true;
    }
  } else if (centerHit) {
    // Phone: the centre of the screen, tested against real surfaces.
    const res = frame.getHitTestResults(centerHit);
    if (res.length) {
      const pose = res[0].getPose(refSpace);
      if (pose) {
        const p = pose.transform.position, r = pose.transform.orientation;
        ret.p.set(p.x, p.y, p.z);
        v2.set(0, 1, 0).applyQuaternion(q1.set(r.x, r.y, r.z, r.w));
        ret.has = true;
        ret.valid = v2.y > 0.85; // must be a level surface
      }
    }
  } else {
    v2.set(0, 0, -1).applyQuaternion(headQuat);
    if (rayToFloor(headPos, v2, 0, ret.p)) ret.has = ret.valid = true;
  }
  vis.setReticle(ret.has ? ret.p : null, ret.valid);
}

function xrFrame(frame) {
  refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) return;
  const vp = frame.getViewerPose(refSpace);
  if (vp) {
    const p = vp.transform.position, r = vp.transform.orientation;
    headPos.set(p.x, p.y, p.z);
    headQuat.set(r.x, r.y, r.z, r.w);
  }

  // Keep the arena glued to the real floor with an anchor where supported.
  if (wantAnchor && S.frame && frame.createAnchor) {
    wantAnchor = false;
    arena.getWorldQuaternion(q1);
    try {
      frame.createAnchor(new XRRigidTransform(
        { x: arena.position.x, y: arena.position.y, z: arena.position.z },
        { x: q1.x, y: q1.y, z: q1.z, w: q1.w }), refSpace)
        .then((a) => { anchor = a; }).catch(() => {});
    } catch { /* anchors not enabled */ }
  }
  if (anchor && S.frame && frame.trackedAnchors && frame.trackedAnchors.has(anchor)) {
    const pose = frame.getPose(anchor.anchorSpace, refSpace);
    if (pose) {
      const p = pose.transform.position, r = pose.transform.orientation;
      arena.position.set(p.x, p.y, p.z);
      e1.setFromQuaternion(q1.set(r.x, r.y, r.z, r.w), 'YXZ');
      arena.rotation.set(0, e1.y, 0); // stay level, keep heading
    }
  }
  arena.updateMatrixWorld(true);

  if (S.phase === 'place' || S.phase === 'calibA' || S.phase === 'calibB') updateReticle(frame);
  if (S.phase === 'scan' && S.grid) ingestScan(frame);

  input.pollXR(session);

  // Hands / no thumbstick: hold pinch or trigger to send the robot to that floor spot.
  S.ptr = null;
  if (S.phase === 'play' && S.headset && !input.xr.sticks) {
    for (const src of selecting) {
      const pose = frame.getPose(src.targetRaySpace, refSpace);
      if (!pose) continue;
      const o = pose.transform.position, r = pose.transform.orientation;
      v1.set(o.x, o.y, o.z);
      v2.set(0, 0, -1).applyQuaternion(q1.set(r.x, r.y, r.z, r.w));
      if (rayToFloor(v1, v2, arena.position.y, v3)) { arena.worldToLocal(v3); S.ptr = { x: v3.x, z: v3.z }; }
    }
  }
}

// ───────────────────────────────────────────── desktop preview camera
const orbit = { az: 0.5, el: 0.85, dist: 4.2, drag: false, x: 0, y: 0 };
function previewCam() {
  const d = orbit.dist * (S.R / 1.8) * Math.max(1, 1.25 / camera.aspect);
  camera.position.set(Math.sin(orbit.az) * Math.cos(orbit.el) * d, Math.sin(orbit.el) * d, Math.cos(orbit.az) * Math.cos(orbit.el) * d);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  headPos.copy(camera.position);
  headQuat.copy(camera.quaternion);
}
canvas.addEventListener('pointerdown', (ev) => { if (S.preview) { orbit.drag = true; orbit.x = ev.clientX; orbit.y = ev.clientY; } });
addEventListener('pointerup', () => { orbit.drag = false; });
addEventListener('pointermove', (ev) => {
  if (!orbit.drag) return;
  orbit.az -= (ev.clientX - orbit.x) * 0.006;
  orbit.el = Math.max(0.15, Math.min(1.5, orbit.el + (ev.clientY - orbit.y) * 0.005));
  orbit.x = ev.clientX; orbit.y = ev.clientY;
});
canvas.addEventListener('wheel', (ev) => { if (S.preview) orbit.dist = Math.max(0.8, Math.min(8, orbit.dist * (1 + Math.sign(ev.deltaY) * 0.1))); }, { passive: true });
addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ───────────────────────────────────────────── gameplay per frame
// Stick input is relative to where the player is looking, mapped onto the floor.
function moveVec(jx, jy) {
  if (!jx && !jy) return [0, 0];
  v1.set(0, 0, -1).applyQuaternion(headQuat);
  v2.set(0, 1, 0).applyQuaternion(headQuat);
  const w = Math.min(1, Math.abs(v1.y) * 1.3), sgn = v1.y < 0 ? 1 : -1;
  let fx = v1.x * (1 - w) + v2.x * w * sgn, fz = v1.z * (1 - w) + v2.z * w * sgn;
  const l = Math.hypot(fx, fz);
  if (l < 1e-3) { fx = 0; fz = -1; } else { fx /= l; fz /= l; }
  const wx = -fz * jx + fx * jy, wz = fx * jx + fz * jy; // right = (-fz, fx)
  const c = Math.cos(arena.rotation.y), s = Math.sin(arena.rotation.y);
  return [c * wx - s * wz, s * wx + c * wz];
}

function localInput(me) {
  const st = input.state();
  let [mx, mz] = moveVec(st.x, st.y);
  let fire = st.fire;
  if (S.ptr && me) {
    const dx = S.ptr.x - me.x, dz = S.ptr.z - me.z, d = Math.hypot(dx, dz);
    if (d > 0.06) { mx = dx / d; mz = dz / d; }
    fire = true;
  }
  if (st.emp) empUntil = nowS + 0.3;
  return { mx, mz, fire, emp: nowS < empUntil };
}

function updatePlay(dt) {
  if (S.sim) {
    const inputs = { 0: localInput(S.sim.robots[0]) };
    if (S.sim.robots.length > 1) inputs[1] = S.peerIn ? { x: S.peerIn.x, z: S.peerIn.z, yaw: S.peerIn.yaw, fire: !!S.peerIn.f, emp: !!S.peerIn.e } : {};
    S.sim.step(dt, inputs);
    const evs = S.sim.takeEvents();
    if (evs.length) handleEvents(evs);
    const two = S.sim.robots.length > 1 && S.peer.on;
    if (two && evs.length) net.send({ t: 'ev', l: evs });
    snapT -= dt;
    const over = S.sim.phase === 'over';
    if (two && (snapT <= 0 || over)) { snapT = 1 / 15; net.send(S.sim.snapshot()); }
    if (over) setPhase('over');
  } else if (S.mirror) {
    const mir = S.mirror, me = mir.robots[1];
    const inp = localInput(me);
    if (mir.gotSnap) {
      if (me.alive) {
        const target = inp.fire ? findTarget(me, mir.enemies, S.grid) : null;
        moveRobot(S.grid, S.R, me, inp.mx, inp.mz, dt, target);
        me.fire = inp.fire;
      }
      sendT -= dt;
      if (sendT <= 0) {
        sendT = 1 / 20;
        const q = (n) => Math.round(n * 1000) / 1000;
        net.send({ t: 'in', x: q(me.x), z: q(me.z), yaw: q(me.yaw), f: inp.fire && me.alive ? 1 : 0, e: inp.emp && me.alive ? 1 : 0 });
      }
    }
    mir.update(dt);
    if (mir.phase === 'over') setPhase('over');
  }
}

// ───────────────────────────────────────────── HUD text
function buildUI() {
  const ui = { title: '', body: '', toast: nowS < S.toastUntil ? S.toast : '', primary: '', secondary: '', hint: '', play: null, controls: false };
  const room = S.room ? `Room ${S.room}` : '';
  const hs = S.headset;
  switch (S.phase) {
    case 'place':
      ui.title = 'Find the floor';
      ui.body = hs ? `Point a controller at a clear spot on the floor. You need about ${(S.R * 2).toFixed(1)} m of open space.`
        : `Move your phone slowly until a ring appears on the floor, then aim it at a clear spot. You need about ${(S.R * 2).toFixed(1)} m of open space.`;
      ui.primary = 'Place arena';
      break;
    case 'calibA':
      ui.title = `Line up · step 1 of 2${room ? ` · ${room}` : ''}`;
      ui.body = 'Both players mark the SAME two floor spots. Put two small objects on the floor about 1 m apart.\n'
        + (hs ? 'Touch your controller to spot A (or point at it) and pull the trigger.' : 'Move your phone slowly until a ring appears on the floor, then aim it at spot A.');
      ui.primary = 'Mark A';
      break;
    case 'calibB':
      ui.title = 'Line up · step 2 of 2';
      ui.body = hs ? 'Now touch or point at spot B and pull the trigger.' : 'Now aim the ring at spot B.';
      ui.primary = 'Mark B'; ui.secondary = 'Back';
      break;
    case 'calibWait':
      ui.title = S.peer.on ? 'Waiting for partner' : `Waiting for partner · ${room}`;
      ui.body = S.peer.on ? 'Your marks are saved. Your partner needs to mark the same A and B spots, in the same order.'
        : `Your marks are saved. Ask your partner to open this page, tap Join co-op and enter ${S.room}.`;
      ui.secondary = 'Redo my marks';
      break;
    case 'verify':
      ui.title = 'Check alignment';
      ui.body = `A to B distance: you ${(S.me.calib || 0).toFixed(2)} m, partner ${(S.peer.calib || 0).toFixed(2)} m. Match.\n`
        + 'The A and B posts should stand on your two floor objects, and the floating marker should sit on your partner.'
        + (S.me.okVerify ? '\nWaiting for your partner to confirm.' : (S.peer.okVerify ? '\nYour partner has confirmed.' : ''));
      ui.primary = S.me.okVerify ? '' : 'Looks aligned';
      ui.secondary = 'Redo marks';
      break;
    case 'scan': {
      const noRoom = hs && !S.scan.planes && !S.scan.meshes && session && session.initiateRoomCapture;
      ui.title = 'Scan the room';
      ui.body = 'Sweep slowly over the floor and any furniture inside the ring. Orange blocks are obstacles.\n'
        + `Floor mapped ${S.scan.cov || 0}% · ${S.scan.blocked || 0} obstacle cells`
        + (S.scan.planes || S.scan.meshes ? ` · ${S.scan.planes + S.scan.meshes} room surfaces` : '')
        + (coop() && S.me.okScan ? '\nWaiting for your partner to finish scanning.' : '')
        + (coop() && !S.me.okScan && S.peer.okScan ? '\nYour partner is done scanning.' : '');
      ui.primary = coop() ? (S.me.okScan ? '' : 'Done scanning') : 'Start game';
      ui.secondary = noRoom ? 'Room setup' : 'Rescan';
      break;
    }
    case 'play': {
      const v = S.view, me = v.robots[S.pid] || v.robots[0];
      ui.play = { wave: v.wave, score: v.score, hp: v.robots.filter((r) => !r.gone).map((r) => Math.round(r.hp)), emp: Math.ceil(me.empCd) };
      ui.controls = true;
      if (!me.alive) { ui.title = 'Robot down'; ui.body = 'You are back in when your partner clears the wave.'; }
      else if (v.phase === 'break') { ui.title = v.wave ? `Wave ${v.wave} cleared` : 'Get ready'; ui.body = `Next wave in ${Math.ceil(v.timer)}`; }
      if (hs && v.wave <= 1) ui.hint = input.xr.sticks ? 'Stick: move · Trigger: fire · Grip: EMP' : 'Pinch and hold: move + fire';
      break;
    }
    case 'over': {
      const v = S.view;
      ui.title = S.hostGone && !v ? 'Game ended' : 'Game over';
      if (v) { ui.play = { wave: v.wave, score: v.score, hp: v.robots.filter((r) => !r.gone).map((r) => Math.round(r.hp)), emp: 0 }; ui.body = `You reached wave ${v.wave} with ${v.score} points.`; }
      if (S.hostGone) ui.primary = 'Exit';
      else if (S.mode === 'guest') ui.body += '\nWaiting for the host to start the next round.';
      else ui.primary = 'Play again';
      break;
    }
  }
  return ui;
}

// ───────────────────────────────────────────── main loop
function tick(time, frame) {
  nowS = time / 1000;
  const dt = Math.min(0.05, Math.max(0, nowS - lastT));
  lastT = nowS;

  if (frame) xrFrame(frame); else if (S.preview) previewCam();
  if (S.frame) { headLocal.copy(headPos); arena.worldToLocal(headLocal); }

  if (S.phase === 'scan' && S.grid) {
    scanT -= dt;
    if (scanT <= 0) {
      scanT = 0.25;
      // If the bulk of the scan says the floor is higher or lower than where the
      // arena was placed, move the arena onto it and rescan against the new level.
      const off = S.grid.floorOffset();
      if (Math.abs(off) > 0.015 && !S.me.okScan) {
        applyFrame({ ...S.frame, origin: [arena.position.x, arena.position.y + off, arena.position.z], yaw: arena.rotation.y });
        S.grid.clear();
        planeSeen.clear(); meshSeen.clear();
        if (S.preview) demoObstacles(S.grid);
      }
      if (S.grid.dirty) S.grid.finalize();
      S.scan.cov = Math.round(S.grid.coverage() * 100);
      S.scan.blocked = S.grid.countBlocked();
    }
    vis.showGrid(S.grid, 'scan');
  } else if ((S.phase === 'play' || S.phase === 'over') && S.grid) {
    vis.showGrid(S.grid, S.preview ? 'solid' : 'play');
  }

  if (S.phase === 'play') updatePlay(dt);
  if (S.view && (S.phase === 'play' || S.phase === 'over')) {
    if (S.phase === 'over' && S.mirror) S.mirror.update(dt);
    vis.sync(S.view, dt, nowS, S.pid, headLocal);
  }
  vis.updateFx(dt);

  // Share head position so each player can see where the other one is.
  if (coop() && S.frame && net.open) {
    poseT -= dt;
    if (poseT <= 0) {
      poseT = 0.1;
      net.send({ t: 'pose', h: [headLocal.x, headLocal.y, headLocal.z].map((n) => Math.round(n * 100) / 100) });
    }
  }
  const showPartner = coop() && S.frame && S.peer.head && nowS - S.peer.headAt < 2
    && ['verify', 'scan', 'play', 'over'].includes(S.phase)
    && (!S.preview || Math.hypot(S.peer.head[0] - headLocal.x, S.peer.head[2] - headLocal.z) > 0.3);
  vis.setPartner(showPartner ? S.peer.head : null, 1 - S.pid, nowS);

  const ui = buildUI();
  if (S.headset) { hud3d.draw(ui); hud3d.follow(headPos, headQuat, dt, S.phase === 'play'); }
  else dom.update(ui);

  renderer.render(scene, camera);
}

// ───────────────────────────────────────────── entering AR / preview
function begin() {
  document.body.classList.add('live');
  $('menu').hidden = true;
  $('overlay').hidden = S.headset;
  S.me = { calib: null, okVerify: false, okScan: false };
  S.verified = false;
  lastT = performance.now() / 1000;
  nowS = lastT;
  renderer.setAnimationLoop(tick);
  if (S.preview) {
    applyFrame({ origin: [0, 0, 0], yaw: 0, d: 1 });
    if (S.mode === 'solo') setPhase('scan');
    else {
      // No tracking in preview, so there is nothing to line up: report a fixed span.
      S.me.calib = 1;
      net.send({ t: 'calib', d: 1 });
      S.phase = 'calibWait'; S.phaseAt = nowS; vis.rim.visible = true;
      checkCalib();
    }
  } else setPhase(S.mode === 'solo' ? 'place' : 'calibA');
}

function startPreview() {
  S.preview = true; S.headset = false;
  renderer.setSize(innerWidth, innerHeight);
  scene.background = new THREE.Color(0x0e1318);
  const floor = new THREE.GridHelper(12, 60, 0x2a3540, 0x1a222a);
  floor.position.y = -0.002;
  scene.add(floor);
  begin();
}

async function enterAR() {
  initAudio();
  if (!S.arSupported || params.has('preview')) return startPreview();
  const overlay = $('overlay');
  overlay.hidden = false;
  const optional = ['hit-test', 'anchors', 'plane-detection', 'mesh-detection', 'dom-overlay', 'hand-tracking'];
  let refType = 'local-floor';
  try {
    try {
      session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['local-floor'], optionalFeatures: optional, domOverlay: { root: overlay } });
    } catch (err) {
      if (err && err.name === 'NotSupportedError') {
        refType = 'local';
        session = await navigator.xr.requestSession('immersive-ar', { optionalFeatures: optional, domOverlay: { root: overlay } });
      } else throw err;
    }
  } catch (err) {
    overlay.hidden = true;
    menuMsg(`Could not start AR: ${err && err.message ? err.message : err}`);
    return;
  }
  // Quest has no DOM overlay, so it gets the in-world HUD. `?hud=dom` forces the phone UI (for testing in an emulator).
  S.headset = params.get('hud') === 'dom' ? false : !session.domOverlayState;
  renderer.xr.setReferenceSpaceType(refType);
  await renderer.xr.setSession(session);
  try { viewerSpace = await session.requestReferenceSpace('viewer'); } catch { viewerSpace = null; }
  if (viewerSpace && session.requestHitTestSource) {
    try { centerHit = await session.requestHitTestSource({ space: viewerSpace }); } catch { centerHit = null; }
  }
  session.addEventListener('end', () => { location.href = location.pathname; });
  session.addEventListener('select', (ev) => { lastSrc = ev.inputSource; if (S.headset && S.phase !== 'play') primary(); });
  session.addEventListener('squeeze', (ev) => { lastSrc = ev.inputSource; if (S.headset && S.phase !== 'play') secondary(); });
  session.addEventListener('selectstart', (ev) => selecting.add(ev.inputSource));
  session.addEventListener('selectend', (ev) => selecting.delete(ev.inputSource));
  begin();
}

// ───────────────────────────────────────────── menu
function menuMsg(t) { $('menuMsg').textContent = t || ''; }
const size = () => parseFloat(document.querySelector('input[name=size]:checked').value) || 1.8;

function updateLobby() {
  if ($('lobby').hidden) return;
  $('lobbyRole').textContent = S.mode === 'host' ? 'Hosting room' : 'Joined room';
  $('lobbyCode').textContent = S.room;
  $('lobbyHint').textContent = S.mode === 'host'
    ? (S.peer.on ? 'Your partner is connected. Enter AR when you are both ready.' : 'Share this code. Your partner opens this page, taps Join co-op and types it in. You can enter AR now and they can join after.')
    : `Connected to the host. Arena is ${(S.R * 2).toFixed(1)} m wide. Enter AR when you are both ready.`;
  $('btnEnter').textContent = S.arSupported && !params.has('preview') ? 'Enter AR' : 'Start preview';
}

function showLobby() {
  $('home').hidden = true;
  $('lobby').hidden = false;
  updateLobby();
}

$('btnSolo').addEventListener('click', () => { S.mode = 'solo'; S.pid = 0; S.R = size(); enterAR(); });
$('btnHost').addEventListener('click', async () => {
  menuMsg('');
  try {
    await net.connect();
    const m = await net.request({ t: 'create', cfg: { R: size() } });
    S.mode = 'host'; S.pid = 0; S.room = m.code; S.R = size(); S.peer = freshPeer(false);
    showLobby();
  } catch (err) { menuMsg(err.message); }
});
$('btnJoin').addEventListener('click', async () => {
  menuMsg('');
  const code = $('codeIn').value.trim().toUpperCase();
  if (code.length !== 4) return menuMsg('Enter the 4-letter room code from the host.');
  try {
    await net.connect();
    const m = await net.request({ t: 'join', code });
    S.mode = 'guest'; S.pid = 1; S.room = m.code; S.R = (m.cfg && m.cfg.R) || 1.8; S.peer = freshPeer(true);
    showLobby();
  } catch (err) { menuMsg(err.message); }
});
$('btnEnter').addEventListener('click', enterAR);
$('btnBack').addEventListener('click', () => { net.send({ t: 'leave' }); net.close(); location.href = location.pathname; });
$('btnExit').addEventListener('click', exitGame);
input.onPrimary = primary;
input.onSecondary = secondary;

(async () => {
  if (params.get('room')) $('codeIn').value = params.get('room').slice(0, 4).toUpperCase();
  try { S.arSupported = !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); } catch { S.arSupported = false; }
  const sup = $('support');
  if (S.arSupported) sup.textContent = 'AR is available on this device.';
  else {
    sup.textContent = 'AR is not available in this browser, so the game will run as an on-screen preview (drag to look, WASD to move, Space to fire, E for EMP). For AR, open this page in Chrome on an ARCore Android phone or in the Meta Quest Browser, over HTTPS.';
    $('btnSolo').textContent = 'Play solo (preview)';
  }
})();

// Handy for debugging from the console and for automated tests.
window.__game = { S, net, vis, primary, secondary, input, orbit, ret, headLocal };
