// All three.js meshes: robots, enemies, bullets, effects, scan overlay,
// calibration beacons and the partner marker. Everything that belongs to the
// game world is parented to `arena`, the shared calibrated frame.
import * as THREE from 'three';
import { ROBOT } from './sim.js';

export const PCOL = [0x29d3ff, 0xff7a3d];
const AMBER = 0xffb020, RED = 0xff4d5e, GREEN = 0x4be38a;

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25, ...o });
const glow = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });
const flat = (geo) => { geo.rotateX(-Math.PI / 2); return geo; };

export function makeLabel(text, color = '#ffffff', height = 0.07) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.font = '800 84px ui-monospace, Menlo, Consolas, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = 'rgba(8,11,14,.9)';
  g.strokeText(text, 128, 68);
  g.fillStyle = color;
  g.fillText(text, 128, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set(height * 2, height, 1);
  s.renderOrder = 50;
  return s;
}

// ───────────────────────── shared geometry / materials
const G = {
  shadow: flat(new THREE.CircleGeometry(1, 20)),
  chassis: new THREE.BoxGeometry(0.13, 0.05, 0.16),
  tread: new THREE.BoxGeometry(0.035, 0.055, 0.185),
  torso: new THREE.CylinderGeometry(0.04, 0.05, 0.075, 10),
  head: new THREE.BoxGeometry(0.092, 0.055, 0.08),
  visor: new THREE.BoxGeometry(0.072, 0.02, 0.012),
  gun: new THREE.CylinderGeometry(0.012, 0.014, 0.1, 8).rotateX(Math.PI / 2),
  ant: new THREE.CylinderGeometry(0.003, 0.003, 0.05, 5),
  tip: new THREE.SphereGeometry(0.009, 8, 6),
  flash: new THREE.SphereGeometry(0.022, 8, 6),
  ringFlat: flat(new THREE.RingGeometry(0.105, 0.12, 32)),
  hp: new THREE.PlaneGeometry(1, 1),
  you: new THREE.ConeGeometry(0.018, 0.035, 4).rotateX(Math.PI),
  drone: new THREE.OctahedronGeometry(0.06, 0),
  wing: new THREE.BoxGeometry(0.17, 0.008, 0.03),
  eye: new THREE.SphereGeometry(0.016, 8, 6),
  runner: new THREE.ConeGeometry(0.04, 0.12, 5).rotateX(Math.PI / 2),
  tank: new THREE.CylinderGeometry(0.1, 0.12, 0.1, 6),
  dome: new THREE.SphereGeometry(0.07, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
  spike: new THREE.ConeGeometry(0.018, 0.05, 4),
  spit: new THREE.SphereGeometry(0.06, 12, 8),
  snout: new THREE.CylinderGeometry(0.018, 0.026, 0.07, 8).rotateX(Math.PI / 2),
  bullet: new THREE.SphereGeometry(0.014, 8, 6),
  spark: new THREE.BoxGeometry(0.014, 0.014, 0.014),
  fxRing: flat(new THREE.RingGeometry(0.9, 1, 48)),
};
const M = {
  shadow: glow(0x000000, { transparent: true, opacity: 0.32, depthWrite: false }),
  dark: std(0x2b323a, { metalness: 0.5 }),
  tread: std(0x14181c, { roughness: 0.9, metalness: 0 }),
  light: std(0xdfe6ea),
  hurt: glow(RED),
  flash: glow(0xfff2b0),
  hpBg: glow(0x0b0e11, { transparent: true, opacity: 0.75, depthTest: false }),
  drone: std(0xd8323f, { flatShading: true, emissive: 0x4a0a10 }),
  runner: std(0xa64dff, { flatShading: true, emissive: 0x2a0a55 }),
  tank: std(0x7a1320, { flatShading: true, emissive: 0x25060a, metalness: 0.5 }),
  spit: std(0x4bd16a, { flatShading: true, emissive: 0x0c3a17 }),
  eye: glow(0xffe36a),
  bulletHostile: glow(0xff3344),
  spark: [glow(AMBER), glow(RED), glow(0x29d3ff), glow(0xffffff), glow(GREEN), glow(0xff7a3d)],
};
const SPARK = { amber: 0, red: 1, cyan: 2, white: 3, green: 4, orange: 5 };

function shadow(r) {
  const s = new THREE.Mesh(G.shadow, M.shadow);
  s.scale.set(r, 1, r); s.position.y = 0.002; s.renderOrder = 1;
  return s;
}

function buildRobot(id, isLocal) {
  const color = PCOL[id % 2];
  const pm = std(color, { emissive: color, emissiveIntensity: 0.25 });
  const pg = glow(color);
  const root = new THREE.Group();
  const spin = new THREE.Group();
  root.add(spin);
  const body = new THREE.Group();
  spin.add(body);
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); body.add(m); return m; };
  add(G.chassis, M.dark, 0, 0.045, 0);
  add(G.tread, M.tread, -0.082, 0.03, 0);
  add(G.tread, M.tread, 0.082, 0.03, 0);
  add(G.torso, pm, 0, 0.107, 0);
  const head = add(G.head, M.light, 0, 0.172, 0.005);
  add(G.visor, pg, 0, 0.176, 0.043);
  add(G.gun, M.dark, 0.062, 0.112, 0.045);
  add(G.ant, M.dark, -0.03, 0.225, -0.015);
  add(G.tip, pg, -0.03, 0.252, -0.015);
  const flash = add(G.flash, M.flash, 0.062, 0.112, 0.105);
  flash.visible = false;
  root.add(shadow(0.12));
  const ring = new THREE.Mesh(G.ringFlat, glow(color, { transparent: true, opacity: isLocal ? 0.95 : 0.55, depthWrite: false }));
  ring.position.y = 0.004;
  root.add(ring);
  // health bar, turned to face the viewer every frame
  const hp = new THREE.Group();
  hp.position.y = 0.3;
  const bg = new THREE.Mesh(G.hp, M.hpBg); bg.scale.set(0.15, 0.02, 1); bg.renderOrder = 40;
  const fill = new THREE.Mesh(G.hp, glow(color, { depthTest: false })); fill.scale.set(0.144, 0.014, 1); fill.position.z = 0.001; fill.renderOrder = 41;
  hp.add(bg, fill);
  root.add(hp);
  if (isLocal) {
    const you = new THREE.Mesh(G.you, pg);
    you.position.y = 0.345;
    root.add(you);
    root.userData.you = you;
  }
  Object.assign(root.userData, { spin, body, head, flash, hp, fill, flashT: 0, hurtT: 0, torsoMat: pm, color });
  return root;
}

