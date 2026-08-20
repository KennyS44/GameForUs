// Turns map data into something the simulation can query: collision, door
// geometry, and bullet raycasts that respect material penetration.
// Pure — no engine types cross this boundary.

import { rayBox, boxOverlaps, clamp } from './math.js?v=d55bee09';
import { DOOR } from './constants.js?v=d55bee09';

const DOOR_HEIGHT = 2.05;
const DOOR_THICKNESS = 0.06;

// A tripwire is strung across the panel at handle height, a hand's width clear
// of its face, on whichever side the defender fitted it from. It is a thing in
// the world with a size: you can see it, and you can shoot it.
export const TRIPWIRE = {
  height: 1.0,
  inset: 0.12,
  standoff: 0.05,
  halfThickness: 0.03,
};

// Where the wire hangs, in the door's own frame, measured from its floor.
export function trapWireLocal(door, side = 1) {
  return {
    x: door.width / 2,
    y: TRIPWIRE.height,
    z: (side < 0 ? -1 : 1) * (DOOR_THICKNESS / 2 + TRIPWIRE.standoff),
    span: Math.max(0.1, door.width - TRIPWIRE.inset * 2),
  };
}

// The same wire as a box a ray can hit, in the coordinates the door's own
// raycasts use — so shooting it costs exactly the aim it looks like it costs.
export function trapWireBox(door, side = 1) {
  const w = trapWireLocal(door, side);
  const h = TRIPWIRE.halfThickness;
  return {
    min: { x: w.x - w.span / 2, y: door.floorY + w.y - h, z: w.z - h },
    max: { x: w.x + w.span / 2, y: door.floorY + w.y + h, z: w.z + h },
  };
}

// Is the panel clear of the walls at this angle? Sampled along the leaf at a
// few heights — enough for rectangular rooms, and it runs once at load.
// `base` is the floor the door stands on, so an upstairs door is tested
// against the upstairs walls and not the ones below it.
function panelFits(geometry, hinge, theta, width, base) {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  for (const along of [0.35, 0.6, 0.85, 1.0]) {
    const px = hinge.x + cos * width * along;
    const pz = hinge.z + sin * width * along;
    for (const py of [base + 0.25, base + 1.0, base + 1.9]) {
      for (const b of geometry) {
        if (
          px > b.min.x && px < b.max.x &&
          py > b.min.y && py < b.max.y &&
          pz > b.min.z && pz < b.max.z
        ) return false;
      }
    }
  }
  return true;
}

// How far this particular door can actually swing before it hits something.
// Doors open wide by default; one that would sweep into a wall stops short
// rather than clipping through it.
function swingLimit(map, hinge, base, swingSign, width, floorY) {
  const STEPS = 20;
  const MIN = Math.PI / 2;
  for (let i = 0; i <= STEPS; i++) {
    const angle = DOOR.openAngle - (DOOR.openAngle - MIN) * (i / STEPS);
    if (panelFits(map.geometry, hinge, base + swingSign * angle, width, floorY)) return angle;
  }
  return MIN;
}

