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

// ── Boxes that are turned ──────────────────────────────────────────────────
//
// A box may be rotated about the vertical axis through its own centre. That is
// the whole of it: no pitch, no roll, because a flat is furnished by people
// who put things down flat.
//
// Rather than teach every test in the game about rotation, each one moves the
// question into the box's own frame — where the box is axis-aligned again and
// all the arithmetic below already works — and moves the answer back out. The
// doors have done exactly this since they were built; this is the same trick
// with the numbers baked in once instead of recomputed per query.
//
// A turned box carries:
//   yaw            the angle, in radians
//   c              the centre it turns about, in x and z
//   cos, sin       that angle, worked out once
//   aabb           its world bounds, for anything that wants a cheap first pass
//
// `min` and `max` stay exactly what they were: the box before it was turned.

export function turnBox(b, yaw) {
  if (!yaw) return b;
  const c = { x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2 };
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const hx = (b.max.x - b.min.x) / 2;
  const hz = (b.max.z - b.min.z) / 2;
  // The turned box's world bounds: the corner offsets, taken absolutely.
  const ex = Math.abs(hx * cos) + Math.abs(hz * sin);
  const ez = Math.abs(hx * sin) + Math.abs(hz * cos);
  return {
    ...b,
    yaw,
    c,
    cos,
    sin,
    aabb: {
      min: { x: c.x - ex, y: b.min.y, z: c.z - ez },
      max: { x: c.x + ex, y: b.max.y, z: c.z + ez },
    },
  };
}

// A point in the world, said in the box's own frame.
export function intoBox(b, x, z) {
  const dx = x - b.c.x;
  const dz = z - b.c.z;
  return { x: b.c.x + dx * b.cos - dz * b.sin, z: b.c.z + dx * b.sin + dz * b.cos };
}

// ...and a direction said back in the world's.
export function outOfBox(b, x, z) {
  return { x: x * b.cos + z * b.sin, z: -x * b.sin + z * b.cos };
}

// Is this point inside the box, turned or not?
export function pointInBox(b, x, y, z) {
  if (y <= b.min.y || y >= b.max.y) return false;
  if (!b.yaw) return x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z;
  const p = intoBox(b, x, z);
  return p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z;
}

// Does a circle of this radius, standing at (x, z), touch the box at all?
// Plan only — nothing here looks at height.
export function columnHitsBox(b, x, z, r) {
  const p = b.yaw ? intoBox(b, x, z) : { x, z };
  const dx = p.x - Math.max(b.min.x, Math.min(p.x, b.max.x));
  const dz = p.z - Math.max(b.min.z, Math.min(p.z, b.max.z));
  return dx * dx + dz * dz <= r * r;
}

// How far a circle standing at (x, z) has pushed into this box, and which way
// it would have to move to be clear of it. Null when it is not touching.
//
// A circle rather than a square, for the one reason that matters: a circle is
// the same shape whatever angle you look at it from, so a man walking into the
// corner of a sofa turned forty degrees slides along it instead of catching on
// arithmetic that only understands north and east.
export function pushOutOfBox(b, x, y, z, r, height) {
  if (y + height <= b.min.y || y >= b.max.y) return null;
  const p = b.yaw ? intoBox(b, x, z) : { x, z };
  // The nearest point of the box to the middle of the circle, in the box's
  // own frame.
  const nx = Math.max(b.min.x, Math.min(p.x, b.max.x));
  const nz = Math.max(b.min.z, Math.min(p.z, b.max.z));
  let dx = p.x - nx;
  let dz = p.z - nz;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return null;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    const push = r - d;
    dx = (dx / d) * push;
    dz = (dz / d) * push;
  } else {
    // Dead centre: out by the nearest face, which is the shallowest way.
    const left = p.x - b.min.x;
    const right = b.max.x - p.x;
    const back = p.z - b.min.z;
    const front = b.max.z - p.z;
    const least = Math.min(left, right, back, front);
    dx = least === left ? -(left + r) : least === right ? right + r : 0;
    dz = least === back ? -(back + r) : least === front ? front + r : 0;
  }
  return b.yaw ? outOfBox(b, dx, dz) : { x: dx, z: dz };
}

// A ray against a box that may be turned. Same answer shape as `rayBox`, with
// the normal handed back in the world's frame.
export function rayTurnedBox(origin, dir, b) {
  if (!b.yaw) return rayBox(origin, dir, b);
  const o = intoBox(b, origin.x, origin.z);
  const d = { x: dir.x * b.cos - dir.z * b.sin, y: dir.y, z: dir.x * b.sin + dir.z * b.cos };
  const r = rayBox({ x: o.x, y: origin.y, z: o.z }, d, b);
  if (!r.hit) return r;
  const n = outOfBox(b, r.normal.x, r.normal.z);
  return { ...r, normal: { x: n.x, y: r.normal.y, z: n.z } };
}
