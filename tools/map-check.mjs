// Map sanity check, run under plain Node.
//
// A hand-authored floor plan is easy to get subtly wrong: a room with no way
// in, a doorway that opens into solid wall, a spawn inside the furniture. This
// walks the map data and proves none of that happened.
//
//   node tools/map-check.mjs
//   node tools/map-check.mjs --map=src/maps/range.js
//
// There is more than one map now, and nothing about these rules was ever
// specific to the flat — so the map is an argument, spelled the way
// tools/floorplan.mjs already spells it. Everything the checks used to know by
// heart (which storeys exist, where a flood fill may start, how far out the
// world goes) is read from the map instead.

import { buildWorld, doorFrame, localToWorld } from '../src/sim/world.js';
import { createState, addPlayer, stepSim, createInput } from '../src/sim/sim.js';
import { PLAYER, TICK_RATE } from '../src/sim/constants.js';
import { pointInBox } from '../src/sim/math.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const mapPath = arg('map', '../src/maps/apartment.js');
const module = await import(mapPath.startsWith('.') ? mapPath : `../${mapPath}`);
const MAP = Object.values(module).find((v) => v && v.geometry && v.rooms);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const world = buildWorld(MAP);
const F2 = MAP.upperFloorY ?? 3.3;
const CELL = 0.25;
// A metre of air outside the shell, so a flood fill can round a cell outwards
// without walking off the end of the numbers.
const EDGE = 1;

console.log(`map "${MAP.id}": ${world.boxes.length} boxes, ${world.doors.length} doors, ${world.lights.length} lights`);

// A box may be turned about its own centre, so "is this point inside it" is
// the simulation's own answer rather than a comparison of corners.
const inside = (b, x, y, z) => pointInBox(b, x, y, z);
// ...and where anything wants the ground a box covers rather than the box
// itself, the bounds it actually occupies.
const bounds = (b) => b.aabb ?? b;

// Can a standing player occupy this spot on this storey? Needs floor under the
// feet and a body's worth of clear air above them.
function standable(x, z, floorY) {
  // Sampled a hair off the point, because two slabs that meet leave a seam
  // with no box strictly containing it — a line in the floor, not a hole.
  const E = 0.02;
  const supported = [[E, E], [-E, E], [E, -E], [-E, -E]].some(([dx, dz]) =>
    world.boxes.some((b) =>
      x + dx > b.min.x && x + dx < b.max.x && z + dz > b.min.z && z + dz < b.max.z &&
      Math.abs(b.max.y - floorY) < 0.02));
  if (!supported) return false;
  for (const y of [floorY + 0.1, floorY + 0.9, floorY + 1.6]) {
    for (const b of world.boxes) if (inside(b, x, y, z)) return false;
  }
  return true;
}

// Flood fill one storey from a starting point, walking through doorways
// (door panels are not part of the static geometry, so an open door is a gap).
function flood(startX, startZ, floorY) {
  const key = (i, j) => `${i},${j}`;
  const i0 = Math.round(startX / CELL);
  const j0 = Math.round(startZ / CELL);
  if (!standable(i0 * CELL, j0 * CELL, floorY)) return null;
  const seen = new Set([key(i0, j0)]);
  const queue = [[i0, j0]];
  while (queue.length) {
    const [i, j] = queue.pop();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (seen.has(key(ni, nj))) continue;
      const x = ni * CELL;
      const z = nj * CELL;
      if (x < MAP.bounds.min.x - EDGE || x > MAP.bounds.max.x + EDGE) continue;
      if (z < MAP.bounds.min.z - EDGE || z > MAP.bounds.max.z + EDGE) continue;
      if (!standable(x, z, floorY)) continue;
      seen.add(key(ni, nj));
      queue.push([ni, nj]);
    }
  }
  return seen;
}

// Somewhere inside a room that a player could actually stand — the spot the
// reachability checks below aim at.
function anySpot(r) {
  const floorY = r.floor ? F2 : 0;
  for (let x = r.min.x + 0.5; x < r.max.x; x += 0.5) {
    for (let z = r.min.z + 0.5; z < r.max.z; z += 0.5) {
      if (standable(x, z, floorY)) return { x, z };
    }
  }
  return null;
}

function reachableFrom(startX, startZ, floorY) {
  const seen = flood(startX, startZ, floorY);
  return (x, z) => !!seen && seen.has(`${Math.round(x / CELL)},${Math.round(z / CELL)}`);
}

