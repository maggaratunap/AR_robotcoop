// Occupancy grid of the play area, in arena-local metres (y = 0 is the floor).
// Built from AR scan samples (hit-test points, detected planes, room meshes),
// then used for collision, line of sight and enemy pathfinding.
// Pure JS: no three.js or DOM, so it also runs in Node tests.

export const FLOOR_BAND = 0.05; // |y| below this counts as floor
export const MIN_H = 0.06;      // samples above this are obstacle evidence
export const MAX_H = 1.3;       // ignore anything higher (ceilings, upper walls)
export const HITS_NEEDED = 3;   // obstacle samples needed before a cell blocks
const INF = 65535;

export class Grid {
  constructor(R, cs = 0.1) {
    this.R = R;
    this.cs = cs;
    this.half = R + 0.4;
    this.n = Math.ceil((2 * this.half) / cs);
    const N = this.n * this.n;
    this.h = new Float32Array(N);    // obstacle height (m)
    this.hits = new Uint8Array(N);   // obstacle evidence count
    this.seen = new Uint8Array(N);   // floor evidence count
    this.forced = new Uint8Array(N); // blocked by a plane/mesh/partner scan
    this.blocked = new Uint8Array(N);
    this.solid = new Uint8Array(N);  // blocked, dilated one cell (enemy clearance)
    this.dist = new Uint16Array(N).fill(INF);
    this.yHist = new Uint32Array(31); // sample heights from -15 cm to +15 cm, 1 cm bins
    this.version = 0;
    this.dirty = false;
  }

  // Where the scanned floor really is relative to y = 0 (metres). The arena is
  // placed from one or two marks; the bulk of the scan gives a better estimate.
  // Returns 0 until there is enough evidence.
  floorOffset() {
    let total = 0, best = 0, bi = 15;
    for (let i = 0; i < 31; i++) { total += this.yHist[i]; if (this.yHist[i] > best) { best = this.yHist[i]; bi = i; } }
    if (total < 150) return 0;
    // average over the peak and its neighbours for sub-centimetre precision
    let w = 0, acc = 0;
    for (let i = Math.max(0, bi - 1); i <= Math.min(30, bi + 1); i++) { w += this.yHist[i]; acc += this.yHist[i] * (i - 15) * 0.01; }
    if (w < total * 0.4) return 0;
    return acc / w;
  }

  clear() {
    this.h.fill(0); this.hits.fill(0); this.seen.fill(0); this.forced.fill(0);
    this.blocked.fill(0); this.solid.fill(0); this.dist.fill(INF); this.yHist.fill(0);
    this.version++;
    this.dirty = false;
  }

  col(x) { return Math.floor((x + this.half) / this.cs); }
  idx(x, z) {
    const i = this.col(x), j = this.col(z);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }
  cx(k) { return ((k % this.n) + 0.5) * this.cs - this.half; }
  cz(k) { return (Math.floor(k / this.n) + 0.5) * this.cs - this.half; }

  // Add one scanned sample. `strong` samples (planes, meshes) block immediately.
  addPoint(x, y, z, strong = false) {
    const k = this.idx(x, z);
    if (k < 0) return;
    if (y > MAX_H || y < -0.155) return;
    if (y < 0.155) this.yHist[Math.round(y * 100) + 15]++;
    if (y >= MIN_H) {
      if (strong) this.forced[k] = 1;
      else if (this.hits[k] < 250) this.hits[k]++;
      if (y > this.h[k]) this.h[k] = y;
      this.dirty = true;
    } else if (Math.abs(y) < FLOOR_BAND) {
      if (this.seen[k] < 250) { this.seen[k]++; this.dirty = true; }
    }
  }

