// Pure math helpers. No browser, no Three.js — this file must run under Node.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// Move `v` toward `target` by at most `step`.
export function approach(v, target, step) {
  if (v < target) return Math.min(v + step, target);
  return Math.max(v - step, target);
}

export const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const copy = (a) => ({ x: a.x, y: a.y, z: a.z });

export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function length(a) {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}
export function dist(a, b) {
  return length(sub(a, b));
}
export function normalize(a) {
  const l = length(a);
  return l > 1e-9 ? scale(a, 1 / l) : vec();
}

// Horizontal (XZ) distance — used for hearing and movement, where height is irrelevant.
export function distXZ(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Yaw/pitch (radians) to a unit direction. Yaw 0 looks down -Z, matching Three.js.
export function dirFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

// Deterministic PRNG (mulberry32). The simulation must never touch Math.random(),
// otherwise host and clients would disagree.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box helpers. Boxes are axis-aligned: {min:{x,y,z}, max:{x,y,z}}.
export function boxFromCenterSize(cx, cy, cz, sx, sy, sz) {
  return {
    min: { x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 },
    max: { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 },
  };
}

export function boxOverlaps(a, b) {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

// Slab method. Returns {hit, tNear, normal} for a ray against an AABB.
export function rayBox(origin, dir, box) {
  let tNear = -Infinity;
  let tFar = Infinity;
  let axis = -1;
  let sign = 1;

  for (const k of ['x', 'y', 'z']) {
    const d = dir[k];
    const o = origin[k];
    if (Math.abs(d) < 1e-9) {
      // Ray is parallel to this slab; miss if origin is outside it.
      if (o < box.min[k] || o > box.max[k]) return { hit: false };
      continue;
    }
    const inv = 1 / d;
    let t1 = (box.min[k] - o) * inv;
    let t2 = (box.max[k] - o) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tNear) {
      tNear = t1;
      axis = k;
      sign = s;
    }
    if (t2 < tFar) tFar = t2;
    if (tNear > tFar) return { hit: false };
  }

  if (tFar < 0) return { hit: false };
  const normal = vec();
  if (axis !== -1) normal[axis] = sign;
  return { hit: true, tNear, tFar, normal };
}