export function buildWorld(map) {
  const doors = map.doors.map((d) => {
    // Hinge sits at one end of the doorway, on the wall line.
    const half = d.width / 2;
    const hinge =
      d.axis === 'x'
        ? { x: d.pos.x + (d.hinge === -1 ? -half : half), z: d.pos.z }
        : { x: d.pos.x, z: d.pos.z + (d.hinge === -1 ? -half : half) };

    // Angle that lays the panel flat in the doorway, pointing away from the hinge.
    let base;
    if (d.axis === 'x') base = d.hinge === -1 ? 0 : Math.PI;
    else base = d.hinge === -1 ? Math.PI / 2 : -Math.PI / 2;

    // Which way the panel sweeps when it opens.
    const swingSign =
      (d.axis === 'x' ? 1 : -1) * (d.hinge === -1 ? 1 : -1) * (d.swing ?? 1);

    // Which storey the door stands on. Everything about a door is measured
    // from its own floor, so the upstairs ones behave exactly like these.
    const floorY = d.y ?? 0;

    // Real hinges are screwed to the face of the jamb, not buried in the
    // middle of the wall. Standing the pivot off by half the wall plus half
    // the panel is what lets a fully open door lie against the wall and touch
    // the frame instead of hanging in the doorway.
    const standoff = (d.frame ?? 0.12) / 2 + DOOR_THICKNESS / 2;
    const swingWay = d.swing ?? 1;
    if (d.axis === 'x') hinge.z += swingWay * standoff;
    else hinge.x += swingWay * standoff;

    return {
      id: d.id,
      axis: d.axis,
      width: d.width,
      material: d.material,
      reinforced: !!d.reinforced,
      maxHealth: d.health ?? 100,
      lockedByDefault: !!d.locked,
      // Some doors were kicked in before anyone arrived.
      startsForced: !!d.startsForced,
      hinge,
      base,
      floorY,
      swingSign,
      maxAngle: d.maxAngle ?? swingLimit(map, hinge, base, swingSign, d.width, floorY),
      pos: { ...d.pos, y: floorY },
      localBox: {
        min: { x: 0, y: floorY, z: -DOOR_THICKNESS / 2 },
        max: { x: d.width, y: floorY + DOOR_HEIGHT, z: DOOR_THICKNESS / 2 },
      },
    };
  });

  return {
    map,
    boxes: map.geometry,
    doors,
    lights: map.lights,
    bounds: map.bounds,
  };
}

// ── Door frames ───────────────────────────────────────────────────────────

export function doorAngle(door, openAmount) {
  // Each door carries its own limit: most swing the full 170°, but one that
  // would otherwise sweep into a wall stops where the wall is.
  return door.base + door.swingSign * openAmount * (door.maxAngle ?? DOOR.openAngle);
}

export function doorFrame(door, openAmount) {
  const th = doorAngle(door, openAmount);
  return { hinge: door.hinge, cos: Math.cos(th), sin: Math.sin(th), theta: th };
}

// Rotation acts in the XZ plane: (x,z) -> (x·cos - z·sin, x·sin + z·cos).
export function worldToLocal(frame, p) {
  const dx = p.x - frame.hinge.x;
  const dz = p.z - frame.hinge.z;
  return {
    x: dx * frame.cos + dz * frame.sin,
    y: p.y,
    z: -dx * frame.sin + dz * frame.cos,
  };
}

export function localToWorld(frame, p) {
  return {
    x: frame.hinge.x + p.x * frame.cos - p.z * frame.sin,
    y: p.y,
    z: frame.hinge.z + p.x * frame.sin + p.z * frame.cos,
  };
}

// Direction vectors rotate the same way but ignore the hinge translation.
export function dirToLocal(frame, d) {
  return {
    x: d.x * frame.cos + d.z * frame.sin,
    y: d.y,
    z: -d.x * frame.sin + d.z * frame.cos,
  };
}

export function dirToWorld(frame, d) {
  return {
    x: d.x * frame.cos - d.z * frame.sin,
    y: d.y,
    z: d.x * frame.sin + d.z * frame.cos,
  };
}

// ── Collision ─────────────────────────────────────────────────────────────

function playerBox(pos, radius, height) {
  return {
    min: { x: pos.x - radius, y: pos.y, z: pos.z - radius },
    max: { x: pos.x + radius, y: pos.y + height, z: pos.z + radius },
  };
}

