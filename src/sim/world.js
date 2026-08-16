// Turns map data into something the simulation can query: collision, door
// geometry, and bullet raycasts that respect material penetration.
// Pure — no engine types cross this boundary.

import { rayBox, boxOverlaps, clamp } from './math.js?v=b14bea4c';
import { DOOR } from './constants.js?v=b14bea4c';

const DOOR_HEIGHT = 2.05;
const DOOR_THICKNESS = 0.06;

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

    // Inside — push out along whichever local axis is cheapest.
    const pushX = lp.x - expandedMinX < expandedMaxX - lp.x ? expandedMinX - lp.x : expandedMaxX - lp.x;
    const pushZ = lp.z - expandedMinZ < expandedMaxZ - lp.z ? expandedMinZ - lp.z : expandedMaxZ - lp.z;

    const local = { ...lp };
    if (Math.abs(pushX) < Math.abs(pushZ)) local.x += pushX;
    else local.z += pushZ;

    const world2 = localToWorld(frame, local);
    pos.x = world2.x;
    pos.z = world2.z;
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
export function hasLineOfSight(world, state, from, to) {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  if (len < 1e-6) return true;
  const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
  // Glass is in the way of a bullet, not of your eyes.
  const hits = raycastGeometry(world, state, from, dir, len - 1e-3);
  return hits.every((h) => h.material.seeThrough);
}