// A storey is walked from where somebody actually starts on it, which is the
// only place the map itself guarantees is a real standing spot. A storey
// nobody spawns on has nothing to walk from, so it is not walked.
const allSpawns = Object.values(MAP.spawns).flat();
const spawnOn = (floor) =>
  allSpawns.find((s) => ((s.y ?? 0) > 0.1 ? 1 : 0) === floor);

// Which rooms the walk below already had to find a standing spot in, so that
// the room list afterwards asks only about the ones it never reached.
const walked = new Set();

for (const floor of [0, 1]) {
  const here = MAP.rooms.filter((r) => r.floor === floor);
  if (!here.length) continue;
  const start = spawnOn(floor);
  const storey = floor === 0 ? 'Ground floor' : 'Upper floor';
  if (!start) {
    console.log(`\n${storey} reachability: no spawn on this storey, nothing to walk from.`);
    continue;
  }
  console.log(`\n${storey} reachability (from where a team spawns):`);
  const reached = reachableFrom(start.x, start.z, floor ? F2 : 0);
  for (const r of here) {
    if (r.shaft || r.hole || r.outside) continue;
    const p = anySpot(r);
    walked.add(r.id);
    check(`reach ${r.id}`, !!p && reached(p.x, p.z), p ? `(${p.x}, ${p.z})` : 'nowhere to stand');
  }
}

// The room list is what the floor plans are drawn from. If a rectangle in it
// stops matching the walls around it, the plan starts lying — so every room
// has to be a place a player can actually stand. The walk above already asked
// that of everything it reached, and asking twice only prints twice: what is
// left here are the rooms it skipped — the terrace, and any storey nobody
// spawns on.
{
  const rest = MAP.rooms.filter((r) => !r.shaft && !r.hole && !walked.has(r.id));
  if (rest.length) {
    console.log('\nRooms the walk did not cover:');
    for (const r of rest) {
      check(`room "${r.id}" is a real space on floor ${r.floor}`, !!anySpot(r),
        'nowhere to stand in it');
    }
  }
}

console.log('\nSpawns and fittings:');
for (const team of ['attackers', 'defenders']) {
  MAP.spawns[team].forEach((s, i) => {
    check(`${team} spawn ${i + 1} stands clear`, standable(s.x, s.z, s.y ?? 0),
      `(${s.x}, ${s.z}, y=${s.y ?? 0})`);
  });
}
for (const l of world.lights) {
  const clear = !world.boxes.some((b) => inside(b, l.pos.x, l.pos.y, l.pos.z));
  check(`lamp "${l.id}" is not buried in the geometry`, clear);
}

// ...and every lamp is fixed to something. A light floating in mid-air reads
// as a bug the moment a player looks up at it, which is exactly what happened
// in the stairwells and on the roofless terrace.
function fixedTo(l) {
  const hit = (x, y, z) => world.boxes.some((b) => inside(b, x, y, z));
  const mount = l.mount ?? 'ceiling';
  if (mount === 'wall') {
    const f = l.face;
    if (!f) return 'no face given';
    for (let d = 0.1; d <= 0.5; d += 0.05) {
      if (hit(l.pos.x - f.x * d, l.pos.y, l.pos.z - f.z * d)) return null;
    }
    return 'no wall behind it';
  }
  if (mount === 'post') {
    const base = l.base ?? 0;
    if (l.pos.y - base < 1) return 'post too short to stand on';
    return world.boxes.some((b) =>
      l.pos.x > b.min.x && l.pos.x < b.max.x && l.pos.z > b.min.z && l.pos.z < b.max.z &&
      Math.abs(b.max.y - base) < 0.02) ? null : 'no floor under the post';
  }
  const ceiling = l.ceiling ?? l.pos.y + 0.35;
  if (ceiling - l.pos.y > 1.2) return 'hanging on an absurdly long flex';
  for (let y = l.pos.y + 0.2; y <= ceiling + 0.25; y += 0.05) {
    if (hit(l.pos.x, y, l.pos.z)) return null;
  }
  return 'nothing overhead to hang from';
}
for (const l of world.lights) {
  const why = fixedTo(l);
  check(`lamp "${l.id}" is fixed to something`, why === null, why ?? '');
}

