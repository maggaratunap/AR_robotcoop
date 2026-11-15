// Game simulation: robots, enemies, bullets and waves, in arena-local metres.
// The host runs Sim; the guest runs Mirror (interpolates host snapshots) and
// predicts only its own robot. Pure JS so it can be tested in Node.

export const TYPES = ['drone', 'runner', 'tank', 'spitter'];

export const ENEMY = {
  drone:   { r: 0.07, speed: 0.34, hp: 20,  dmg: 8,  score: 10 },
  runner:  { r: 0.05, speed: 0.62, hp: 10,  dmg: 5,  score: 15 },
  tank:    { r: 0.12, speed: 0.20, hp: 130, dmg: 16, score: 50 },
  spitter: { r: 0.07, speed: 0.28, hp: 30,  dmg: 7,  score: 25 },
};

export const ROBOT = {
  r: 0.09, speed: 0.85, hp: 100,
  fireCd: 0.18, range: 2.0, bulletSpeed: 3.2, bulletDmg: 10,
  empCd: 12, empR: 0.75, empDmg: 60,
};

const MAX_ENEMIES = 40;

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function angLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, t);
}

export function newRobot(id, x, z) {
  return { id, x, z, yaw: 0, hp: ROBOT.hp, alive: true, fireCd: 0, empCd: 0, remote: false, fire: false };
}

// Nearest enemy in range with a clear line of sight.
export function findTarget(robot, enemies, grid) {
  let best = null, bd = ROBOT.range;
  for (const e of enemies) {
    const d = Math.hypot(e.x - robot.x, e.z - robot.z);
    if (d < bd && grid.lineClear(robot.x, robot.z, e.x, e.z)) { bd = d; best = e; }
  }
  return best;
}

// Shared by the host sim and the guest's local prediction.
export function moveRobot(grid, R, robot, mx, mz, dt, target) {
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  if (m > 0.05) {
    const [nx, nz] = grid.moveCircle(robot.x, robot.z, ROBOT.r, mx * ROBOT.speed * dt, mz * ROBOT.speed * dt);
    robot.x = nx; robot.z = nz;
    const d = Math.hypot(robot.x, robot.z);
    if (d > R) { robot.x *= R / d; robot.z *= R / d; }
  }
  if (target) robot.yaw = angLerp(robot.yaw, Math.atan2(target.x - robot.x, target.z - robot.z), dt * 14);
  else if (m > 0.05) robot.yaw = angLerp(robot.yaw, Math.atan2(mx, mz), dt * 10);
}

export function waveQueue(n, players, rng) {
  const count = Math.round((5 + 3 * n) * (players > 1 ? 1.6 : 1));
  const q = [];
  const tanks = n >= 4 ? Math.floor(n / 4) * (players > 1 ? 2 : 1) : 0;
  for (let i = 0; i < count - tanks; i++) {
    const r = rng();
    let type = 'drone';
    if (n >= 2 && r < 0.3) type = 'runner';
    else if (n >= 3 && r < 0.5) type = 'spitter';
    q.push(type);
  }
  for (let i = 0; i < tanks; i++) q.splice(Math.floor(rng() * (q.length + 1)), 0, 'tank');
  return q;
}

export class Sim {
  constructor(grid, R, players = 1, seed = (Math.random() * 1e9) | 0) {
    this.grid = grid;
    this.R = R;
    this.rng = mulberry32(seed);
    this.robots = [];
    for (let i = 0; i < players; i++) {
      const sx = players === 1 ? 0 : (i === 0 ? -0.2 : 0.2);
      const [x, z] = grid.nearestFree(sx, 0, ROBOT.r + 0.02);
      this.robots.push(newRobot(i, x, z));
    }
    this.enemies = [];
    this.bullets = [];
    this.wave = 0;
    this.phase = 'break'; // break | wave | over
    this.timer = 3;
    this.score = 0;
    this.queue = [];
    this.spawnT = 0;
    this.flowT = 0;
    this.flowVer = -1;
    this.nextId = 1;
    this.events = [];
    this._dir = [0, 0];
  }

  takeEvents() { const e = this.events; this.events = []; return e; }

  removeRobot(id) {
    const r = this.robots.find((q) => q.id === id);
    if (r) { r.alive = false; r.gone = true; r.hp = 0; }
  }

  aliveRobots() { return this.robots.filter((r) => r.alive); }

