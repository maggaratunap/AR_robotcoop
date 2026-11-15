// The renderer places the arena with three.js (position + Y rotation). This checks
// that three.js agrees with the calibration maths in calib.js, so what one player
// sees at a spot is what the other player sees at the same physical spot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Group, Vector3 } from '../public/vendor/three.core.js';
import { solveFrame, toLocal, toWorld } from '../public/js/calib.js';

function device(yaw, tx, tz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return (p) => [c * p[0] + s * p[2] + tx, p[1], -s * p[0] + c * p[2] + tz];
}

test('three.js arena transform matches calib.js for two differently-tracked devices', () => {
  const A = [-0.4, 0, -0.8], B = [0.5, 0, -0.6];
  const devs = [device(0, 0, 0), device(1.3, 1.2, 0.9), device(-2.6, -3, 4)];
  const arenas = devs.map((dev) => {
    const f = solveFrame(dev(A), dev(B));
    const g = new Group();
    g.position.set(...f.origin);
    g.rotation.set(0, f.yaw, 0);
    g.updateMatrixWorld(true);
    return { f, g, dev };
  });
  for (const P of [[0.3, 1.6, 0.2], [-1, 0, 2], [2, 0.5, -3]]) {
    const locals = arenas.map(({ f, g, dev }) => {
      const viaThree = g.worldToLocal(new Vector3(...dev(P))).toArray();
      const viaCalib = toLocal(f, dev(P));
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(viaThree[i] - viaCalib[i]) < 1e-6);
      const back = g.localToWorld(new Vector3(...viaCalib)).toArray(), w = toWorld(f, viaCalib);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - w[i]) < 1e-6);
      return viaThree;
    });
    for (const l of locals) for (let i = 0; i < 3; i++) assert.ok(Math.abs(l[i] - locals[0][i]) < 1e-6, 'all devices agree');
  }
});