console.log('\nDoors: swing, thresholds and the way between them:');
// A door must be able to open without any part of the leaf ending up inside a
// wall, a barrier or a piece of furniture — checked by sweeping the panel and
// sampling its whole volume, not just its centre line.
const DOOR_T = 0.06;
const DOOR_H = 2.05;
function panelClashes(door, openAmount) {
  const frame = doorFrame(door, openAmount);
  for (let along = 0.05; along <= door.width; along += 0.1) {
    for (const side of [-DOOR_T / 2 + 0.01, DOOR_T / 2 - 0.01]) {
      const p = localToWorld(frame, { x: along, y: 0, z: side });
      for (const y of [door.floorY + 0.15, door.floorY + 1.0, door.floorY + DOOR_H - 0.1]) {
        const hit = world.boxes.find((b) => inside(b, p.x, y, p.z));
        if (hit) return `${hit.material.name} at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`;
      }
    }
  }
  return null;
}
for (const d of world.doors) {
  const startsForced = d.startsForced;
  let clash = null;
  if (startsForced) clash = panelClashes(d, 1); // it is open from the first tick
  else for (let i = 0; i <= 12 && !clash; i++) clash = panelClashes(d, i / 12);
  check(`door "${d.id}" swings without hitting anything`, clash === null, clash ?? '');

  // Thrown fully open, a door should be flat against its wall and touching the
  // frame — not stopped a foot short of it in the middle of the doorway. Both
  // halves are needed: the gap alone is small for a door that swings 178° and
  // just as small for one that barely opens at all, because the tip of a panel
  // that never moved is against the wall it started on.
  const gap = Math.abs(Math.sin(Math.PI - d.maxAngle)) * d.width;
  check(`door "${d.id}" opens flat against the wall`,
    d.maxAngle > (100 * Math.PI) / 180 && gap < 0.2,
    `${Math.round((d.maxAngle * 180) / Math.PI)}°, tip ${gap.toFixed(2)} m off the wall`);

  // ...and nothing is parked in the doorway itself.
  const floorY = d.floorY ? F2 : 0;
  const ax = d.axis === 'x' ? 0 : 0.7;
  const az = d.axis === 'x' ? 0.7 : 0;
  check(`door "${d.id}" has clear ground on both sides`,
    standable(d.pos.x + ax, d.pos.z + az, floorY) && standable(d.pos.x - ax, d.pos.z - az, floorY),
    `(${d.pos.x}, ${d.pos.z})`);
}

// Furniture may cut a room in half diagonally, but it may never cut a room's
// doors off from each other: from any door of a room you must be able to walk
// to any other door of it without leaving the room.
console.log('\nEvery room joins its own doors:');
for (const r of MAP.rooms) {
  if (r.shaft || r.hole || r.split) continue; // the corridor is caved in on purpose
  const floorY = r.floor ? F2 : 0;
  const mine = world.doors.filter((d) => {
    if ((d.floorY ? 1 : 0) !== r.floor) return false;
    const near = 0.35;
    return d.pos.x > r.min.x - near && d.pos.x < r.max.x + near &&
      d.pos.z > r.min.z - near && d.pos.z < r.max.z + near;
  });
  if (mine.length < 2) continue;

  // Walk the room only, starting just inside its first door.
  const insideRoom = (x, z) => x > r.min.x - 0.4 && x < r.max.x + 0.4 && z > r.min.z - 0.4 && z < r.max.z + 0.4;
  const stepIn = (d) => {
    const ax = d.axis === 'x' ? 0 : 0.75;
    const az = d.axis === 'x' ? 0.75 : 0;
    const a = { x: d.pos.x + ax, z: d.pos.z + az };
    const b = { x: d.pos.x - ax, z: d.pos.z - az };
    return insideRoom(a.x, a.z) ? a : b;
  };
  const from = stepIn(mine[0]);
  const key = (x, z) => `${Math.round(x / CELL)},${Math.round(z / CELL)}`;
  const seen = new Set([key(from.x, from.z)]);
  const queue = [[from.x, from.z]];
  while (queue.length) {
    const [x, z] = queue.pop();
    for (const [dx, dz] of [[CELL, 0], [-CELL, 0], [0, CELL], [0, -CELL]]) {
      const nx = x + dx;
      const nz = z + dz;
      if (!insideRoom(nx, nz) || seen.has(key(nx, nz)) || !standable(nx, nz, floorY)) continue;
      seen.add(key(nx, nz));
      queue.push([nx, nz]);
    }
  }
  const stranded = mine.filter((d) => {
    const p = stepIn(d);
    return !seen.has(key(p.x, p.z));
  });
  check(`room "${r.id}" joins all ${mine.length} of its doors`, stranded.length === 0,
    stranded.map((d) => d.id).join(', '));
}

