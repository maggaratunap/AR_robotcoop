import test from 'node:test';
import assert from 'node:assert/strict';
import { solveFrame, toLocal, toWorld, compareSpans, soloFrame } from '../public/js/calib.js';

// A "device" sees the physical world through its own random yaw + offset.
function device(yaw, tx, ty, tz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return (p) => [c * p[0] + s * p[2] + tx, p[1] + ty, -s * p[0] + c * p[2] + tz];
}

test('two devices marking the same two floor points agree on every other point', () => {
  const A = [0.3, 0, -1.2], B = [1.4, 0, -0.5]; // physical marks
  const dev1 = device(0.7, 2, 0, -3), dev2 = device(-2.1, -5, 0.02, 1.5);
  const f1 = solveFrame(dev1(A), dev1(B)), f2 = solveFrame(dev2(A), dev2(B));
  assert.ok(f1.ok && f2.ok);
  assert.ok(compareSpans(f1.d, f2.d).ok);
  for (const P of [[0, 0, 0], [2, 1.5, -2], [-1, 0.2, 3], A, B]) {
    const l1 = toLocal(f1, dev1(P)), l2 = toLocal(f2, dev2(P));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(l1[i] - l2[i]) < 0.03, `axis ${i}: ${l1[i]} vs ${l2[i]}`);
  }
  // A and B land on the local X axis, symmetric about the origin
  const la = toLocal(f1, dev1(A)), lb = toLocal(f1, dev1(B));
  assert.ok(Math.abs(la[2]) < 1e-9 && Math.abs(lb[2]) < 1e-9);
  assert.ok(la[0] < 0 && Math.abs(la[0] + lb[0]) < 1e-9);
});

test('toWorld inverts toLocal', () => {
  const f = solveFrame([1, 0, 2], [3, 0.01, -1]);
  const p = [0.4, 0.9, -2.2];
  const back = toWorld(f, toLocal(f, p));
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - p[i]) < 1e-9);
});

test('rejects bad marks and mismatched spans', () => {
  assert.equal(solveFrame([0, 0, 0], [0.1, 0, 0]).ok, false);
  assert.equal(solveFrame([0, 0, 0], [1, 0.4, 0]).ok, false);
  assert.equal(compareSpans(1.0, 1.03).ok, true);
  assert.equal(compareSpans(1.0, 1.25).ok, false);
});

test('solo frame faces the viewer', () => {
  const f = soloFrame([0, 0, -2], [0, 1.6, 0]);
  const v = toLocal(f, [0, 0, 0]);
  assert.ok(v[2] > 1.9 && Math.abs(v[0]) < 1e-9);
});
