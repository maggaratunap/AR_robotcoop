import test from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../public/js/grid.js';
import { Sim, Mirror, ROBOT, waveQueue, mulberry32 } from '../public/js/sim.js';

function wallGrid() {
  const g = new Grid(1.8);
  // a wall across x in [-0.6, 0.6] at z = 0.5, 0.4 m tall (from "mesh" samples)
  for (let x = -0.6; x <= 0.6; x += 0.03) for (let z = 0.5; z <= 0.62; z += 0.03) g.addPoint(x, 0.4, z, true);
  for (let x = -1.5; x <= 1.5; x += 0.05) for (let z = -1.5; z <= 0.4; z += 0.05) g.addPoint(x, 0.0, z);
  g.finalize();
  return g;
}

test('scan samples build obstacles; noise is ignored', () => {
  const g = wallGrid();
  assert.equal(g.blockedAt(0, 0.55), 1);
  assert.equal(g.blockedAt(0, 0), 0);
  assert.ok(g.coverage() > 0.3);
  g.addPoint(1.0, 0.3, -1.0); // one stray feature point
  g.finalize();
  assert.equal(g.blockedAt(1.0, -1.0), 0);
  for (let i = 0; i < 4; i++) g.addPoint(1.0, 0.3, -1.0);
  for (let i = 0; i < 4; i++) g.addPoint(1.1, 0.3, -1.0);
  g.finalize();
  assert.equal(g.blockedAt(1.0, -1.0), 1);
});

test('robot cannot walk or shoot through an obstacle', () => {
  const g = wallGrid();
  const sim = new Sim(g, 1.8, 1, 1);
  sim.phase = 'wave'; sim.wave = 1; sim.queue = [];
  const e = sim.spawn('tank'); e.x = 0; e.z = 1.0; // behind the wall
  for (let i = 0; i < 120; i++) sim.step(1 / 60, { 0: { mx: 0, mz: 1, fire: true } });
  assert.ok(sim.robots[0].z < 0.5 - ROBOT.r + 0.06, `robot z ${sim.robots[0].z}`);
  assert.equal(e.hp, e.maxHp, 'no line of sight, so no damage');
});

test('enemies path around the wall and reach the robot', () => {
  const g = wallGrid();
  const sim = new Sim(g, 1.8, 1, 2);
  sim.phase = 'wave'; sim.wave = 1; sim.queue = [];
  const e = sim.spawn('runner'); e.x = 0; e.z = 1.2;
  let hurt = false;
  for (let i = 0; i < 60 * 12 && !hurt; i++) {
    sim.step(1 / 60, { 0: {} });
    assert.equal(g.blockedAt(e.x, e.z), 0, 'enemy never inside an obstacle');
    hurt = sim.takeEvents().some((ev) => ev.t === 'hurt');
  }
  assert.ok(hurt, 'runner got around the wall');
});

test('a fighting robot clears waves; an idle one eventually loses', () => {
  const g = new Grid(1.8); g.finalize();
  const sim = new Sim(g, 1.8, 1, 3);
  let t = 0;
  while (sim.wave < 3 && sim.phase !== 'over' && t < 60 * 240) {
    const a = t / 90; // circle-strafe
    sim.step(1 / 60, { 0: { mx: Math.cos(a), mz: Math.sin(a), fire: true, emp: true } });
    t++;
  }
  assert.ok(sim.wave >= 3, `reached wave ${sim.wave}`);
  assert.ok(sim.score > 0);

  const idle = new Sim(g, 1.8, 1, 4);
  for (let i = 0; i < 60 * 600 && idle.phase !== 'over'; i++) idle.step(1 / 60, { 0: {} });
  assert.equal(idle.phase, 'over');
});

test('co-op: remote robot is driven by guest input, downed robot revives on wave clear', () => {
  const g = new Grid(1.8); g.finalize();
  const sim = new Sim(g, 1.8, 2, 5);
  sim.robots[1].remote = true;
  sim.step(1 / 60, { 0: {}, 1: { x: 0.5, z: -0.3, yaw: 1, fire: false } });
  assert.equal(sim.robots[1].x, 0.5);
  sim.step(1 / 60, { 0: {}, 1: { x: 99, z: 0, yaw: 0 } });
  assert.ok(Math.hypot(sim.robots[1].x, sim.robots[1].z) <= 1.8 + 1e-6, 'clamped to arena');
  sim.damageRobot(sim.robots[1], 999);
  assert.equal(sim.robots[1].alive, false);
  assert.notEqual(sim.phase, 'over');
  sim.phase = 'wave'; sim.wave = 1; sim.queue = []; sim.enemies = [];
  sim.step(1 / 60, { 0: {}, 1: {} });
  assert.equal(sim.robots[1].alive, true);
});

test('guest mirror tracks host snapshots', () => {
  const g = new Grid(1.8); g.finalize();
  const sim = new Sim(g, 1.8, 2, 6);
  sim.robots[1].remote = true;
  const mir = new Mirror(g, 1.8, 2, 1);
  for (let i = 0; i < 60 * 8; i++) {
    sim.step(1 / 60, { 0: { fire: true }, 1: { x: 0.2, z: 0, yaw: 0, fire: true } });
    if (i % 4 === 0) mir.apply(JSON.parse(JSON.stringify(sim.snapshot())));
    mir.update(1 / 60);
  }
  assert.equal(mir.wave, sim.wave);
  assert.equal(mir.enemies.length, sim.enemies.length);
  assert.ok(sim.enemies.length > 0);
  const a = sim.enemies[0], b = mir.enemies.find((e) => e.id === a.id);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.08);
});

test('grid survives a network round trip', () => {
  const g = wallGrid();
  const g2 = new Grid(1.8);
  g2.merge(JSON.parse(JSON.stringify(g.serialize())));
  assert.equal(g2.countBlocked(), g.countBlocked());
  assert.ok(g2.countBlocked() > 10);
});

test('waves grow and co-op waves are bigger', () => {
  const r = mulberry32(1);
  assert.ok(waveQueue(5, 1, r).length > waveQueue(1, 1, r).length);
  assert.ok(waveQueue(3, 2, r).length > waveQueue(3, 1, r).length);
  assert.ok(waveQueue(4, 1, r).includes('tank'));
});

test('scan detects that the real floor is offset from where the arena was placed', () => {
  const g = new Grid(1.8);
  assert.equal(g.floorOffset(), 0, 'no evidence yet');
  for (let x = -1; x <= 1; x += 0.05) for (let z = -1; z <= 1; z += 0.05) g.addPoint(x, 0.049 + (Math.random() - 0.5) * 0.01, z);
  for (let x = 0; x <= 0.4; x += 0.05) for (let z = 0; z <= 0.4; z += 0.05) g.addPoint(x, 0.12, z, true); // a low box
  assert.ok(Math.abs(g.floorOffset() - 0.049) < 0.006, `offset ${g.floorOffset()}`);
});