console.log('\nStairs stay clear, furniture stands on something:');
// A flight of stairs is a route. Anything standing on one is something to get
// stuck on — and a rail across the top of one seals the floor above off
// entirely, which is exactly what happened.
for (const s of MAP.stairways ?? []) {
  const on = world.boxes.filter((b) =>
    b.tag && b.max.x > s.min.x + 1e-3 && b.min.x < s.max.x - 1e-3 &&
    b.max.y > s.min.y + 1e-3 && b.min.y < s.max.y - 1e-3 &&
    b.max.z > s.min.z + 1e-3 && b.min.z < s.max.z - 1e-3);
  check(`nothing stands on the ${s.id} stairway`, on.length === 0,
    on.map((b) => `${b.tag} ${JSON.stringify(b.min)}`).join(', '));
}

// And nothing floats. Furniture is built out of parts now — a top on legs, a
// shelf between two sides — so the rule is not "there is floor under the
// middle of it" but "something that reaches the ground is there at the level
// this part starts at": the legs under a tabletop, the carcass beside a
// shelf, the floor under the legs.
const GAP = 0.03;
for (const b of world.boxes) {
  if (b.tag !== 'furniture') continue;
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const bb = bounds(b);
  const held = world.boxes.some((o) => {
    const ob = bounds(o);
    return o !== b
      && ob.max.x > bb.min.x + 1e-3 && ob.min.x < bb.max.x - 1e-3
      && ob.max.z > bb.min.z + 1e-3 && ob.min.z < bb.max.z - 1e-3
      && ob.max.y > bb.min.y - GAP && ob.min.y < bb.min.y + GAP;
  });
  check(`furniture at (${cx.toFixed(1)}, ${cz.toFixed(1)}) is held up by something`, held,
    `${(b.max.x - b.min.x).toFixed(2)}x${(b.max.z - b.min.z).toFixed(2)} at y=${b.min.y.toFixed(2)}`);
}

// Decoration is drawn and never simulated, which is only safe while it stays
// decoration: a picture hung inside a wall is invisible, and a picture you
// could mistake for cover is a lie, because a bullet goes straight through it.
console.log('\nDecoration:');
{
  const inside = (p, g) => p.x > g.min.x && p.x < g.max.x
    && p.y > g.min.y && p.y < g.max.y && p.z > g.min.z && p.z < g.max.z;
  const buried = (MAP.decor ?? []).filter((d) => {
    const c = {
      x: (d.min.x + d.max.x) / 2, y: (d.min.y + d.max.y) / 2, z: (d.min.z + d.max.z) / 2,
    };
    return MAP.geometry.some((g) => inside(c, g));
  });
  check(`none of the ${(MAP.decor ?? []).length} drawn-only pieces is buried in the building`,
    buried.length === 0, buried.map((d) => JSON.stringify(d.min)).join(' '));

  // Nothing you would ever crouch behind. Anything standing off the floor
  // that is wide enough and tall enough to hide a man has to be real.
  const pretender = (MAP.decor ?? []).filter((d) => {
    const w = Math.max(d.max.x - d.min.x, d.max.z - d.min.z);
    const thick = Math.min(d.max.x - d.min.x, d.max.z - d.min.z);
    const h = d.max.y - d.min.y;
    const floor = d.min.y % 3.3;
    return w > 0.7 && thick > 0.25 && h > 0.6 && floor < 0.5;
  });
  check('and none of it is big enough to be mistaken for cover',
    pretender.length === 0, pretender.map((d) => JSON.stringify(d.min)).join(' '));
}

console.log('\nSurfaces:');
// Two surfaces drawn at the same depth fight for every pixel and flicker as
// you move — "the textures overlap". That happens when two boxes present a
// face on the same plane, facing the same way, over the same patch. Buried
// pairs are harmless, so each candidate is sampled to see whether anything is
// actually in front of it.
const AXES = [['x', 'y', 'z'], ['y', 'x', 'z'], ['z', 'x', 'y']];
const span = (a, b, k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]);
const within = (b, p) =>
  p.x > b.min.x + 1e-4 && p.x < b.max.x - 1e-4 &&
  p.y > b.min.y + 1e-4 && p.y < b.max.y - 1e-4 &&
  p.z > b.min.z + 1e-4 && p.z < b.max.z - 1e-4;

