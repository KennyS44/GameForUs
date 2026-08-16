// Map sanity check, run under plain Node.
//
// A hand-authored floor plan is easy to get subtly wrong: a room with no way
// in, a doorway that opens into solid wall, a spawn inside the furniture. This
// walks the map data and proves none of that happened.
//
//   node tools/map-check.mjs

import { APARTMENT } from '../src/maps/apartment.js';
import { buildWorld } from '../src/sim/world.js';
import { createState, addPlayer, stepSim, createInput } from '../src/sim/sim.js';
import { PLAYER, TICK_RATE } from '../src/sim/constants.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const world = buildWorld(APARTMENT);
const F2 = 3.3;
const CELL = 0.25;

console.log(`map: ${world.boxes.length} boxes, ${world.doors.length} doors, ${world.lights.length} lights`);

const inside = (b, x, y, z) =>
  x > b.min.x && x < b.max.x && y > b.min.y && y < b.max.y && z > b.min.z && z < b.max.z;

// Can a standing player occupy this spot on this storey? Needs floor under the
// feet and a body's worth of clear air above them.
function standable(x, z, floorY) {
  let supported = false;
  for (const b of world.boxes) {
    if (x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z &&
        Math.abs(b.max.y - floorY) < 0.02) supported = true;
  }
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
      if (Math.abs(x) > 17 || z < -19 || z > 10) continue;
      if (!standable(x, z, floorY)) continue;
      seen.add(key(ni, nj));
      queue.push([ni, nj]);
    }
  }
  return seen;
}

// One point per room, and the room must be reachable from the front door
// (ground floor) or from the top of the west staircase (upper floor).
const GROUND = {
  'living room': [-10, -14], 'living room (south end)': [-9, -9],
  dining: [-3, -8.5], kitchen: [4, -10], utility: [11, -10],
  study: [-2, -15], 'guest bedroom': [5.5, -16], bathroom: [11, -15],
  'spine (west)': [-12, -6], 'spine (east)': [12, -6],
  cinema: [-9, -2], cloakroom: [-9, 3.5], gallery: [0, -2], foyer: [0, 3.5],
  gym: [8, -2], 'guest suite': [7.5, 2], spa: [12, 3.5],
  'west stair foot': [-14.8, -5], 'east stair foot': [14.8, -6.9],
};
const UPPER = {
  'master bedroom': [-8, -9.5], 'master bathroom': [-10, -15],
  wardrobe: [-3.5, -9.5], 'bedroom 2': [-2, -16], 'bedroom 3': [0, -16],
  study: [2, -10], 'kids bathroom': [7, -16], store: [12, -16], laundry: [11, -9],
  'spine (west)': [-12, -6], 'spine (east)': [12, -6],
  terrace: [-8, 2], lounge: [2, -2], media: [4, 3.5], sauna: [10, -2], office: [12, 3.5],
};

console.log('\nGround floor reachability (from the front door):');
const g = flood(0, 5, 0);
check('the entrance hall is standable', !!g);
for (const [name, [x, z]] of Object.entries(GROUND)) {
  const ok = g && g.has(`${Math.round(x / CELL)},${Math.round(z / CELL)}`);
  check(`reach ${name}`, ok, `(${x}, ${z})`);
}

console.log('\nUpper floor reachability (from the top of the west stairs):');
const u = flood(-14.8, -11.3, F2);
check('the west stair head is standable', !!u);
for (const [name, [x, z]] of Object.entries(UPPER)) {
  const ok = u && u.has(`${Math.round(x / CELL)},${Math.round(z / CELL)}`);
  check(`reach ${name}`, ok, `(${x}, ${z})`);
}

console.log('\nRooms:');
// The room list is what the floor plans are drawn from. If a rectangle in it
// stops matching the walls around it, the plan starts lying — so every room
// has to be a place a player can actually stand.
for (const r of APARTMENT.rooms) {
  if (r.shaft) continue; // a shaft's middle is the flight of stairs, not a floor
  const cx = (r.min.x + r.max.x) / 2;
  const cz = (r.min.z + r.max.z) / 2;
  check(`room "${r.id}" is a real space on floor ${r.floor}`,
    standable(cx, cz, r.floor ? F2 : 0), `centre (${cx}, ${cz})`);
}

console.log('\nSpawns and fittings:');
for (const team of ['attackers', 'defenders']) {
  APARTMENT.spawns[team].forEach((s, i) => {
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

console.log('\nDoors:');
// A door thrown fully open should be flat against its wall, touching the
// frame — not stopped a foot short of it in the middle of the doorway.
for (const d of world.doors) {
  const gap = Math.abs(Math.sin(Math.PI - d.maxAngle)) * d.width;
  check(`door "${d.id}" opens flat against the wall`, gap < 0.2,
    `${Math.round((d.maxAngle * 180) / Math.PI)}°, tip ${gap.toFixed(2)} m off the wall`);
}

console.log('\nStairs:');
// Walk a player up each staircase for real, through the simulation.
function climb(id, from, yaw, seconds) {
  const state = createState(world, 99);
  const p = addPlayer(world, state, 'p', 'attackers', 'P');
  p.pos = { x: from.x, y: from.y, z: from.z };
  p.look = { yaw, pitch: 0 };
  // Doors stand open so this measures the stairs, not the door handling.
  for (const d of Object.values(state.doors)) { d.open = 1; d.locked = false; }
  let top = p.pos.y;
  for (let i = 0; i < TICK_RATE * seconds; i++) {
    stepSim(world, state, { p: { ...createInput(), moveZ: 1, yaw, run: true } });
    top = Math.max(top, p.pos.y);
  }
  check(`${id}: a player walks up to the next floor`, top > F2 - 0.05,
    `reached y=${top.toFixed(2)} at (${p.pos.x.toFixed(1)}, ${p.pos.z.toFixed(1)})`);
}
climb('west stairs', { x: -14.8, y: 0, z: -5.2 }, 0, 8);
climb('east stairs', { x: 14.8, y: 0, z: -6.6 }, Math.PI, 8);

// Steps must stay under the step-up height, or they become a wall.
check('every step is climbable', F2 / 16 < PLAYER.stepHeight, `${(F2 / 16).toFixed(3)} m`);

console.log(failures === 0 ? '\nAll map checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