  // inputs[id]: local  { mx, mz, fire, emp }
  //             remote { x, z, yaw, fire, emp }
  step(dt, inputs) {
    if (this.phase === 'over') return;
    dt = Math.min(dt, 0.05);
    const g = this.grid;

    // ---- robots
    for (const r of this.robots) {
      r.fireCd -= dt; r.empCd = Math.max(0, r.empCd - dt);
      if (!r.alive) continue;
      const inp = inputs[r.id] || {};
      const target = inp.fire ? findTarget(r, this.enemies, g) : null;
      if (r.remote) {
        if (Number.isFinite(inp.x) && Number.isFinite(inp.z)) {
          // Trust the guest's own movement, but keep it inside the arena.
          const d = Math.hypot(inp.x, inp.z);
          const k = d > this.R ? this.R / d : 1;
          r.x = inp.x * k; r.z = inp.z * k;
          if (Number.isFinite(inp.yaw)) r.yaw = inp.yaw;
        }
      } else {
        moveRobot(g, this.R, r, inp.mx || 0, inp.mz || 0, dt, target);
      }
      r.fire = !!inp.fire;
      if (inp.fire && r.fireCd <= 0) {
        r.fireCd = ROBOT.fireCd;
        const a = target ? Math.atan2(target.x - r.x, target.z - r.z) : r.yaw;
        const sx = Math.sin(a), sz = Math.cos(a);
        this.bullets.push({
          id: this.nextId++, o: r.id, hostile: false,
          x: r.x + sx * 0.1, z: r.z + sz * 0.1,
          vx: sx * ROBOT.bulletSpeed, vz: sz * ROBOT.bulletSpeed,
          life: ROBOT.range / ROBOT.bulletSpeed, dmg: ROBOT.bulletDmg,
        });
        this.events.push({ t: 'shot', id: r.id });
      }
      if (inp.emp && r.empCd <= 0) {
        r.empCd = ROBOT.empCd;
        this.events.push({ t: 'emp', x: r.x, z: r.z, id: r.id });
        for (const e of this.enemies) {
          if (Math.hypot(e.x - r.x, e.z - r.z) < ROBOT.empR + e.r) this.damageEnemy(e, ROBOT.empDmg);
        }
        this.bullets = this.bullets.filter((b) => !b.hostile || Math.hypot(b.x - r.x, b.z - r.z) > ROBOT.empR);
      }
    }
    this.enemies = this.enemies.filter((e) => e.hp > 0);

    // ---- waves
    if (this.phase === 'break') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.wave++;
        this.queue = waveQueue(this.wave, this.robots.filter((r) => !r.gone).length, this.rng);
        this.phase = 'wave';
        this.spawnT = 0.5;
        this.events.push({ t: 'wave', n: this.wave });
      }
    } else if (this.phase === 'wave') {
      this.spawnT -= dt;
      if (this.queue.length && this.spawnT <= 0 && this.enemies.length < MAX_ENEMIES) {
        this.spawnT = Math.max(0.25, 1.1 - 0.06 * this.wave);
        this.spawn(this.queue.shift());
      }
      if (!this.queue.length && !this.enemies.length) {
        this.phase = 'break';
        this.timer = 4;
        this.score += 50 * this.wave;
        for (const r of this.robots) {
          if (r.gone) continue;
          if (!r.alive) { r.alive = true; r.hp = ROBOT.hp * 0.5; this.events.push({ t: 'revive', id: r.id }); }
          else r.hp = Math.min(ROBOT.hp, r.hp + 25);
        }
        this.events.push({ t: 'clear', n: this.wave });
      }
    }

    // ---- pathfinding field towards the robots
    const alive = this.aliveRobots();
    this.flowT -= dt;
    if (alive.length && (this.flowT <= 0 || this.flowVer !== g.version)) {
      this.flowT = 0.25;
      this.flowVer = g.version;
      g.computeFlow(alive.map((r) => [r.x, r.z]));
    }

    // ---- enemies
    for (const e of this.enemies) {
      e.cd -= dt;
      let tgt = null, td = Infinity;
      for (const r of alive) {
        const d = Math.hypot(r.x - e.x, r.z - e.z);
        if (d < td) { td = d; tgt = r; }
      }
      if (!tgt) continue;
      const spec = ENEMY[e.type];
      let dx = (tgt.x - e.x) / (td || 1), dz = (tgt.z - e.z) / (td || 1);
      const los = td < 1.2 && g.lineClear(e.x, e.z, tgt.x, tgt.z);
      let speed = spec.speed;
      if (e.type === 'spitter' && los && td < 1.1) {
        speed = td < 0.6 ? -spec.speed * 0.6 : 0; // hold range, back off if crowded
        if (e.cd <= 0) {
          e.cd = 1.8;
          this.bullets.push({
            id: this.nextId++, o: -1, hostile: true,
            x: e.x + dx * 0.08, z: e.z + dz * 0.08, vx: dx * 1.2, vz: dz * 1.2, life: 1.6, dmg: spec.dmg,
          });
        }
      } else if (!(los && td < 0.4)) {
        const f = g.flowDir(e.x, e.z, this._dir);
        if (f) { dx = f[0]; dz = f[1]; }
      }
      e.yaw = angLerp(e.yaw, Math.atan2(dx, dz), dt * 8);
      const reach = spec.r + ROBOT.r + 0.015;
      if (td > reach || speed < 0) {
        const mx = dx * speed * dt, mz = dz * speed * dt;
        if (g.solidAt(e.x, e.z) || !g.solidAt(e.x + mx, e.z + mz)) { e.x += mx; e.z += mz; }
        else if (!g.solidAt(e.x + mx, e.z)) e.x += mx;
        else if (!g.solidAt(e.x, e.z + mz)) e.z += mz;
      }
      if (td <= reach + 0.01 && e.type !== 'spitter' && e.cd <= 0) {
        e.cd = 0.7;
        this.damageRobot(tgt, spec.dmg);
      }
    }
    // soft separation so enemies don't stack
    for (let i = 0; i < this.enemies.length; i++) {
      const a = this.enemies[i];
      for (let j = i + 1; j < this.enemies.length; j++) {
        const b = this.enemies[j];
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = a.r + b.r;
        if (d < min && d > 1e-5) {
          const p = (min - d) * 0.5, ux = dx / d, uz = dz / d;
          if (!g.solidAt(a.x - ux * p, a.z - uz * p)) { a.x -= ux * p; a.z -= uz * p; }
          if (!g.solidAt(b.x + ux * p, b.z + uz * p)) { b.x += ux * p; b.z += uz * p; }
        }
      }
    }

    // ---- bullets (sub-stepped so fast shots can't tunnel through small enemies)
    for (const b of this.bullets) {
      const sp = Math.hypot(b.vx, b.vz);
      const steps = Math.max(1, Math.ceil((sp * dt) / 0.04));
      const sdt = dt / steps;
      for (let s = 0; s < steps && b.life > 0; s++) {
        b.x += b.vx * sdt; b.z += b.vz * sdt; b.life -= sdt;
        if (g.blockedAt(b.x, b.z)) { b.life = 0; this.events.push({ t: 'hit', x: b.x, z: b.z }); break; }
        if (b.hostile) {
          for (const r of alive) {
            if (r.alive && Math.hypot(r.x - b.x, r.z - b.z) < ROBOT.r + 0.02) {
              this.damageRobot(r, b.dmg); b.life = 0; break;
            }
          }
        } else {
          for (const e of this.enemies) {
            if (e.hp > 0 && Math.hypot(e.x - b.x, e.z - b.z) < e.r + 0.025) {
              this.damageEnemy(e, b.dmg, b.o);
              this.events.push({ t: 'hit', x: b.x, z: b.z });
              b.life = 0; break;
            }
          }
        }
      }
    }
    this.bullets = this.bullets.filter((b) => b.life > 0);
    this.enemies = this.enemies.filter((e) => e.hp > 0);

    if (!this.robots.some((r) => r.alive)) {
      this.phase = 'over';
      this.events.push({ t: 'over', score: this.score, wave: this.wave });
    }
  }

  spawn(type) {
    const spec = ENEMY[type];
    const [x, z] = this.grid.randomSpawn(this.rng);
    const hp = Math.round(spec.hp * (1 + 0.08 * (this.wave - 1)));
    const e = { id: this.nextId++, type, x, z, yaw: Math.atan2(-x, -z), hp, maxHp: hp, r: spec.r, cd: 0.5 };
    this.enemies.push(e);
    this.events.push({ t: 'spawn', x, z });
    return e;
  }

  damageEnemy(e, dmg) {
    if (e.hp <= 0) return;
    e.hp -= dmg;
    if (e.hp <= 0) {
      this.score += ENEMY[e.type].score;
      this.events.push({ t: 'kill', x: e.x, z: e.z, type: e.type });
    }
  }

  damageRobot(r, dmg) {
    if (!r.alive) return;
    r.hp -= dmg;
    this.events.push({ t: 'hurt', id: r.id });
    if (r.hp <= 0) { r.hp = 0; r.alive = false; this.events.push({ t: 'down', id: r.id, x: r.x, z: r.z }); }
  }

  // Compact state for the guest. Numbers are rounded to millimetres.
  snapshot() {
    const q = (v) => Math.round(v * 1000) / 1000;
    const e = [], b = [];
    for (const m of this.enemies) e.push(m.id, TYPES.indexOf(m.type), q(m.x), q(m.z), q(m.yaw), Math.ceil(m.hp), m.maxHp);
    for (const m of this.bullets) b.push(m.id, q(m.x), q(m.z), q(m.vx), q(m.vz), m.hostile ? 1 : 0);
    return {
      t: 'snap', w: this.wave, p: this.phase, tm: q(this.timer), s: this.score, q: this.queue.length,
      r: this.robots.map((r) => [q(r.x), q(r.z), q(r.yaw), Math.ceil(r.hp), r.alive ? 1 : 0, q(r.empCd), r.gone ? 1 : 0, r.fire ? 1 : 0]),
      e, b,
    };
  }
}