// Resolve one axis of movement against the static geometry.
// Returns the corrected coordinate on that axis.
function resolveAxis(world, pos, radius, height, axis, delta, stepHeight) {
  const next = { ...pos };
  next[axis] += delta;
  const pb = playerBox(next, radius, height);

  for (const b of world.boxes) {
    if (!boxOverlaps(pb, b)) continue;

    // Vertical moves may only resolve against surfaces we were already clear
    // of. Without this, a player standing flush against a wall gets snapped to
    // the top of it by gravity — falling "onto" a surface they were beside
    // rather than above.
    if (axis === 'y') {
      if (delta < 0 && b.max.y > pos.y + 1e-3) continue;
      if (delta > 0 && b.min.y < pos.y + height - 1e-3) continue;
    }

    // Step over low obstacles instead of stopping dead on them.
    if (axis !== 'y' && b.max.y - pos.y <= stepHeight + 1e-4) {
      const lifted = { ...next, y: b.max.y };
      if (!world.boxes.some((o) => o !== b && boxOverlaps(playerBox(lifted, radius, height), o))) {
        next.y = b.max.y;
        pos.y = b.max.y;
        continue;
      }
    }

    if (delta > 0) next[axis] = b.min[axis] - (axis === 'y' ? height : radius) - 1e-4;
    else next[axis] = b.max[axis] + (axis === 'y' ? 0 : radius) + 1e-4;

    pb.min[axis] = next[axis] - (axis === 'y' ? 0 : radius);
    pb.max[axis] = next[axis] + (axis === 'y' ? height : radius);
    delta = 0;
  }
  return next;
}

// Push the player out of any door panel they are standing inside.
// Done in the door's own rotated frame, so a half-open door blocks exactly
// where it looks like it does.
function resolveDoors(world, state, pos, radius, height) {
  for (const door of world.doors) {
    const ds = state.doors[door.id];
    if (!ds || ds.broken) continue; // shattered glass is not in the way

    const frame = doorFrame(door, ds.open);
    const lp = worldToLocal(frame, pos);
    const lb = door.localBox;

    // Vertical miss — nothing to resolve.
    if (pos.y > lb.max.y || pos.y + height < lb.min.y) continue;

    const expandedMinX = lb.min.x - radius;
    const expandedMaxX = lb.max.x + radius;
    const expandedMinZ = lb.min.z - radius;
    const expandedMaxZ = lb.max.z + radius;

    if (lp.x <= expandedMinX || lp.x >= expandedMaxX) continue;
    if (lp.z <= expandedMinZ || lp.z >= expandedMaxZ) continue;

    // Inside the leaf — push out. The cheapest way out is tried first, but a
    // push is only taken if it lands somewhere a body actually fits: a door
    // closing on someone in a doorway used to shove them straight through the
    // wall behind them, which is how a player ends up in the wrong room.
    const pushX = lp.x - expandedMinX < expandedMaxX - lp.x ? expandedMinX - lp.x : expandedMaxX - lp.x;
    const pushZ = lp.z - expandedMinZ < expandedMaxZ - lp.z ? expandedMinZ - lp.z : expandedMaxZ - lp.z;

    const tryPush = (dx, dz) => {
      const p = localToWorld(frame, { x: lp.x + dx, y: lp.y, z: lp.z + dz });
      const body = playerBox({ x: p.x, y: pos.y, z: p.z }, radius, height);
      if (world.boxes.some((b) => boxOverlaps(body, b))) return false;
      pos.x = p.x;
      pos.z = p.z;
      return true;
    };

    const closest = Math.abs(pushX) < Math.abs(pushZ);
    // The cheapest way out, then the other axis. If a body fits neither way the
    // panel sweeps through instead: being briefly inside a door beats being
    // flung into a room you never walked to.
    // A push is a nudge, never a shove: anything bigger than a stride is the
    // door trying to relocate you, so it is refused.
    const MAX_PUSH = 0.4;
    const escapes = (closest ? [[pushX, 0], [0, pushZ]] : [[0, pushZ], [pushX, 0]])
      .filter(([dx, dz]) => Math.hypot(dx, dz) <= MAX_PUSH);
    for (const [dx, dz] of escapes) if (tryPush(dx, dz)) break;
  }
}

export function moveAndCollide(world, state, pos, delta, radius, height, stepHeight) {
  let p = { ...pos };

  if (delta.x !== 0) p = resolveAxis(world, p, radius, height, 'x', delta.x, stepHeight);
  if (delta.z !== 0) p = resolveAxis(world, p, radius, height, 'z', delta.z, stepHeight);
  if (delta.y !== 0) p = resolveAxis(world, p, radius, height, 'y', delta.y, stepHeight);

  resolveDoors(world, state, p, radius, height);

  // Never let anyone leak outside the map.
  p.x = clamp(p.x, world.bounds.min.x + radius, world.bounds.max.x - radius);
  p.z = clamp(p.z, world.bounds.min.z + radius, world.bounds.max.z - radius);
  return p;
}