function buildEnemy(type) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); body.add(m); return m; };
  let r = 0.08;
  if (type === 'drone') {
    add(G.drone, M.drone, 0, 0, 0); add(G.wing, M.dark, 0, 0.01, -0.01); add(G.eye, M.eye, 0, 0.005, 0.05);
    body.position.y = 0.1;
  } else if (type === 'runner') {
    add(G.runner, M.runner, 0, 0, 0); add(G.eye, M.eye, 0, 0.012, 0.03).scale.setScalar(0.7);
    body.position.y = 0.045; r = 0.06;
  } else if (type === 'tank') {
    add(G.tank, M.tank, 0, 0, 0); add(G.dome, M.dark, 0, 0.05, 0); add(G.eye, M.eye, 0, 0.07, 0.06).scale.setScalar(1.3);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const s = add(G.spike, M.dark, Math.sin(a) * 0.115, 0.0, Math.cos(a) * 0.115);
      s.rotation.set(Math.cos(a) * 1.57, 0, -Math.sin(a) * 1.57);
    }
    body.position.y = 0.055; r = 0.15;
  } else {
    add(G.spit, M.spit, 0, 0, 0); add(G.snout, M.dark, 0, 0.01, 0.07); add(G.eye, M.eye, 0, 0.045, 0.035).scale.setScalar(0.8);
    body.position.y = 0.075;
  }
  root.add(shadow(r));
  root.userData = { body, baseY: body.position.y, type, born: 0 };
  return root;
}