  // Sample a triangle (arena-local coords) at roughly cell resolution.
  addTriangle(ax, ay, az, bx, by, bz, cx, cy, cz) {
    if (Math.max(ay, by, cy) < -0.155 || Math.min(ay, by, cy) > MAX_H) return;
    const lim = this.half + 0.2;
    if (Math.min(ax, bx, cx) > lim || Math.max(ax, bx, cx) < -lim) return;
    if (Math.min(az, bz, cz) > lim || Math.max(az, bz, cz) < -lim) return;
    const e1 = Math.hypot(bx - ax, by - ay, bz - az);
    const e2 = Math.hypot(cx - ax, cy - ay, cz - az);
    const steps = Math.min(60, Math.max(1, Math.ceil(Math.max(e1, e2) / (this.cs * 0.6))));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const u = i / steps, v = j / steps, w = 1 - u - v;
        this.addPoint(w * ax + u * bx + v * cx, w * ay + u * by + v * cy, w * az + u * bz + v * cz, true);
      }
    }
  }

  // Recompute blocked/solid from evidence. Call after scanning changes.
  finalize() {
    const n = this.n, N = n * n;
    for (let k = 0; k < N; k++) {
      const byHits = this.hits[k] >= HITS_NEEDED && this.hits[k] >= this.seen[k] * 0.25;
      this.blocked[k] = (this.forced[k] || byHits) ? 1 : 0;
    }
    // Drop isolated weak cells: single-cell noise from feature points.
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!this.blocked[k] || this.forced[k] || this.hits[k] >= 8) continue;
      let nb = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        if (this.hits[jj * n + ii] >= HITS_NEEDED || this.forced[jj * n + ii]) nb++;
      }
      if (nb === 0) this.blocked[k] = 0;
    }
    this.solid.fill(0);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      if (!this.blocked[j * n + i]) continue;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        this.solid[jj * n + ii] = 1;
      }
    }
    this.version++;
    this.dirty = false;
  }

  // Make sure a spot (e.g. robot spawn) is free.
  carve(x, z, r) {
    const steps = Math.ceil(r / this.cs);
    for (let dj = -steps; dj <= steps; dj++) for (let di = -steps; di <= steps; di++) {
      const px = x + di * this.cs, pz = z + dj * this.cs;
      if (Math.hypot(px - x, pz - z) > r) continue;
      const k = this.idx(px, pz);
      if (k >= 0) { this.hits[k] = 0; this.forced[k] = 0; this.h[k] = 0; }
    }
    this.finalize();
  }

  blockedAt(x, z) { const k = this.idx(x, z); return k < 0 ? 1 : this.blocked[k]; }
  solidAt(x, z) { const k = this.idx(x, z); return k < 0 ? 1 : this.solid[k]; }

  canStand(x, z, r) {
    if (this.blockedAt(x, z)) return false;
    const d = r * 0.7071;
    return !(this.blockedAt(x + r, z) || this.blockedAt(x - r, z) ||
      this.blockedAt(x, z + r) || this.blockedAt(x, z - r) ||
      this.blockedAt(x + d, z + d) || this.blockedAt(x - d, z + d) ||
      this.blockedAt(x + d, z - d) || this.blockedAt(x - d, z - d));
  }

  // Move a circle with sliding. Returns [x, z].
  moveCircle(x, z, r, dx, dz) {
    if (!this.canStand(x, z, r)) return [x + dx, z + dz]; // stuck inside: let it escape
    if (this.canStand(x + dx, z + dz, r)) return [x + dx, z + dz];
    if (dx && this.canStand(x + dx, z, r)) return [x + dx, z];
    if (dz && this.canStand(x, z + dz, r)) return [x, z + dz];
    return [x, z];
  }

  lineClear(x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(d / (this.cs * 0.5)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      if (this.blockedAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false;
    }
    return true;
  }

  // Dijkstra distance field from the given [x, z] sources, walking around solids.
  computeFlow(sources) {
    const n = this.n, dist = this.dist, solid = this.solid;
    dist.fill(INF);
    const heap = [];
    const push = (d, k) => {
      heap.push(d * 65536 + k);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p] <= heap[i]) break;
        const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l] < heap[m]) m = l;
          if (r < heap.length && heap[r] < heap[m]) m = r;
          if (m === i) break;
          const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
        }
      }
      return top;
    };
    for (const [sx, sz] of sources) {
      const k = this.idx(sx, sz);
      if (k >= 0 && dist[k] !== 0) { dist[k] = 0; push(0, k); }
    }
    while (heap.length) {
      const top = pop();
      const d = Math.floor(top / 65536), k = top - d * 65536;
      if (d > dist[k]) continue;
      const i = k % n, j = (k - i) / n;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const kk = jj * n + ii;
        if (solid[kk]) continue;
        if (di && dj && (solid[j * n + ii] || solid[jj * n + i])) continue; // no corner cutting
        const nd = d + (di && dj ? 14 : 10);
        if (nd < dist[kk] && nd < INF) { dist[kk] = nd; push(nd, kk); }
      }
    }
  }

  reachable(x, z) { const k = this.idx(x, z); return k >= 0 && this.dist[k] < INF; }

  // Unit direction that walks downhill on the distance field, or null.
  flowDir(x, z, out) {
    const k = this.idx(x, z);
    if (k < 0 || this.dist[k] >= INF) return null;
    const n = this.n, i = k % n, j = (k - i) / n;
    let best = this.dist[k], bi = 0, bj = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const kk = jj * n + ii;
      if (di && dj && (this.solid[j * n + ii] || this.solid[jj * n + i])) continue;
      if (this.dist[kk] < best) { best = this.dist[kk]; bi = di; bj = dj; }
    }
    if (!bi && !bj) return null;
    const tx = (i + bi + 0.5) * this.cs - this.half - x;
    const tz = (j + bj + 0.5) * this.cs - this.half - z;
    const l = Math.hypot(tx, tz) || 1;
    out[0] = tx / l; out[1] = tz / l;
    return out;
  }

  // A reachable, free point near the arena rim for enemy spawns.
  randomSpawn(rng) {
    for (let t = 0; t < 40; t++) {
      const a = rng() * Math.PI * 2;
      const r = this.R * (1 - 0.25 * (t / 40)); // drift inward if the rim is blocked
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!this.solidAt(x, z) && this.reachable(x, z)) return [x, z];
    }
    let best = -1, bd = -1;
    for (let k = 0; k < this.dist.length; k++) {
      if (this.solid[k] || this.dist[k] >= INF) continue;
      const d = Math.hypot(this.cx(k), this.cz(k));
      if (d <= this.R && d > bd) { bd = d; best = k; }
    }
    if (best >= 0) return [this.cx(best), this.cz(best)];
    const a = rng() * Math.PI * 2;
    return [Math.cos(a) * this.R, Math.sin(a) * this.R];
  }

  // Nearest non-blocked spot to (x, z) with clearance r.
  nearestFree(x, z, r) {
    if (this.canStand(x, z, r)) return [x, z];
    for (let ring = 1; ring < this.n; ring++) {
      const d = ring * this.cs;
      for (let a = 0; a < 16; a++) {
        const px = x + Math.cos(a * Math.PI / 8) * d, pz = z + Math.sin(a * Math.PI / 8) * d;
        if (Math.hypot(px, pz) < this.R && this.canStand(px, pz, r)) return [px, pz];
      }
    }
    return [x, z];
  }

  // Share of cells inside the arena circle that have been classified.
  coverage() {
    let tot = 0, got = 0;
    for (let k = 0; k < this.seen.length; k++) {
      if (Math.hypot(this.cx(k), this.cz(k)) > this.R) continue;
      tot++;
      if (this.seen[k] || this.blocked[k] || this.hits[k]) got++;
    }
    return tot ? got / tot : 0;
  }

  countBlocked() { let c = 0; for (let k = 0; k < this.blocked.length; k++) c += this.blocked[k]; return c; }

  // Flat [cellIndex, heightCm, ...] of blocked cells for the network.
  serialize() {
    const out = [];
    for (let k = 0; k < this.blocked.length; k++) {
      if (this.blocked[k]) out.push(k, Math.round(Math.max(this.h[k], MIN_H) * 100));
    }
    return out;
  }

  merge(cells) {
    if (!Array.isArray(cells)) return;
    for (let p = 0; p + 1 < cells.length; p += 2) {
      const k = cells[p] | 0;
      if (k < 0 || k >= this.forced.length) continue;
      this.forced[k] = 1;
      this.h[k] = Math.max(this.h[k], Math.min(MAX_H, (cells[p + 1] | 0) / 100));
    }
    this.finalize();
  }
}