// Is the player standing on something?
export function groundedAt(world, pos, radius) {
  const probe = {
    min: { x: pos.x - radius, y: pos.y - 0.08, z: pos.z - radius },
    max: { x: pos.x + radius, y: pos.y + 0.02, z: pos.z + radius },
  };
  return world.boxes.some((b) => boxOverlaps(probe, b));
}

// ── Raycast ───────────────────────────────────────────────────────────────

// Collect every surface a ray crosses, in order. Used for bullets (which can
// keep going through drywall) and for line-of-sight checks (which stop at the
// first opaque thing).
export function raycastGeometry(world, state, origin, dir, maxDist) {
  const hits = [];

  for (const b of world.boxes) {
    const r = rayBox(origin, dir, b);
    if (!r.hit) continue;
    const enter = Math.max(r.tNear, 0);
    if (enter > maxDist) continue;
    hits.push({
      t: enter,
      exit: Math.min(r.tFar, maxDist),
      normal: r.normal,
      material: b.material,
      kind: 'geometry',
    });
  }

  for (const door of world.doors) {
    const ds = state.doors[door.id];
    if (!ds || ds.broken) continue;
    const frame = doorFrame(door, ds.open);
    const lo = worldToLocal(frame, origin);
    const ld = dirToLocal(frame, dir);
    const r = rayBox(lo, ld, door.localBox);
    if (!r.hit) continue;
    const enter = Math.max(r.tNear, 0);
    if (enter > maxDist) continue;
    hits.push({
      t: enter,
      exit: Math.min(r.tFar, maxDist),
      // The panel was traced in its own rotated frame, so its normal comes
      // back rotated too. Everything downstream — bullet holes above all —
      // wants it the way the world sees it.
      normal: dirToWorld(frame, r.normal),
      material: door.material,
      kind: 'door',
      doorId: door.id,
    });
  }

  hits.sort((a, b) => a.t - b.t);
  return hits;
}

// True if `from` can see `to` with nothing solid in between.
//
// `throughDoorId` lets one door be treated as if it were not there. Only a
// blast fitted to that door uses it: the panel a charge is taped to does not
// get to shield the man opening it, while every other wall still does.
export function hasLineOfSight(world, state, from, to, throughDoorId = null) {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  if (len < 1e-6) return true;
  const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
  // Smoke is checked before geometry because it is cheaper and because it is
  // the answer more often: a cloud in a doorway blocks the eye, the bot and
  // the flashbang alike, which is the whole reason to throw one.
  if (smokeBlocks(state, from, dir, len)) return false;
  // Glass is in the way of a bullet, not of your eyes.
  const hits = raycastGeometry(world, state, from, dir, len - 1e-3);
  return hits.every((h) => h.material.seeThrough || h.doorId === throughDoorId);
}

// Does the segment pass through any live smoke cloud?
//
// A cloud is a sphere, so this is the classic ray-sphere test, with one twist:
// a thin clip of the very edge should not hide anyone. The ray has to spend
// real distance inside the cloud — a third of a metre — before it counts.
const SMOKE_BITE = 0.35;

export function smokeBlocks(state, from, dir, len) {
  const clouds = state.smokes;
  if (!clouds?.length) return false;
  for (const c of clouds) {
    const r = c.radius * c.grown;
    if (r <= 0.05) continue;
    const ox = from.x - c.pos.x;
    const oy = from.y - c.pos.y;
    const oz = from.z - c.pos.z;
    const b = ox * dir.x + oy * dir.y + oz * dir.z;
    const cc = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - cc;
    if (disc <= 0) continue;
    const root = Math.sqrt(disc);
    const enter = Math.max(0, -b - root);
    const exit = Math.min(len, -b + root);
    if (exit - enter > SMOKE_BITE) return true;
  }
  return false;
}