export class Visuals {
  constructor(scene, arena) {
    this.scene = scene;
    this.arena = arena;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(0.6, 3, 1.2);
    scene.add(sun);

    this.robots = new Map();
    this.enemies = new Map();
    this.bullets = new Map();
    this.bulletMats = PCOL.map((c) => glow(c));

    // arena rim
    this.rim = new THREE.Mesh(flat(new THREE.RingGeometry(0.985, 1, 96)), glow(0x29d3ff, { transparent: true, opacity: 0.6, depthWrite: false }));
    this.rim.position.y = 0.003;
    this.rim.visible = false;
    arena.add(this.rim);

    // reticle (world space: used before the arena frame exists)
    this.reticle = new THREE.Group();
    this.reticleMat = glow(GREEN, { transparent: true, opacity: 0.95, depthTest: false });
    const rr = new THREE.Mesh(flat(new THREE.RingGeometry(0.06, 0.075, 32)), this.reticleMat);
    const rd = new THREE.Mesh(flat(new THREE.CircleGeometry(0.012, 12)), this.reticleMat);
    rr.renderOrder = rd.renderOrder = 60;
    this.reticle.add(rr, rd);
    this.reticle.visible = false;
    scene.add(this.reticle);

    // calibration beacons A / B
    this.beacons = [this._beacon('A', GREEN, '#4be38a'), this._beacon('B', 0x8f7bff, '#b3a5ff')];
    for (const b of this.beacons) { b.visible = false; scene.add(b); }

    // partner marker
    this.partner = new THREE.Group();
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.07, 0), new THREE.MeshBasicMaterial({ color: PCOL[1], wireframe: true }));
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.025, 0), glow(0xffffff));
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 1, 5), glow(PCOL[1], { transparent: true, opacity: 0.5 }));
    const foot = new THREE.Mesh(flat(new THREE.RingGeometry(0.16, 0.18, 32)), glow(PCOL[1], { transparent: true, opacity: 0.7, depthWrite: false }));
    this.partner.add(gem, core, pole, foot);
    this.partner.userData = { gem, core, pole, foot, label: null };
    this.partner.visible = false;
    arena.add(this.partner);

    // pooled effects
    this.sparks = [];
    for (let i = 0; i < 160; i++) {
      const m = new THREE.Mesh(G.spark, M.spark[0]);
      m.visible = false; arena.add(m);
      this.sparks.push({ m, vx: 0, vy: 0, vz: 0, life: 0, max: 1 });
    }
    this.sparkI = 0;
    this.rings = [];
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(G.fxRing, glow(0xffffff, { transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false; m.position.y = 0.006; arena.add(m);
      this.rings.push({ m, r0: 0, r1: 1, life: 0, max: 1 });
    }
    this.ringI = 0;

    this.gridVis = null;
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  _beacon(text, color, css) {
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 8), glow(color));
    post.position.y = 0.15;
    const base = new THREE.Mesh(flat(new THREE.RingGeometry(0.05, 0.065, 32)), glow(color, { transparent: true, opacity: 0.9, depthWrite: false }));
    base.position.y = 0.003;
    const dot = new THREE.Mesh(flat(new THREE.CircleGeometry(0.01, 10)), glow(0xffffff));
    dot.position.y = 0.004;
    const lab = makeLabel(text, css, 0.09);
    lab.position.y = 0.38;
    g.add(post, base, dot, lab);
    return g;
  }

  setArenaRadius(R) { this.rim.scale.set(R, 1, R); }

  // Place a beacon. `parent` is the scene (raw device coords, while marking)
  // or the arena (shared coords, once calibrated).
  showBeacon(i, parent, x, y, z) {
    const b = this.beacons[i];
    if (b.parent !== parent) parent.add(b);
    b.position.set(x, y, z);
    b.visible = true;
  }
  hideBeacons() { for (const b of this.beacons) b.visible = false; }

  setReticle(p, valid) {
    this.reticle.visible = !!p;
    if (p) { this.reticle.position.copy(p); this.reticleMat.color.set(valid ? GREEN : RED); }
  }

  setPartner(head, pid, time) {
    const g = this.partner, u = g.userData;
    g.visible = !!head;
    if (!head) return;
    const color = PCOL[pid % 2];
    if (u.pid !== pid) {
      u.pid = pid;
      u.gem.material.color.set(color); u.pole.material.color.set(color); u.foot.material.color.set(color);
      if (u.label) g.remove(u.label);
      u.label = makeLabel(`P${pid + 1}`, pid ? '#ff7a3d' : '#29d3ff', 0.08);
      g.add(u.label);
    }
    g.position.set(head[0], 0, head[2]);
    const h = Math.max(0.2, head[1]);
    u.gem.position.y = h; u.core.position.y = h;
    u.gem.rotation.y = time * 1.5;
    u.pole.scale.y = h; u.pole.position.y = h / 2;
    u.foot.position.y = 0.004;
    u.label.position.y = h + 0.16;
  }

  // ─────────────────────── per-frame sync with the game view
  sync(view, dt, time, localId, cam) {
    const seenE = new Set(), seenB = new Set();
    for (const r of view.robots) {
      let m = this.robots.get(r.id);
      if (!m) { m = buildRobot(r.id, r.id === localId); this.robots.set(r.id, m); this.arena.add(m); }
      const u = m.userData;
      m.visible = !r.gone;
      m.position.set(r.x, 0, r.z);
      u.spin.rotation.y = r.yaw;
      u.body.rotation.x += ((r.alive ? 0 : -1.35) - u.body.rotation.x) * Math.min(1, dt * 8);
      u.body.position.y = r.alive ? Math.abs(Math.sin(time * 9 + r.id)) * 0.004 : 0.02;
      u.head.rotation.y = r.alive ? Math.sin(time * 1.3 + r.id * 2) * 0.25 : 0;
      u.flashT -= dt; u.flash.visible = u.flashT > 0;
      u.hurtT -= dt;
      u.torsoMat.emissive.set(u.hurtT > 0 ? RED : u.color);
      u.torsoMat.emissiveIntensity = u.hurtT > 0 ? 1 : (r.alive ? 0.25 : 0.02);
      const k = Math.max(0, Math.min(1, r.hp / ROBOT.hp));
      u.fill.scale.x = 0.144 * k;
      u.fill.position.x = -0.072 * (1 - k);
      u.fill.visible = k > 0;
      if (cam) u.hp.rotation.y = Math.atan2(cam.x - r.x, cam.z - r.z);
      if (u.you) u.you.position.y = 0.345 + Math.sin(time * 4) * 0.008;
    }
    for (const e of view.enemies) {
      seenE.add(e.id);
      let m = this.enemies.get(e.id);
      if (!m) { m = buildEnemy(e.type); m.userData.born = time; this.enemies.set(e.id, m); this.arena.add(m); }
      const u = m.userData;
      m.position.set(e.x, 0, e.z);
      m.rotation.y = e.yaw;
      const grow = Math.min(1, (time - u.born) * 4);
      u.body.scale.setScalar(0.2 + 0.8 * grow);
      if (u.type === 'drone') { u.body.position.y = u.baseY + Math.sin(time * 5 + e.id) * 0.012; u.body.rotation.z = Math.sin(time * 3 + e.id) * 0.2; }
      else if (u.type === 'runner') u.body.rotation.z = time * 9 + e.id;
      else if (u.type === 'spitter') u.body.scale.y = (0.2 + 0.8 * grow) * (1 + Math.sin(time * 6 + e.id) * 0.06);
    }
    for (const [id, m] of this.enemies) if (!seenE.has(id)) { this.arena.remove(m); this.enemies.delete(id); }

    for (const b of view.bullets) {
      seenB.add(b.id);
      let m = this.bullets.get(b.id);
      if (!m) {
        m = new THREE.Mesh(G.bullet, b.hostile ? M.bulletHostile : this.bulletMats[(b.o ?? 0) % 2] || this.bulletMats[0]);
        if (b.hostile) m.scale.setScalar(1.4);
        this.bullets.set(b.id, m); this.arena.add(m);
      }
      m.position.set(b.x, b.hostile ? 0.08 : 0.112, b.z);
    }
    for (const [id, m] of this.bullets) if (!seenB.has(id)) { this.arena.remove(m); this.bullets.delete(id); }
  }

  clearEntities() {
    for (const map of [this.robots, this.enemies, this.bullets]) {
      for (const m of map.values()) this.arena.remove(m);
      map.clear();
    }
  }

  // ─────────────────────── effects
  burst(x, y, z, color, n, speed = 0.6) {
    for (let i = 0; i < n; i++) {
      const s = this.sparks[this.sparkI = (this.sparkI + 1) % this.sparks.length];
      const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
      s.m.material = M.spark[SPARK[color] ?? 0];
      s.m.position.set(x, y, z);
      s.vx = Math.cos(a) * v; s.vz = Math.sin(a) * v; s.vy = 0.4 + Math.random() * 0.9;
      s.life = s.max = 0.35 + Math.random() * 0.35;
      s.m.visible = true;
    }
  }

  ring(x, z, color, r0, r1, dur) {
    const r = this.rings[this.ringI = (this.ringI + 1) % this.rings.length];
    r.m.material.color.set(color);
    r.m.position.set(x, 0.006, z);
    r.r0 = r0; r.r1 = r1; r.life = r.max = dur;
    r.m.visible = true;
  }

  fx(events) {
    for (const ev of events) {
      if (ev.t === 'shot') { const m = this.robots.get(ev.id); if (m) m.userData.flashT = 0.05; }
      else if (ev.t === 'hit') this.burst(ev.x, 0.1, ev.z, 'amber', 3, 0.35);
      else if (ev.t === 'kill') {
        this.burst(ev.x, 0.08, ev.z, ev.type === 'spitter' ? 'green' : 'red', ev.type === 'tank' ? 30 : 12, ev.type === 'tank' ? 1 : 0.6);
        this.ring(ev.x, ev.z, RED, 0.03, ev.type === 'tank' ? 0.4 : 0.2, 0.3);
      }
      else if (ev.t === 'spawn') this.ring(ev.x, ev.z, RED, 0.25, 0.04, 0.45);
      else if (ev.t === 'emp') { this.ring(ev.x, ev.z, PCOL[ev.id % 2], 0.08, ROBOT.empR, 0.4); this.ring(ev.x, ev.z, 0xffffff, 0.05, ROBOT.empR * 0.8, 0.3); this.burst(ev.x, 0.12, ev.z, 'white', 16, 1.2); }
      else if (ev.t === 'hurt') { const m = this.robots.get(ev.id); if (m) m.userData.hurtT = 0.18; }
      else if (ev.t === 'down') { this.burst(ev.x, 0.12, ev.z, ev.id ? 'orange' : 'cyan', 24, 0.9); this.ring(ev.x, ev.z, RED, 0.05, 0.5, 0.5); }
      else if (ev.t === 'revive') { const m = this.robots.get(ev.id); if (m) this.ring(m.position.x, m.position.z, GREEN, 0.4, 0.08, 0.6); }
    }
  }

  updateFx(dt) {
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.m.visible = false; continue; }
      s.vy -= 3.2 * dt;
      const p = s.m.position;
      p.x += s.vx * dt; p.y += s.vy * dt; p.z += s.vz * dt;
      if (p.y < 0.008) { p.y = 0.008; s.vy *= -0.4; s.vx *= 0.6; s.vz *= 0.6; }
      s.m.scale.setScalar(Math.max(0.05, s.life / s.max));
    }
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.m.visible = false; continue; }
      const t = 1 - r.life / r.max;
      const rad = r.r0 + (r.r1 - r.r0) * (1 - (1 - t) * (1 - t));
      r.m.scale.set(rad, 1, rad);
      r.m.material.opacity = 0.9 * (1 - t);
    }
  }

  // ─────────────────────── scan overlay / occluders
  // mode: 'scan' (show what was found), 'play' (invisible occluders so robots
  // hide behind real furniture), 'solid' (non-AR preview), 'off'
  showGrid(grid, mode) {
    if (!grid || mode === 'off') { if (this.gridVis) this.gridVis.group.visible = false; return; }
    let gv = this.gridVis;
    if (!gv || gv.cap !== grid.blocked.length) {
      if (gv) this.arena.remove(gv.group);
      const cap = grid.blocked.length, cs = grid.cs;
      gv = this.gridVis = {
        cap, group: new THREE.Group(), ver: -1, mode: '',
        box: new THREE.InstancedMesh(new THREE.BoxGeometry(cs, 1, cs), glow(0xff8a2a), cap),
        top: new THREE.InstancedMesh(flat(new THREE.PlaneGeometry(cs * 0.92, cs * 0.92)), glow(0xff8a2a, { transparent: true, opacity: 0.28, depthWrite: false }), cap),
        floor: new THREE.InstancedMesh(flat(new THREE.PlaneGeometry(cs * 0.8, cs * 0.8)), glow(0x29d3ff, { transparent: true, opacity: 0.22, depthWrite: false }), cap),
        mats: {
          scan: glow(0xff8a2a, { transparent: true, opacity: 0.4, depthWrite: false }),
          play: new THREE.MeshBasicMaterial({ colorWrite: false }),
          solid: std(0x59636d, { roughness: 0.9, metalness: 0 }),
        },
      };
      for (const im of [gv.box, gv.top, gv.floor]) { im.frustumCulled = false; im.count = 0; gv.group.add(im); }
      gv.box.renderOrder = -10;
      this.arena.add(gv.group);
    }
    gv.group.visible = true;
    if (gv.mode !== mode) {
      gv.mode = mode;
      gv.box.material = gv.mats[mode];
      gv.floor.visible = mode === 'scan';
      gv.top.visible = mode === 'play';
      gv.ver = -1;
    }
    if (gv.ver === grid.version) return;
    gv.ver = grid.version;
    const shrink = mode === 'scan' ? 0.92 : 1.0;
    let nb = 0, nf = 0;
    for (let k = 0; k < grid.blocked.length; k++) {
      const x = grid.cx(k), z = grid.cz(k);
      if (grid.blocked[k]) {
        // While scanning, draw tall obstacles (walls, shelves) as low blocks so they don't hide the room.
        const h = Math.min(Math.max(grid.h[k], 0.06), mode === 'scan' ? 0.3 : 10);
        this._m4.compose(this._p.set(x, h / 2, z), this._q, this._s.set(shrink, h, shrink));
        gv.box.setMatrixAt(nb, this._m4);
        this._m4.compose(this._p.set(x, h + 0.003, z), this._q, this._s.set(1, 1, 1));
        gv.top.setMatrixAt(nb, this._m4);
        nb++;
      } else if (grid.seen[k] && mode === 'scan') {
        this._m4.compose(this._p.set(x, 0.004, z), this._q, this._s.set(1, 1, 1));
        gv.floor.setMatrixAt(nf++, this._m4);
      }
    }
    gv.box.count = nb; gv.top.count = nb; gv.floor.count = nf;
    gv.box.instanceMatrix.needsUpdate = true;
    gv.top.instanceMatrix.needsUpdate = true;
    gv.floor.instanceMatrix.needsUpdate = true;
  }
}
