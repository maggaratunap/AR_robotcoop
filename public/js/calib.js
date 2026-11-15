// Shared-space calibration maths.
//
// Each device tracks the room in its own private coordinate system. To agree on
// one shared "arena" frame, both players mark the same two physical floor points
// (A, then B). Because every WebXR device already agrees on which way is up, two
// floor points are enough to pin down the remaining unknowns (position + heading).
//
// Arena frame: origin at the midpoint of A-B on the floor, +X pointing from A to B,
// +Y up. Pure JS so it can be unit-tested in Node.

export const MIN_SPAN = 0.4;   // A and B must be at least this far apart (m)
export const MAX_SPAN = 6.0;
export const MAX_HEIGHT_DIFF = 0.1; // both marks must be on the same floor

// A, B: [x, y, z] in the device's reference space.
export function solveFrame(A, B) {
  const dx = B[0] - A[0], dz = B[2] - A[2];
  const d = Math.hypot(dx, dz);
  if (d < MIN_SPAN) return { ok: false, err: `Points are only ${(d * 100).toFixed(0)} cm apart. Pick marks at least ${MIN_SPAN * 100} cm apart.` };
  if (d > MAX_SPAN) return { ok: false, err: 'Points are too far apart. Keep them within 6 m.' };
  if (Math.abs(A[1] - B[1]) > MAX_HEIGHT_DIFF) return { ok: false, err: 'The two points are at different heights. Mark both on the floor.' };
  return {
    ok: true,
    d,
    origin: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2],
    // three.js Y-rotation that turns local +X onto the A->B direction
    yaw: Math.atan2(-dz, dx),
  };
}

// Single-point frame for solo play: origin at P, +Z towards the viewer.
export function soloFrame(P, viewer) {
  const dx = viewer[0] - P[0], dz = viewer[2] - P[2];
  return { ok: true, d: 0, origin: [P[0], P[1], P[2]], yaw: Math.atan2(dx, dz) };
}

export function toLocal(f, p) {
  const x = p[0] - f.origin[0], y = p[1] - f.origin[1], z = p[2] - f.origin[2];
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  // inverse of R_y(yaw): [x', z'] = [c*x - s*z, s*x + c*z]
  return [c * x - s * z, y, s * x + c * z];
}

export function toWorld(f, p) {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  return [c * p[0] + s * p[2] + f.origin[0], p[1] + f.origin[1], -s * p[0] + c * p[2] + f.origin[2]];
}

// Both devices measured the A-B distance independently. If they disagree, at
// least one player marked the wrong spot (or tracking is off), so reject.
export function spanTolerance(d) { return Math.max(0.06, d * 0.06); }

export function compareSpans(d1, d2) {
  const diff = Math.abs(d1 - d2);
  const tol = spanTolerance(Math.max(d1, d2));
  return { ok: diff <= tol, diff, tol };
}