const clashes = [];
for (let i = 0; i < world.boxes.length; i++) {
  for (let j = i + 1; j < world.boxes.length; j++) {
    const a = world.boxes[i];
    const b = world.boxes[j];
    // Two boxes at different angles have no faces in common to fight over,
    // and a turned box's own corners are said in its own frame — so this
    // comparison only means anything between two things standing square.
    if (a.yaw || b.yaw) continue;
    for (const [k, u, v] of AXES) {
      if (span(a, b, u) <= 1e-3 || span(a, b, v) <= 1e-3) continue;
      for (const side of ['min', 'max']) {
        if (Math.abs(a[side][k] - b[side][k]) > 1e-3) continue;
        const lo = { u: Math.max(a.min[u], b.min[u]), v: Math.max(a.min[v], b.min[v]) };
        const hi = { u: Math.min(a.max[u], b.max[u]), v: Math.min(a.max[v], b.max[v]) };
        let exposed = false;
        for (const tu of [0.25, 0.75]) {
          for (const tv of [0.25, 0.75]) {
            const p = { x: 0, y: 0, z: 0 };
            p[k] = a[side][k] + (side === 'max' ? 0.02 : -0.02);
            p[u] = lo.u + (hi.u - lo.u) * tu;
            p[v] = lo.v + (hi.v - lo.v) * tv;
            if (!world.boxes.some((o) => o !== a && o !== b && within(o, p))) exposed = true;
          }
        }
        if (!exposed) continue;
        clashes.push(`${a.material.name} ${JSON.stringify(a.min)} vs ${b.material.name} ` +
          `${JSON.stringify(b.min)} — both show a face at ${side}.${k}=${a[side][k].toFixed(2)}`);
      }
    }
  }
}
for (const c of clashes) console.log(`       ${c}`);
check(`no two of the ${world.boxes.length} surfaces are drawn in the same place`,
  clashes.length === 0, `${clashes.length} pair(s)`);

// Walk a player up each staircase for real, through the simulation.
// Walks a player through a list of waypoints the way a person would: face the
// next corner, walk until you reach it, turn. Proves the route is passable
// rather than that some fixed sequence of keypresses happens to work.
function walk(id, from, waypoints, expectY) {
  const state = createState(world, 99);
  const p = addPlayer(world, state, 'p', 'attackers', 'P');
  state.phase = 'live'; // staging holds the attackers at the door
  state.phaseTime = 60;
  p.pos = { x: from.x, y: from.y, z: from.z };
  for (const d of Object.values(state.doors)) { d.open = 1; d.locked = false; }

  let top = p.pos.y;
  let stuck = null;
  for (const wp of waypoints) {
    let reached = false;
    for (let i = 0; i < TICK_RATE * 8 && !reached; i++) {
      // Forward is -Z at yaw 0, so this is the heading to (wp.x, wp.z).
      const yaw = Math.atan2(-(wp.x - p.pos.x), -(wp.z - p.pos.z));
      p.look = { yaw, pitch: 0 };
      stepSim(world, state, { p: { ...createInput(), moveZ: 1, yaw } });
      top = Math.max(top, p.pos.y);
      if (Math.hypot(wp.x - p.pos.x, wp.z - p.pos.z) < 0.45) reached = true;
    }
    if (!reached && !stuck) stuck = `stopped short of (${wp.x}, ${wp.z}) at (${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(2)}, ${p.pos.z.toFixed(1)})`;
  }
  check(`${id}: a player walks the whole way up`, !stuck && p.pos.y > expectY - 0.05,
    stuck ?? `ended at y=${p.pos.y.toFixed(2)}, highest ${top.toFixed(2)}`);
}

// The one thing about a staircase that cannot be read out of the geometry is
// the way a person would actually go up it, so the routes are written down —
// per map, because a map without stairs has none to write.
const STAIR_WALKS = {
  // The court stair is a switchback: north up the west flight, east across the
  // half-landing, south up the east flight, out onto the terrace.
  penthouse: [
    ['court stair', { x: -11.6, y: 0, z: -10.4 }, [
      { x: -11.6, z: -13.8 },
      { x: -10.0, z: -13.8 },
      { x: -10.0, z: -10.9 },
      { x: -10.0, z: -9.5 },
    ], 16],
    ['east stairs', { x: 14.8, y: 0, z: -6.9 }, [{ x: 14.8, z: -0.5 }], 16],
  ],
};

const walks = STAIR_WALKS[MAP.id] ?? [];
if (walks.length) {
  console.log('\nStairs:');
  for (const [id, from, waypoints, steps] of walks) {
    walk(id, from, waypoints, F2);
    // Steps must stay under the step-up height, or they become a wall.
    check(`${id}: every step is climbable`, F2 / steps < PLAYER.stepHeight,
      `${(F2 / steps).toFixed(3)} m`);
  }
} else {
  console.log(`\nStairs: none on "${MAP.id}".`);
}

console.log(failures === 0 ? '\nAll map checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