// Guest-side view of the host's simulation.
export class Mirror {
  constructor(grid, R, players, localId) {
    this.grid = grid;
    this.R = R;
    this.localId = localId;
    this.robots = [];
    for (let i = 0; i < players; i++) this.robots.push(newRobot(i, i === 0 ? -0.2 : 0.2, 0));
    this.enemies = [];
    this.bullets = [];
    this.wave = 0; this.phase = 'break'; this.timer = 3; this.score = 0; this.queue = [];
    this._e = new Map(); this._b = new Map();
    this.gotSnap = false;
  }

  apply(s) {
    this.wave = s.w; this.phase = s.p; this.timer = s.tm; this.score = s.s;
    this.queue.length = s.q || 0;
    s.r.forEach((a, i) => {
      const r = this.robots[i];
      if (!r) return;
      r.hp = a[3]; r.alive = !!a[4]; r.empCd = a[5]; r.gone = !!a[6];
      if (i !== this.localId || !this.gotSnap) { r.tx = a[0]; r.tz = a[1]; r.tyaw = a[2]; r.fire = !!a[7]; }
      if (!this.gotSnap) { r.x = a[0]; r.z = a[1]; r.yaw = a[2]; }
    });
    const seenE = new Set();
    for (let i = 0; i + 6 < s.e.length; i += 7) {
      const id = s.e[i];
      seenE.add(id);
      let e = this._e.get(id);
      if (!e) {
        const type = TYPES[s.e[i + 1]];
        e = { id, type, x: s.e[i + 2], z: s.e[i + 3], yaw: s.e[i + 4], r: ENEMY[type].r };
        this._e.set(id, e);
      }
      e.tx = s.e[i + 2]; e.tz = s.e[i + 3]; e.tyaw = s.e[i + 4]; e.hp = s.e[i + 5]; e.maxHp = s.e[i + 6];
    }
    for (const id of this._e.keys()) if (!seenE.has(id)) this._e.delete(id);
    const seenB = new Set();
    for (let i = 0; i + 5 < s.b.length; i += 6) {
      const id = s.b[i];
      seenB.add(id);
      let b = this._b.get(id);
      if (!b) { b = { id, x: s.b[i + 1], z: s.b[i + 2] }; this._b.set(id, b); }
      // Bullets fly straight, so extrapolate; nudge towards the host's position.
      b.x += (s.b[i + 1] - b.x) * 0.5; b.z += (s.b[i + 2] - b.z) * 0.5;
      b.vx = s.b[i + 3]; b.vz = s.b[i + 4]; b.hostile = !!s.b[i + 5];
    }
    for (const id of this._b.keys()) if (!seenB.has(id)) this._b.delete(id);
    this.enemies = [...this._e.values()];
    this.bullets = [...this._b.values()];
    this.gotSnap = true;
  }

  update(dt) {
    const k = Math.min(1, dt * 12);
    for (const e of this.enemies) {
      e.x += (e.tx - e.x) * k; e.z += (e.tz - e.z) * k; e.yaw = angLerp(e.yaw, e.tyaw, dt * 12);
    }
    for (const b of this.bullets) { b.x += b.vx * dt; b.z += b.vz * dt; }
    for (const r of this.robots) {
      if (r.id === this.localId || r.tx === undefined) continue;
      r.x += (r.tx - r.x) * k; r.z += (r.tz - r.z) * k; r.yaw = angLerp(r.yaw, r.tyaw, dt * 12);
    }
    if (this.phase === 'break') this.timer = Math.max(0, this.timer - dt);
  }
}
