// The map: a two-storey penthouse, redesigned around the fight rather than
// around the flat it started as.
//
// Axes as always: +X east, +Z south, +Y up. Ground floor y = 0, upper y = 3.3.
//
// How it is laid out:
//   · the living room loses its roof and becomes an open court with concrete
//     parapets; the west staircase is now an open switchback inside it;
//   · the terrace moves above the living room as an L-shaped balcony with
//     glass railings over the void;
//   · the old terrace becomes the master bedroom and bathroom, and the upper
//     lounge and media room grow 1.5 m west;
//   · double doors join the living room, the corridor and the cinema in one
//     straight line;
//   · cinema ↔ hall and hall ↔ cloakroom are walled up, and two new doors join
//     the cinema to the cloakroom at both ends of its south wall;
//   · the way into the hall from the guest room is a hole in the wall;
//   · hall ↔ gym starts kicked in with something small in the way: no
//     walking through, but nothing in the way of a shot;
//   · bathroom and utility become one room split by a bar-height barrier;
//   · study and guest bedroom become one room with a column where the wall was;
//   · upstairs: defenders spawn in bedroom 3, the bathroom opens into the
//     laundry, the terrace doors are glass, and the store has a hole in its
//     floor you can drop through into the bathroom below.

// Two numbers decide what a bullet does to a surface, and they are not the
// same number:
//
//   `resist` — points of a weapon's penetration eaten per centimetre. Zero
//     means nothing on the roster gets through it at any thickness. Every
//     weapon carries a budget of these: 2 for buckshot, 13 for a rifle, 60 for
//     the .50.
//   `soak`   — per cent of the round's damage lost per centimetre.
//
// Keeping them apart is what lets a door be something everyone shoots through
// and everyone pays for, while a wall is something only the .50 crosses.
import { turnBox } from '../sim/math.js?v=b574760e';

export const MATERIALS = {
  concrete: { name: 'concrete', resist: 0, color: 0x3a3a3e, hardness: 1.0 },
  floor: { name: 'floor', resist: 0, color: 0x5b4835, hardness: 1.0 },
  // An interior wall is not cover you shoot through — it is cover. One weapon
  // in the building disagrees, and carrying it costs a fifth of your walking
  // speed.
  drywall: { name: 'drywall', resist: 3.5, soak: 3.5, color: 0x5a544c, hardness: 0.25 },
  // A door panel is six centimetres of this: everything on the roster gets
  // through one, buckshot included, and everything arrives a quarter weaker.
  // Furniture is the same stuff by the half-metre, which is why a wardrobe
  // stops what a door does not.
  wood: { name: 'wood', resist: 0.233, soak: 4.0, color: 0x4a3826, hardness: 0.5 },
  // Glass is shot through like anything thin — it just gives up sooner: two
  // rounds and the pane is out of the frame. It barely slows a round and
  // barely weakens it, because a railing is not cover.
  glass: {
    name: 'glass', resist: 0.07, soak: 1.0, color: 0x88a0aa, hardness: 0.05, seeThrough: true,
  },
  // A steel locker is as good as a wall, and beaten by the same one weapon.
  metal: { name: 'metal', resist: 3.5, soak: 4.5, color: 0x4a4e52, hardness: 0.9 },
  // Wet rooms are tiled, and tile behaves like the floor it is laid on: a
  // separate material only so the renderer can tell them apart.
  tile: { name: 'tile', resist: 0, color: 0x6d6b66, hardness: 1.0 },
  // Upholstery hides you and stops very little. Through the back of a sofa is
  // nearly free; through one lengthways is a marksman's job.
  fabric: { name: 'fabric', resist: 0.31, soak: 1.5, color: 0x3d3a42, hardness: 0.2 },
};

const WALL_H = 3.0;
const SLAB = 0.3;
const F2 = WALL_H + SLAB; // 3.3
const ROOF = F2 + WALL_H; // 6.3
const RAIL = 1.1; // parapet and railing height: cover standing, sight over it

function wall(x1, z1, x2, z2, material, opts = {}) {
  const t = opts.thickness ?? 0.12;
  const h = opts.height ?? WALL_H;
  const base = opts.base ?? 0;
  const gaps = opts.gaps ?? [];
  const doorTop = opts.doorTop ?? 2.1;
  const out = [];

  const horizontal = Math.abs(x2 - x1) > Math.abs(z2 - z1);
  const axis = horizontal ? 'x' : 'z';
  const from = horizontal ? Math.min(x1, x2) : Math.min(z1, z2);
  const to = horizontal ? Math.max(x1, x2) : Math.max(z1, z2);
  const fixed = horizontal ? z1 : x1;

  const push = (a, b, yBase, yTop) => {
    if (b - a < 1e-6 || yTop - yBase < 1e-6) return;
    const box = horizontal
      ? { min: { x: a, y: yBase, z: fixed - t / 2 }, max: { x: b, y: yTop, z: fixed + t / 2 } }
      : { min: { x: fixed - t / 2, y: yBase, z: a }, max: { x: fixed + t / 2, y: yTop, z: b } };
    out.push({ ...box, material, axis, ...(opts.tag ? { tag: opts.tag } : {}) });
  };

  const sorted = [...gaps].sort((g1, g2) => g1.at - g2.at);
  let cursor = from;
  for (const g of sorted) {
    push(cursor, g.at - g.width / 2, base, base + h);
    push(g.at - g.width / 2, g.at + g.width / 2, base + doorTop, base + h);
    cursor = g.at + g.width / 2;
  }
  push(cursor, to, base, base + h);
  return out;
}

function box(minX, minY, minZ, maxX, maxY, maxZ, material) {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ }, material };
}

const M = MATERIALS;

function slab(x1, z1, x2, z2) {
  return [
    { ...box(x1, WALL_H, z1, x2, F2 - 0.1, z2, M.concrete), layer: 'slab' },
    { ...box(x1, F2 - 0.1, z1, x2, F2, z2, M.floor), layer: 'slab' },
  ];
}

// A straight flight climbing `rise` metres over `steps` treads, from `zBottom`
// in direction `dir`. Used twice for the open switchback in the living court.
const TREAD = 0.30;
function flight({ x1, x2, zBottom, dir, steps, from = 0, rise }) {
  const step = rise / steps;
  const out = [];
  for (let i = 0; i < steps; i++) {
    const zA = zBottom + dir * i * TREAD;
    const zB = zA + dir * TREAD;
    out.push(box(x1, 0, Math.min(zA, zB), x2, from + (i + 1) * step, Math.max(zA, zB), M.floor));
  }
  return out;
}

// ── Shell ─────────────────────────────────────────────────────────────────
const shell = [
  box(-16.2, -0.5, -18.2, 16.2, 0, 9.7, M.floor),

  // Ground-floor outer walls. Along the open living court they drop to a
  // concrete parapet: the court is outdoors, and the parapet is what stops
  // anyone walking off the building.
  ...wall(-16, 6, 16, 6, M.concrete, { thickness: 0.3, height: WALL_H, gaps: [{ at: 0, width: 1.1 }] }),
  ...wall(-15.85, -18, -5, -18, M.concrete, { thickness: 0.3, height: RAIL, tag: 'parapet' }),
  ...wall(-5, -18, 16, -18, M.concrete, { thickness: 0.3, height: WALL_H }),
  ...wall(-16, -18, -16, -7.4, M.concrete, { thickness: 0.3, height: RAIL, tag: 'parapet' }),
  ...wall(-16, -7.4, -16, 6, M.concrete, { thickness: 0.3, height: WALL_H }),
  ...wall(16, -18, 16, 6, M.concrete, { thickness: 0.3, height: WALL_H }),

  // Upper-floor outer walls. Only the two terrace arms reach the shell up
  // here, and there they are parapets too.
  ...wall(-8, -18, -5, -18, M.concrete, { thickness: 0.3, base: F2, height: RAIL, tag: 'parapet' }),
  ...wall(-5, -18, 16, -18, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),
  ...wall(-16, -10.5, -16, -7.4, M.concrete, { thickness: 0.3, base: F2, height: RAIL, tag: 'parapet' }),
  ...wall(-16, -7.4, -16, 6, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),
  ...wall(-16, 6, 16, 6, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),
  ...wall(16, -18, 16, 6, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),

  // Entrance landing.
  ...wall(-3, 9.5, 3, 9.5, M.concrete, { thickness: 0.25 }),
  ...wall(-3, 6, -3, 9.5, M.concrete, { thickness: 0.25 }),
  ...wall(3, 6, 3, 9.5, M.concrete, { thickness: 0.25 }),
  { ...box(-3.2, WALL_H, 6.2, 3.2, F2, 9.7, M.concrete), layer: 'slab' },

  // ── Upper floor slab ──
  // Open to the sky over the living court, open over the east stairwell, and
  // punched through in the store, where you can drop into the bathroom below.
  ...slab(-8, -18.2, -5, -10.5), // terrace: east arm
  ...slab(-16.2, -10.5, -5, -7.4), // terrace: south arm and the corner
  ...slab(-16.2, -7.4, -5, 6.2), // the storey west of centre
  ...slab(-5, -18.2, 13.6, 6.2), // the whole middle and east
  ...slab(13.6, -18.2, 13.75, -7.4), // ...and, around the shaft, split by the
  ...slab(15.25, -18.2, 16.2, -7.4), //    hole punched through the store floor
  ...slab(13.75, -18.2, 15.25, -17.1),
  ...slab(13.75, -15.6, 15.25, -7.4),
  ...slab(13.6, 1, 16.2, 6.2), // south of the shaft

  // Roof: everything except the living court, which is open to the sky.
  box(-8, ROOF, -18.2, 16.2, ROOF + 0.3, 6.2, M.concrete),
  box(-16.2, ROOF, -7.4, -8, ROOF + 0.3, 6.2, M.concrete),
];

// ── Living court: open to the sky, with an open switchback stair ──────────
// Two flights and a half-landing, standing free in the court rather than shut
// in a shaft: the terrace above has a way down into the room below.
const courtStair = [
  // Up the west side, turn on the half-landing, up the east side to the
  // terrace. Each part touches the next and none of them overlap.
  ...flight({ x1: -12.4, x2: -10.9, zBottom: -11.0, dir: -1, steps: 8, rise: F2 / 2 }),
  box(-12.4, 0, -14.2, -9.2, F2 / 2, -13.4, M.floor), // half-landing
  ...flight({ x1: -10.7, x2: -9.2, zBottom: -13.4, dir: 1, steps: 8, from: F2 / 2, rise: F2 / 2 }),
  ...slab(-10.7, -11.0, -9.2, -10.5), // top step meets the terrace's south arm

  // Nothing else stands on the flights. Not a rail, not a plant, nothing: a
  // staircase is a route, and anything on it is something to get stuck on.
];

// ── Ground floor ─────────────────────────────────────────────────────────
const groundWalls = [
  // Living court ↔ the rooms east of it.
  ...wall(-5, -17.85, -5, -7.4, M.drywall, {
    gaps: [{ at: -15, width: 1.0 }, { at: -10, width: 1.0 }],
  }),

  // Spine, north side. The living court gets a double door, two metres wide.
  ...wall(-16, -7.4, 13.6, -7.4, M.drywall, {
    gaps: [
      { at: -9, width: 2.0 }, // double door, court ↔ corridor
      { at: -2, width: 1.0 },
      { at: 4, width: 1.0 },
      { at: 10.5, width: 1.0 },
    ],
  }),
  // Spine, south side. The cinema's double door faces the court's exactly.
  ...wall(-16, -4.6, 13.6, -4.6, M.drywall, {
    gaps: [
      { at: -9, width: 2.0 }, // double door, corridor ↔ cinema
      { at: 0, width: 1.0 }, // door into the hall
      { at: 8, width: 1.0 },
    ],
  }),

  // North rooms. Study and guest bedroom are one room now; so are the
  // bathroom and the utility.
  ...wall(7.5, -17.85, 7.5, -7.4, M.drywall, {
    gaps: [{ at: -9.5, width: 1.0 }, { at: -15, width: 1.0 }],
  }),
  ...wall(-5, -12.5, 7.5, -12.5, M.drywall, { gaps: [{ at: -2, width: 1.0 }] }),
  // Dining and kitchen keep their old wall and door.
  ...wall(1, -12.5, 1, -7.4, M.drywall, { gaps: [{ at: -10, width: 1.0 }] }),

  // South half. Cinema ↔ hall is walled up; the cloakroom is reached from the
  // cinema at both ends of its south wall.
  // Entrance hall ↔ cloakroom: a hole punched through, no door in it.
  ...wall(-3, -4.6, -3, 5.85, M.drywall, { gaps: [{ at: 3.5, width: 1.2 }] }),
  ...wall(3, -4.6, 3, 5.85, M.drywall, {
    gaps: [
      { at: -2, width: 1.0 }, // hall ↔ gym: kicked in, and something in the way
      { at: 3.5, width: 1.0 }, // ordinary door to the guest room
    ],
  }),
  ...wall(-16, 1.5, 3, 1.5, M.drywall, {
    gaps: [
      { at: -14, width: 1.0 }, // cinema ↔ cloakroom, west end
      { at: -5, width: 1.0 }, // cinema ↔ cloakroom, east end
      { at: 0, width: 1.6 }, // hall ↔ entrance hall, open archway
    ],
  }),
  ...wall(3, 0, 13.6, 0, M.drywall, { gaps: [{ at: 6, width: 1.4 }, { at: 11.5, width: 1.0 }] }),
  ...wall(9, 0, 9, 5.85, M.drywall, { gaps: [{ at: 3.5, width: 1.0 }] }),
];

// Things that are neither wall nor furniture: they shape the fight.
const blockers = [
  // Bar-height barrier where the bathroom/utility wall used to be: crouch and
  // you are gone, stand and you are seen.
  { ...box(7.5, 0, -12.65, 10.5, RAIL, -12.35, M.concrete), tag: 'barrier',
    note: 'Ограждение 3 м, высота 1.1 — присел и укрылся' },

  // The column left behind when the study and the guest bedroom became one.
  { ...box(0.4, 0, -15.8, 1.6, WALL_H, -14.6, M.concrete), tag: 'column',
    note: 'Колонна 1.2 × 1.2' },

  // The corridor is caved in between the hall door and the kitchen door, so
  // nobody walks its full length in a straight line: the way past is through
  // the rooms on either side.
  { ...box(1.2, 0, -7.4, 2.1, WALL_H, -5.6, M.concrete), tag: 'rubble',
    note: 'Завал: коридор не пройти насквозь' },
  { ...box(1.7, 0, -6.2, 2.6, WALL_H, -4.6, M.concrete), tag: 'rubble' },

  // Something small shoved into the kicked-in gym doorway: it stops you
  // walking through, and you can shoot over it and past it freely.
  { ...box(2.6, 0, -2.45, 3.4, 0.95, -1.55, M.wood), tag: 'blocked',
    note: 'Мешает пройти, но не мешает стрелять' },
];

// ── Upper floor ──────────────────────────────────────────────────────────
const upperWalls = [
  // Terrace: an L over the living court. Glass railings face the void.
  ...wall(-8, -17.85, -8, -10.5, M.glass, { base: F2, thickness: 0.1, height: RAIL, tag: 'railing' }),
  // ...with a gap where the court stair arrives, or the flight would climb
  // into a pane of glass.
  ...wall(-15.85, -10.5, -10.95, -10.5, M.glass, { base: F2, thickness: 0.1, height: RAIL, tag: 'railing' }),
  ...wall(-9.15, -10.5, -8.05, -10.5, M.glass, { base: F2, thickness: 0.1, height: RAIL, tag: 'railing' }),

  // Rooms east of the terrace open onto it through glass doors.
  ...wall(-5, -17.85, -5, -7.4, M.drywall, {
    base: F2, gaps: [{ at: -15, width: 1.0 }, { at: -10, width: 1.0 }],
  }),

  // Spine, north side. The corridor also opens onto the terrace, in glass.
  ...wall(-16, -7.4, 13.6, -7.4, M.drywall, {
    base: F2,
    gaps: [
      { at: -12, width: 1.0 }, // corridor ↔ terrace, glass
      { at: -3.5, width: 1.0 },
      { at: 2, width: 1.0 },
      { at: 9, width: 1.0 },
    ],
  }),
  // Spine, south side.
  ...wall(-16, -4.6, 13.6, -4.6, M.drywall, {
    base: F2,
    gaps: [{ at: -10, width: 1.0 }, { at: 2, width: 1.0 }, { at: 10, width: 1.0 }],
  }),

  // North rooms.
  ...wall(-1, -17.85, -1, -7.4, M.drywall, { base: F2, gaps: [{ at: -15, width: 1.0 }] }),
  ...wall(5, -17.85, 5, -12.5, M.drywall, { base: F2, gaps: [{ at: -15, width: 1.0 }] }),
  ...wall(9, -17.85, 9, -12.5, M.drywall, { base: F2, gaps: [{ at: -15, width: 1.0 }] }),
  ...wall(-5, -12.5, 16, -12.5, M.drywall, {
    base: F2,
    gaps: [
      { at: 2, width: 1.0 },
      { at: 7, width: 1.4 }, // bathroom ↔ laundry: open, no door
      { at: 11, width: 1.0 },
    ],
  }),

  // South half: the old terrace is the master suite now, and the lounge and
  // media room reach 1.5 m further west.
  ...wall(-3.5, -4.6, -3.5, 5.85, M.drywall, { base: F2, gaps: [{ at: -2, width: 1.0 }] }),
  ...wall(6, -4.6, 6, 5.85, M.drywall, { base: F2, gaps: [{ at: -2, width: 1.0 }, { at: 3.5, width: 1.4 }] }),
  ...wall(-16, 1, 13.6, 1, M.drywall, {
    base: F2,
    gaps: [{ at: -10, width: 1.0 }, { at: 2, width: 1.4 }, { at: 10, width: 1.0 }],
  }),
];

// ── East stairwell: unchanged, still a closed shaft ───────────────────────
const eastStair = [
  ...flight({ x1: 13.75, x2: 15.85, zBottom: -6.0, dir: 1, steps: 16, rise: F2 }),
  ...slab(13.6, -1.2, 15.85, 1),
  ...wall(13.6, -7.4, 13.6, 1, M.concrete, {
    thickness: 0.3, height: WALL_H, gaps: [{ at: -6.4, width: 1.0 }],
  }),
  ...wall(13.6, -7.4, 13.6, 1, M.concrete, {
    thickness: 0.3, base: WALL_H, height: WALL_H + SLAB, doorTop: SLAB + 2.1,
    gaps: [{ at: -0.7, width: 1.0 }],
  }),
  ...wall(13.6, -7.4, 16, -7.4, M.concrete, { thickness: 0.3, height: ROOF }),
  ...wall(13.6, 1, 16, 1, M.concrete, { thickness: 0.3, height: ROOF }),
];


// ── Furniture, built out of parts ─────────────────────────────────────────
//
// Every piece here used to be one solid block. A table was a metre of wood
// with nothing under it; a bookcase was a slab. That reads as a crate: you
// cannot see under anything, you cannot shoot under anything, and a room is a
// floor with cubes standing on it.
//
// So the things that really are frames are built as frames — a top on four
// legs, a carcass with shelves in it, a mattress on a base — and the things
// that really are solid, which is most of the cabinetry, stay solid. The
// footprints are the ones the blocks had, to the centimetre: you still walk
// round a table exactly as you did, because the top still spans it, and the
// two rules map-check enforces — nothing in a doorway or in the arc a door
// sweeps, and every door of a room reachable from every other — go on meaning
// what they meant. What changes is what a bullet and an eye find at knee
// height.

// Turn a piece of furniture where it stands.
//
// Everything a flat is furnished with used to be square to the building,
// because a box in this map is a pair of corners and a pair of corners has no
// angle in it. Now it can have one: every part of a piece swings about the
// same pivot and every part carries the same angle, so a table turned thirty
// degrees is a turned table rather than a top at thirty degrees over four legs
// still facing north.
//
// The whole engine understands this — bullets, footsteps, the walkable graph
// the bots read and the picture on screen all ask the box for its own frame
// and get the same answer. See `turnBox` and the helpers beside it in math.js.
function turn(parts, yaw, px, pz) {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  // No pivot given: turn it about the middle of its own footprint.
  if (px === undefined) {
    let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
    for (const b of parts) {
      x0 = Math.min(x0, b.min.x); x1 = Math.max(x1, b.max.x);
      z0 = Math.min(z0, b.min.z); z1 = Math.max(z1, b.max.z);
    }
    px = (x0 + x1) / 2;
    pz = (z0 + z1) / 2;
  }
  return parts.map((b) => {
    const dx = (b.min.x + b.max.x) / 2 - px;
    const dz = (b.min.z + b.max.z) / 2 - pz;
    const nx = px + dx * cos + dz * sin;
    const nz = pz - dx * sin + dz * cos;
    const hx = (b.max.x - b.min.x) / 2;
    const hz = (b.max.z - b.min.z) / 2;
    return turnBox({
      ...b,
      min: { x: nx - hx, y: b.min.y, z: nz - hz },
      max: { x: nx + hx, y: b.max.y, z: nz + hz },
    }, yaw);
  });
}

const LEG = 0.06;
// How far a shelf is let into the sides that carry it. A joint, not a gap:
// boards that only touch hold nothing up, and the map checks are right to say
// so. FACE is how far it then sits back from the front of the carcass, which
// is both what a bookcase looks like and what keeps two boards from drawing a
// face in the same place.
const HOUSE = 0.012;
const FACE = 0.012;

// A slab on four legs: tables, desks, consoles, benches.
function onLegs(x0, z0, x1, z1, y, o = {}) {
  const h = o.h ?? 0.75;
  const thick = o.thick ?? 0.045;
  const mat = o.mat ?? M.wood;
  const leg = o.leg ?? LEG;
  const inset = o.inset ?? 0.05;
  const out = [box(x0, y + h - thick, z0, x1, y + h, z1, mat)];
  for (const sx of [0, 1]) {
    for (const sz of [0, 1]) {
      const lx = sx ? x1 - inset - leg : x0 + inset;
      const lz = sz ? z1 - inset - leg : z0 + inset;
      out.push(box(lx, y, lz, lx + leg, y + h - thick, lz + leg, mat));
    }
  }
  return out;
}

// A desk is a table with somewhere to put your knees on one side and a
// pedestal of drawers on the other, which is what tells the two apart from
// across a room.
function desk(x0, z0, x1, z1, y, o = {}) {
  const h = o.h ?? 0.78;
  const mat = o.mat ?? M.wood;
  const out = onLegs(x0, z0, x1, z1, y, { h, mat });
  const w = x1 - x0;
  const px = o.pedestal === 'right' ? x1 - 0.44 : x0;
  if (w > 1.0) out.push(box(px, y + 0.06, z0 + 0.06, px + 0.44, y + h - 0.05, z1 - 0.06, mat));
  return out;
}

// A carcass with shelves in it: two sides, a top, a back panel and the
// shelves between them. Open at the front, which is the whole point — a
// bookcase you can see the wall through is not a wardrobe.
function shelves(x0, z0, x1, z1, y, o = {}) {
  const h = o.h ?? 1.85;
  const mat = o.mat ?? M.wood;
  const t = o.t ?? 0.04;
  const out = [];
  // `back` is the side that goes against the wall — the one you never see. Get
  // it wrong and a bookcase is a brown slab facing the room, which is exactly
  // the crate this was all meant to stop being.
  const back = o.back ?? ((x1 - x0) >= (z1 - z0) ? 's' : 'e');
  const alongX = back === 'n' || back === 's';
  let in0;
  if (alongX) {
    out.push(box(x0, y, z0, x0 + t, y + h, z1, mat));
    out.push(box(x1 - t, y, z0, x1, y + h, z1, mat));
    if (back === 's') {
      out.push(box(x0 + t, y, z1 - t, x1 - t, y + h, z1, mat));
      in0 = { x0: x0 + t - HOUSE, x1: x1 - t + HOUSE, z0: z0 + FACE, z1: z1 - t + HOUSE };
    } else {
      out.push(box(x0 + t, y, z0, x1 - t, y + h, z0 + t, mat));
      in0 = { x0: x0 + t - HOUSE, x1: x1 - t + HOUSE, z0: z0 + t - HOUSE, z1: z1 - FACE };
    }
  } else {
    out.push(box(x0, y, z0, x1, y + h, z0 + t, mat));
    out.push(box(x0, y, z1 - t, x1, y + h, z1, mat));
    if (back === 'e') {
      out.push(box(x1 - t, y, z0 + t, x1, y + h, z1 - t, mat));
      in0 = { x0: x0 + FACE, x1: x1 - t + HOUSE, z0: z0 + t - HOUSE, z1: z1 - t + HOUSE };
    } else {
      out.push(box(x0, y, z0 + t, x0 + t, y + h, z1 - t, mat));
      in0 = { x0: x0 + t - HOUSE, x1: x1 - FACE, z0: z0 + t - HOUSE, z1: z1 - t + HOUSE };
    }
  }
  const n = o.shelves ?? 4;
  // The top board stops a hair short of the top of the sides, for the same
  // reason the front does: two boards flush with each other draw one face
  // twice.
  for (let i = 0; i <= n; i++) {
    const sy = y + (h - t - FACE) * (i / n);
    out.push(box(in0.x0, sy, in0.z0, in0.x1, sy + t, in0.z1, mat));
  }
  return out;
}

// Cabinetry: solid, because it is. A plinth set back at the floor and a
// worktop overhanging the front are what stop it reading as a crate — and it
// stays cover, which a bookcase does not.
function cabinet(x0, z0, x1, z1, y, o = {}) {
  const h = o.h ?? 0.92;
  const mat = o.mat ?? M.wood;
  const top = o.top ?? 0.045;
  const plinth = o.plinth ?? 0.09;
  const set = 0.05;
  return [
    box(x0 + set, y, z0 + set, x1 - set, y + plinth, z1 - set, mat),
    box(x0, y + plinth, z0, x1, y + h - top, z1, mat),
    box(x0 - 0.015, y + h - top, z0 - 0.015, x1 + 0.015, y + h, z1 + 0.015, o.worktop ?? mat),
  ];
}

// A wardrobe: solid too, with a plinth, a cornice and a line down the middle
// where the doors meet.
function wardrobe(x0, z0, x1, z1, y, o = {}) {
  const h = o.h ?? 1.85;
  const mat = o.mat ?? M.wood;
  const out = cabinet(x0, z0, x1, z1, y, { h, mat, top: 0.05, plinth: 0.08 });
  const long = x1 - x0 > z1 - z0;
  const mid = long ? (x0 + x1) / 2 : (z0 + z1) / 2;
  // The handles, on the face that is not against a wall.
  const grip = 0.02;
  if (long) {
    out.push(box(mid - 0.09, y + 0.9, z0 - grip, mid - 0.05, y + 1.1, z0 + 0.02, M.metal));
    out.push(box(mid + 0.05, y + 0.9, z0 - grip, mid + 0.09, y + 1.1, z0 + 0.02, M.metal));
  } else {
    out.push(box(x0 - grip, y + 0.9, mid - 0.09, x0 + 0.02, y + 1.1, mid - 0.05, M.metal));
    out.push(box(x0 - grip, y + 0.9, mid + 0.05, x0 + 0.02, y + 1.1, mid + 0.09, M.metal));
  }
  return out;
}

// A bed: a base set in under the mattress, the mattress over it, and a
// headboard standing at one end. `head` is the side it stands on — the side
// against the wall.
function bed(x0, z0, x1, z1, y, o = {}) {
  const head = o.head ?? 'n';
  const baseH = o.baseH ?? 0.26;
  const matH = o.matH ?? 0.2;
  const headH = o.headH ?? 0.9;
  const t = 0.07;
  const b = { x0, z0, x1, z1 };
  const out = [];
  if (head === 'n') { out.push(box(x0, y, z0, x1, y + headH, z0 + t, M.wood)); b.z0 = z0 + t; }
  if (head === 's') { out.push(box(x0, y, z1 - t, x1, y + headH, z1, M.wood)); b.z1 = z1 - t; }
  if (head === 'w') { out.push(box(x0, y, z0, x0 + t, y + headH, z1, M.wood)); b.x0 = x0 + t; }
  if (head === 'e') { out.push(box(x1 - t, y, z0, x1, y + headH, z1, M.wood)); b.x1 = x1 - t; }
  out.push(box(b.x0 + 0.05, y, b.z0 + 0.05, b.x1 - 0.05, y + baseH, b.z1 - 0.05, M.wood));
  out.push(box(b.x0, y + baseH, b.z0, b.x1, y + baseH + matH, b.z1, M.fabric));
  return out;
}

// Seating: a base, a back along one side, an arm at each end. Upholstery, so
// it hides you and stops very little — which is what the penetration table
// already says about fabric.
function sofa(x0, z0, x1, z1, y, o = {}) {
  const back = o.back ?? 'n';
  const h = o.h ?? 0.85;
  const seat = o.seat ?? 0.42;
  const t = 0.16;
  const b = { x0, z0, x1, z1 };
  const out = [];
  if (back === 'n') { out.push(box(x0, y, z0, x1, y + h, z0 + t, M.fabric)); b.z0 = z0 + t; }
  if (back === 's') { out.push(box(x0, y, z1 - t, x1, y + h, z1, M.fabric)); b.z1 = z1 - t; }
  if (back === 'w') { out.push(box(x0, y, z0, x0 + t, y + h, z1, M.fabric)); b.x0 = x0 + t; }
  if (back === 'e') { out.push(box(x1 - t, y, z0, x1, y + h, z1, M.fabric)); b.x1 = x1 - t; }
  const along = back === 'n' || back === 's';
  if (o.arms !== false) {
    const arm = 0.14;
    const armH = y + seat + 0.16;
    if (along) {
      out.push(box(b.x0, y, b.z0, b.x0 + arm, armH, b.z1, M.fabric));
      out.push(box(b.x1 - arm, y, b.z0, b.x1, armH, b.z1, M.fabric));
      b.x0 += arm; b.x1 -= arm;
    } else {
      out.push(box(b.x0, y, b.z0, b.x1, armH, b.z0 + arm, M.fabric));
      out.push(box(b.x0, y, b.z1 - arm, b.x1, armH, b.z1, M.fabric));
      b.z0 += arm; b.z1 -= arm;
    }
  }
  // The frame under the cushion. Without it the seat floats, which the map
  // checks catch and the eye catches sooner.
  out.push(box(b.x0 + 0.04, y, b.z0 + 0.04, b.x1 - 0.04, y + 0.1, b.z1 - 0.04, M.wood));
  out.push(box(b.x0, y + 0.1, b.z0, b.x1, y + seat, b.z1, M.fabric));
  return out;
}

// A chair. Six small parts, and the reason a table with four of them round it
// reads as a dining room rather than a slab in a field.
function chair(cx, cz, y, o = {}) {
  const half = 0.22;
  const seat = o.seat ?? 0.45;
  const backH = o.backH ?? 0.92;
  const facing = o.facing ?? 'n'; // which way the back is
  const out = [
    box(cx - half, y + seat - 0.04, cz - half, cx + half, y + seat, cz + half, M.wood),
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = cx + sx * (half - 0.05) - 0.02;
      const lz = cz + sz * (half - 0.05) - 0.02;
      out.push(box(lx, y, lz, lx + 0.04, y + seat - 0.04, lz + 0.04, M.wood));
    }
  }
  const t = 0.04;
  if (facing === 'n') out.push(box(cx - half, y + seat, cz - half, cx + half, y + backH, cz - half + t, M.wood));
  if (facing === 's') out.push(box(cx - half, y + seat, cz + half - t, cx + half, y + backH, cz + half, M.wood));
  if (facing === 'w') out.push(box(cx - half, y + seat, cz - half, cx - half + t, y + backH, cz + half, M.wood));
  if (facing === 'e') out.push(box(cx + half - t, y + seat, cz - half, cx + half, y + backH, cz + half, M.wood));
  return out;
}

// A stack of crates, and the only thing in the flat that is meant to look
// like a pile of boxes.
function crates(x0, z0, x1, z1, y, o = {}) {
  const h = o.h ?? 0.9;
  const lid = h / 2;
  return [
    box(x0, y, z0, x1, y + lid, z1, M.wood),
    box(x0 + 0.1, y + lid, z0 + 0.06, x1 - 0.18, y + h, z1 - 0.1, M.wood),
  ];
}

// A run of lockers: one carcass with the seams between the doors cut into it.
function lockers(x0, z0, x1, z1, y, o = {}) {
  const h = o.h ?? 1.85;
  const out = [box(x0, y, z0, x1, y + h, z1, M.metal)];
  const long = x1 - x0 > z1 - z0;
  const span = long ? x1 - x0 : z1 - z0;
  const n = Math.max(2, Math.round(span / 0.45));
  for (let i = 1; i < n; i++) {
    const at = (long ? x0 : z0) + (span * i) / n;
    // A rib standing a centimetre proud, which is all a seam needs to be.
    if (long) out.push(box(at - 0.01, y + 0.06, z0 - 0.012, at + 0.01, y + h - 0.06, z0 + 0.02, M.metal));
    else out.push(box(x0 - 0.012, y + 0.06, at - 0.01, x0 + 0.02, y + h - 0.06, at + 0.01, M.metal));
  }
  return out;
}

const furniture = ([
  // ── Ground floor ──
  // Open court: a bench and a planter along the parapet, clear of the stair.
  ...turn(onLegs(-15.6, -16.6, -14.4, -13.6, 0, { h: 0.45 }), 0.2),
  ...cabinet(-7.6, -9.4, -6.0, -8.6, 0, { h: 0.5, plinth: 0.06 }), // planter

  // Study + guest bedroom (one room, column in the middle).
  ...desk(-4.4, -17.6, -1.9, -16.8, 0, { pedestal: 'right' }),
  ...chair(-3.1, -16.3, 0, { facing: 's' }),
  ...shelves(3.0, -17.7, 5.5, -17.1, 0, { back: 'n' }), // bookcase, north wall
  ...bed(5.6, -17.6, 7.2, -15.8, 0, { head: 'n' }), // against the east wall

  // Dining: a table in the middle — you walk round it, not through it — with
  // four chairs to say what it is for, and the whole set stood at an angle to
  // the room the way a table that people actually sit at ends up.
  ...turn([
    ...onLegs(-3.4, -10.7, -1.2, -9.7, 0),
    ...chair(-3.0, -11.15, 0, { facing: 'n' }),
    ...chair(-1.6, -11.15, 0, { facing: 'n' }),
    ...chair(-3.0, -9.25, 0, { facing: 's' }),
    ...chair(-1.6, -9.25, 0, { facing: 's' }),
  ], 0.34),
  ...wardrobe(-4.7, -12.2, -3.7, -11.0, 0), // sideboard in the corner

  // Kitchen: counter and fridge on the north wall, island off-centre.
  ...cabinet(1.4, -12.3, 6.4, -11.7, 0, { worktop: M.tile }),
  ...cabinet(6.6, -12.3, 7.3, -11.3, 0, { h: 1.85, mat: M.metal, plinth: 0.06 }), // fridge
  ...cabinet(2.6, -10.4, 4.4, -9.6, 0, { worktop: M.tile }), // island

  // Bathroom + utility, split by the bar-height barrier.
  ...cabinet(8.2, -17.6, 10.4, -17.0, 0, { h: 0.9, mat: M.metal, worktop: M.tile }),
  ...shelves(15.1, -16.0, 15.8, -13.4, 0, { mat: M.metal, shelves: 5, back: 'e' }),
  ...turn(crates(12.0, -10.6, 13.2, -9.4, 0), 0.42),

  // Cinema: two rows of seating and a low cabinet under the screen.
  ...sofa(-14.0, -2.7, -11.0, -2.0, 0, { back: 'n', arms: false }),
  ...sofa(-14.0, -1.1, -11.0, -0.4, 0, { back: 'n', arms: false }),
  ...cabinet(-7.0, -4.3, -4.6, -3.7, 0, { h: 0.6 }),

  // Hall: a bench near the west wall, out of every doorway and stood at a
  // slight angle, because nobody lines a bench up with a wall to the degree.
  ...turn(onLegs(-2.8, -1.2, -2.2, 0.8, 0, { h: 0.45 }), 0.12),

  // Gym: two uprights on their feet with a bar racked across them, mats, a
  // bench. The footprint is the block's; the middle of it is now air.
  box(4.94, 0, -4.4, 5.30, 0.14, -3.9, M.metal),
  box(7.10, 0, -4.4, 7.46, 0.14, -3.9, M.metal),
  box(5.00, 0.14, -4.35, 5.24, 1.3, -3.95, M.metal),
  box(7.16, 0.14, -4.35, 7.40, 1.3, -3.95, M.metal),
  box(5.23, 1.06, -4.24, 7.17, 1.14, -4.06, M.metal),
  box(9.0, 0, -2.6, 12.0, 0.15, -1.2, M.fabric), // mats
  ...turn(onLegs(4.2, -1.7, 5.6, -1.1, 0, { h: 0.5 }), -0.5),

  // Cloakroom: lockers on the south wall, bench in the middle.
  ...lockers(-14.0, 5.2, -9.0, 5.7, 0),
  ...onLegs(-12.0, 3.3, -10.0, 3.9, 0, { h: 0.45 }),

  // Entrance hall: shoe bench and console, both clear of the front door.
  ...onLegs(2.1, 4.6, 2.8, 5.6, 0, { h: 0.45 }),
  ...onLegs(-2.8, 1.9, -2.2, 2.9, 0, { h: 0.8 }),

  // Guest room by the entrance hall.
  ...bed(4.4, 0.3, 6.4, 2.4, 0, { head: 'n' }),
  ...wardrobe(8.2, 0.3, 8.8, 2.0, 0),

  // Spa.
  ...onLegs(15.1, 1.5, 15.8, 4.5, 0, { h: 0.5 }),
  ...cabinet(12.5, 4.2, 14.5, 5.5, 0, { h: 0.6, mat: M.metal, worktop: M.tile }), // tub

  // ── Upper floor ──
  // Terrace: loungers along the parapet, nothing near the glass doors.
  ...onLegs(-15.6, -9.9, -13.2, -9.1, F2, { h: 0.5, thick: 0.12 }),
  ...turn(onLegs(-7.6, -16.8, -6.2, -14.4, F2, { h: 0.5, thick: 0.12 }), 0.55),

  // Bedroom 2.
  ...bed(-4.4, -17.6, -2.6, -15.7, F2, { head: 'n' }),
  ...wardrobe(-1.9, -13.4, -1.3, -12.4, F2),

  // Dressing room: a run of wardrobes along the north wall.
  ...wardrobe(-4.6, -12.3, -1.4, -11.7, F2),

  // Bedroom 3 — the defenders' room, kept roomy.
  ...bed(1.2, -17.6, 3.2, -15.7, F2, { head: 'n' }),
  ...onLegs(3.7, -12.9, 4.9, -12.6, F2, { h: 0.78 }),

  // Study.
  ...desk(-0.6, -12.3, 1.6, -11.5, F2),
  ...chair(0.5, -10.9, F2, { facing: 'n' }),
  ...shelves(3.4, -12.3, 4.6, -11.9, F2, { h: 1.8, back: 'n' }),

  // Bathroom and store.
  ...cabinet(5.3, -17.6, 7.0, -17.0, F2, { h: 0.9, mat: M.metal, worktop: M.tile }),
  ...shelves(9.3, -17.6, 9.9, -16.2, F2, { back: 'e' }), // clear of the hole
  ...cabinet(12.6, -14.4, 13.8, -13.2, F2, { h: 0.9 }),

  // Laundry: two machines standing side by side.
  ...cabinet(5.4, -12.3, 6.6, -11.6, F2, { h: 1.0, mat: M.metal }),
  ...cabinet(6.8, -12.3, 8.0, -11.6, F2, { h: 1.0, mat: M.metal }),

  // Master bedroom and bathroom.
  ...bed(-13.0, -3.2, -10.6, -1.0, F2, { head: 'n' }), // clear of the door arc
  ...cabinet(-15.7, -3.5, -15.1, -1.5, F2, { h: 0.9 }), // dresser
  ...cabinet(-15.6, 4.4, -13.6, 5.6, F2, { h: 0.6, mat: M.metal, worktop: M.tile }), // tub
  ...cabinet(-14.4, 1.3, -12.0, 1.9, F2, { h: 0.9, mat: M.metal, worktop: M.tile }),

  // Upper lounge and media room.
  ...sofa(-2.4, -1.4, 0.4, -0.6, F2, { back: 'n' }),
  // An armchair pulled round to face the screen rather than the wall.
  ...turn(sofa(1.1, -0.9, 1.9, -0.1, F2, { back: 'n', h: 0.8, arms: true }), -0.7),
  ...cabinet(3.9, -4.3, 5.5, -3.7, F2, { h: 0.95, worktop: M.tile }), // bar counter
  ...sofa(-2.6, 4.2, 0.6, 5.2, F2, { back: 's', h: 0.8 }),
  ...cabinet(3.2, 1.3, 5.4, 1.9, F2, { h: 0.6 }), // media cabinet

  // Sauna and office.
  ...onLegs(6.4, -4.4, 8.4, -3.8, F2, { h: 0.45, thick: 0.1 }),
  // Angled into the corner, and kept back from the doorway: a door that
  // shoves somebody out of its way has to have somewhere to put them.
  ...turn([
    ...desk(6.6, 2.7, 8.7, 3.7, F2, { pedestal: 'right' }),
    ...chair(7.4, 4.4, F2, { facing: 's' }),
  ], -0.16),
  ...shelves(14.6, 3.0, 15.8, 5.0, F2, { h: 1.8, back: 'e' }),
// Tagged so the floor plans can draw it and the checks can tell it from a wall.
]).map((b) => ({ ...b, tag: 'furniture' }));

const doors = [
  {
    id: 'front', pos: { x: 0, z: 6 }, axis: 'x', width: 1.1, hinge: -1, swing: -1,
    frame: 0.3, material: M.metal, reinforced: true, health: 220, locked: true,
  },

  // ── Ground floor ──
  // Double doors: two leaves in one two-metre opening, hinged at both jambs.
  { id: 'court-spine-L', pos: { x: -9.5, z: -7.4 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood, pair: 'double' },
  { id: 'court-spine-R', pos: { x: -8.5, z: -7.4 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood, pair: 'double' },
  { id: 'cinema-spine-L', pos: { x: -9.5, z: -4.6 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood, pair: 'double' },
  { id: 'cinema-spine-R', pos: { x: -8.5, z: -4.6 }, axis: 'x', width: 1.0, hinge: 1, swing: 1, material: M.wood, pair: 'double' },

  { id: 'dining-spine', pos: { x: -2, z: -7.4 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'kitchen-spine', pos: { x: 4, z: -7.4 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood },
  { id: 'utility-spine', pos: { x: 10.5, z: -7.4 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'gym-spine', pos: { x: 8, z: -4.6 }, axis: 'x', width: 1.0, hinge: 1, swing: 1, material: M.wood },
  { id: 'hall-spine', pos: { x: 0, z: -4.6 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'dining-kitchen', pos: { x: 1, z: -10 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'foyer-guest', pos: { x: 3, z: 3.5 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood },

  { id: 'court-study', pos: { x: -5, z: -15 }, axis: 'z', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'court-dining', pos: { x: -5, z: -10 }, axis: 'z', width: 1.0, hinge: -1, swing: -1, material: M.wood },
  { id: 'dining-study', pos: { x: -2, z: -12.5 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood },
  { id: 'kitchen-utility', pos: { x: 7.5, z: -9.5 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood },
  { id: 'study-bath', pos: { x: 7.5, z: -15 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood },

  { id: 'cinema-cloak-w', pos: { x: -14, z: 1.5 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'cinema-cloak-e', pos: { x: -5, z: 1.5 }, axis: 'x', width: 1.0, hinge: 1, swing: 1, material: M.wood },
  // Kicked in before the round even starts, and blocked by the wardrobe.
  { id: 'hall-gym', pos: { x: 3, z: -2 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood, startsForced: true },
  { id: 'gym-spa', pos: { x: 11.5, z: 0 }, axis: 'x', width: 1.0, hinge: 1, swing: 1, material: M.wood },
  { id: 'guest-spa', pos: { x: 9, z: 3.5 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'stair-e-1', pos: { x: 13.6, z: -6.4 }, axis: 'z', width: 1.0, frame: 0.3, hinge: 1, swing: -1, material: M.wood },

  // ── Upper floor ──
  { id: 'terrace-spine', pos: { x: -12, z: -7.4 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.glass, health: 2, y: F2 },
  { id: 'terrace-bed2', pos: { x: -5, z: -15 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.glass, health: 2, y: F2 },
  { id: 'terrace-wardrobe', pos: { x: -5, z: -10 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.glass, health: 2, y: F2 },
  { id: 'wardrobe-spine', pos: { x: -3.5, z: -7.4 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood, y: F2 },
  { id: 'study2-spine', pos: { x: 2, z: -7.4 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood, y: F2 },
  { id: 'laundry-spine', pos: { x: 9, z: -7.4 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood, y: F2 },
  { id: 'master-spine', pos: { x: -10, z: -4.6 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'lounge-spine', pos: { x: 2, z: -4.6 }, axis: 'x', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'sauna-spine', pos: { x: 10, z: -4.6 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'bed2-bed3', pos: { x: -1, z: -15 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'bed3-bath', pos: { x: 5, z: -15 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'bath-store', pos: { x: 9, z: -15 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'study2-bed3', pos: { x: 2, z: -12.5 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood, y: F2 },
  { id: 'laundry-store', pos: { x: 11, z: -12.5 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood, y: F2 },
  { id: 'master-lounge', pos: { x: -3.5, z: -2 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'master-bath2', pos: { x: -10, z: 1 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'lounge-sauna', pos: { x: 6, z: -2 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'sauna-office', pos: { x: 10, z: 1 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'stair-e-2', pos: { x: 13.6, z: -0.7 }, axis: 'z', width: 1.0, frame: 0.3, hinge: -1, swing: 1, material: M.wood, y: F2 },
];

// Where the floor is missing on purpose: the court is open to the sky, and
// the store has a hole punched through into the bathroom below.
const holes = [
  { id: 'store-hole', floor: 1, x: 14.5, z: -16.35, r: 0.75,
    note: 'Пролом в полу ⌀1.5 — падение в санузел, обратно не забраться' },
];

// ── The mains ─────────────────────────────────────────────────────────────
//
// The consumer unit for the whole flat, where a consumer unit actually lives:
// outside, on the terrace wall, a couple of metres west of the corridor doors.
// Outdoors is what makes it a fight — it is reachable from the stairs without
// crossing the flat, and it is in the open once you are there.
//
// The cabinet is set two centimetres into the wall so no two faces are drawn
// on the same plane, and it stands at chest height, which is where the handle
// of one is.
const BREAKER = { x: -14.55, y: F2 + 1.4, z: -7.52 };
const mains = [
  box(BREAKER.x - 0.3, BREAKER.y - 0.4, -7.60, BREAKER.x + 0.3, BREAKER.y + 0.4, -7.44, M.metal),
];

const switches = [
  {
    id: 'mains',
    name: 'Электрощит',
    pos: { ...BREAKER },
    // The face you can reach it from: out onto the terrace, away from the wall.
    face: { x: 0, z: -1 },
    floor: 1,
  },
];

// Ways through that are not doors, called out on the plan.
const openings = [
  { id: 'foyer-breach', floor: 0, x: -3, z: 3.5, w: 1.2, note: 'Пролом в стене: прихожая ↔ гардеробная' },
  { id: 'bath-laundry', floor: 1, x: 7, z: -12.5, w: 1.4, note: 'Открытый проход, без двери' },
  { id: 'hall-arch', floor: 0, x: 0, z: 1.5, w: 1.6, note: 'Открытая арка' },
];

const L1 = 2.65;
const L2 = F2 + 2.65;
const lights = [
  // ── Ground floor ──
  // The court has no ceiling, so it has lamp posts: two of them, at opposite
  // ends, because a courtyard lit from one side is half a courtyard.
  { id: 'court-n', pos: { x: -14.2, y: 3.0, z: -15.6 }, radius: 16, color: 0x9fb4c8, intensity: 3.0, mount: 'post', base: 0 },
  { id: 'court-s', pos: { x: -6.4, y: 3.0, z: -8.6 }, radius: 16, color: 0x9fb4c8, intensity: 3.0, mount: 'post', base: 0 },

  { id: 'study', pos: { x: -1.5, y: L1, z: -15.2 }, radius: 9, color: 0xffd9a8, intensity: 1.2 },
  { id: 'guest-bed', pos: { x: 4.5, y: L1, z: -15.2 }, radius: 8, color: 0xffc890, intensity: 1.0 },
  { id: 'dining', pos: { x: -2, y: L1, z: -10 }, radius: 8, color: 0xffd9a8, intensity: 1.2 },
  { id: 'kitchen', pos: { x: 4, y: L1, z: -10 }, radius: 8, color: 0xfff0d0, intensity: 1.3 },
  { id: 'bathroom', pos: { x: 11.5, y: L1, z: -15.2 }, radius: 8, color: 0xd8e8ff, intensity: 1.0 },
  { id: 'utility', pos: { x: 11.5, y: L1, z: -9.8 }, radius: 8, color: 0xfff0d0, intensity: 1.0 },
  { id: 'spine-w', pos: { x: -7, y: L1, z: -6 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'spine-e', pos: { x: 7, y: L1, z: -6 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'cinema', pos: { x: -9, y: L1, z: -1.5 }, radius: 9, color: 0xffc890, intensity: 0.9 },
  { id: 'gallery', pos: { x: 0, y: L1, z: -1.5 }, radius: 7, color: 0xffd9a8, intensity: 1.1 },
  { id: 'gym', pos: { x: 8, y: L1, z: -2.3 }, radius: 9, color: 0xfff0d0, intensity: 1.1 },
  { id: 'cloakroom', pos: { x: -9, y: L1, z: 3.7 }, radius: 9, color: 0xffc890, intensity: 0.9 },
  { id: 'foyer', pos: { x: 0, y: L1, z: 3.7 }, radius: 7, color: 0xffd9a8, intensity: 1.2 },
  { id: 'guest-suite', pos: { x: 6, y: L1, z: 3.4 }, radius: 8, color: 0xffc890, intensity: 1.0 },
  { id: 'spa', pos: { x: 12.5, y: L1, z: 3.4 }, radius: 8, color: 0xd8e8ff, intensity: 1.0 },
  { id: 'landing', pos: { x: 0, y: L1, z: 8 }, radius: 7, color: 0x9fb4c8, intensity: 0.8 },
  { id: 'stair-e', pos: { x: 14.8, y: ROOF - 0.3, z: -6.5 }, radius: 18, color: 0xd8e8ff, intensity: 7.0, ceiling: ROOF, storey: 'both' },

  // ── Upper floor ──
  // The terrace is outdoors too: posts by the parapet, a bracket over the
  // corridor door.
  { id: 'terrace-post', pos: { x: -13.5, y: F2 + 2.2, z: -8.6 }, radius: 10, color: 0x9fb4c8, intensity: 1.0, mount: 'post', base: F2 },
  { id: 'terrace-door', pos: { x: -12, y: F2 + 2.3, z: -7.7 }, radius: 7, color: 0xd8e8ff, intensity: 0.8, mount: 'wall', face: { x: 0, z: -1 } },
  { id: 'bed2', pos: { x: -3, y: L2, z: -15.2 }, radius: 8, color: 0xffc890, intensity: 1.0 },
  { id: 'bed3', pos: { x: 2, y: L2, z: -15.2 }, radius: 9, color: 0xffc890, intensity: 1.1 },
  { id: 'kids-bath', pos: { x: 7, y: L2, z: -15.2 }, radius: 7, color: 0xd8e8ff, intensity: 1.0 },
  { id: 'store', pos: { x: 11.5, y: L2, z: -15.2 }, radius: 8, color: 0xfff0d0, intensity: 0.9 },
  { id: 'wardrobe', pos: { x: -3, y: L2, z: -9.9 }, radius: 7, color: 0xffd9a8, intensity: 1.0 },
  { id: 'study2', pos: { x: 2, y: L2, z: -9.9 }, radius: 8, color: 0xfff0d0, intensity: 1.0 },
  { id: 'laundry', pos: { x: 10, y: L2, z: -9.9 }, radius: 9, color: 0xfff0d0, intensity: 1.0 },
  { id: 'spine2-w', pos: { x: -6, y: L2, z: -6 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'spine2-e', pos: { x: 7, y: L2, z: -6 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'master', pos: { x: -10, y: L2, z: -2 }, radius: 10, color: 0xffc890, intensity: 1.2 },
  { id: 'master-bath', pos: { x: -10, y: L2, z: 3.4 }, radius: 9, color: 0xd8e8ff, intensity: 1.0 },
  { id: 'lounge', pos: { x: 1.5, y: L2, z: -2 }, radius: 9, color: 0xffd9a8, intensity: 1.2 },
  { id: 'media', pos: { x: 1.5, y: L2, z: 3.4 }, radius: 8, color: 0xffc890, intensity: 0.9 },
  { id: 'sauna', pos: { x: 10, y: L2, z: -2 }, radius: 9, color: 0xfff0d0, intensity: 1.0 },
  { id: 'office', pos: { x: 11.5, y: L2, z: 3.4 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
];

const rooms = [
  // ── Ground floor ──
  { id: 'court', name: 'Гостиная-двор (без крыши)', floor: 0, open: true, min: { x: -16, z: -17.85 }, max: { x: -5, z: -7.4 } },
  { id: 'study', name: 'Кабинет + гостевая', floor: 0, min: { x: -5, z: -17.85 }, max: { x: 7.5, z: -12.5 } },
  { id: 'bathroom', name: 'Санузел + подсобная', floor: 0, min: { x: 7.5, z: -17.85 }, max: { x: 16, z: -7.4 } },
  { id: 'dining', name: 'Столовая', floor: 0, min: { x: -5, z: -12.5 }, max: { x: 1, z: -7.4 } },
  { id: 'kitchen', name: 'Кухня', floor: 0, min: { x: 1, z: -12.5 }, max: { x: 7.5, z: -7.4 } },
  { id: 'spine-0', name: 'Коридор', floor: 0, split: true, min: { x: -16, z: -7.4 }, max: { x: 13.6, z: -4.6 } },
  { id: 'cinema', name: 'Кинозал', floor: 0, min: { x: -16, z: -4.6 }, max: { x: -3, z: 1.5 } },
  { id: 'gallery', name: 'Холл', floor: 0, min: { x: -3, z: -4.6 }, max: { x: 3, z: 1.5 } },
  { id: 'gym', name: 'Спортзал', floor: 0, min: { x: 3, z: -4.6 }, max: { x: 13.6, z: 0 } },
  { id: 'cloakroom', name: 'Гардеробная', floor: 0, min: { x: -16, z: 1.5 }, max: { x: -3, z: 5.85 } },
  { id: 'foyer', name: 'Прихожая', floor: 0, min: { x: -3, z: 1.5 }, max: { x: 3, z: 5.85 } },
  { id: 'guest-suite', name: 'Гостевая у прихожей', floor: 0, min: { x: 3, z: 0 }, max: { x: 9, z: 5.85 } },
  { id: 'spa', name: 'СПА', floor: 0, min: { x: 9, z: 0 }, max: { x: 16, z: 5.85 } },
  { id: 'landing', name: 'Площадка', floor: 0, outside: true, min: { x: -3, z: 6 }, max: { x: 3, z: 9.5 } },
  { id: 'shaft-e', name: 'Лестница В', floor: 0, shaft: true, min: { x: 13.6, z: -7.4 }, max: { x: 16, z: 1 } },

  // ── Upper floor ──
  { id: 'terrace-e', name: 'Терраса (крыло)', floor: 1, open: true, min: { x: -8, z: -17.85 }, max: { x: -5, z: -10.5 } },
  { id: 'terrace-s', name: 'Терраса', floor: 1, open: true, min: { x: -16, z: -10.5 }, max: { x: -5, z: -7.4 } },
  { id: 'void', name: 'Открыто вниз, в гостиную', floor: 1, hole: true, min: { x: -16, z: -17.85 }, max: { x: -8, z: -10.5 } },
  { id: 'bed2', name: 'Спальня 2', floor: 1, min: { x: -5, z: -17.85 }, max: { x: -1, z: -12.5 } },
  { id: 'wardrobe', name: 'Гардероб', floor: 1, min: { x: -5, z: -12.5 }, max: { x: -1, z: -7.4 } },
  { id: 'bed3', name: 'Спальня 3 (спавн обороны)', floor: 1, min: { x: -1, z: -17.85 }, max: { x: 5, z: -12.5 } },
  { id: 'study2', name: 'Кабинет', floor: 1, min: { x: -1, z: -12.5 }, max: { x: 5, z: -7.4 } },
  { id: 'kids-bath', name: 'Санузел', floor: 1, min: { x: 5, z: -17.85 }, max: { x: 9, z: -12.5 } },
  { id: 'store', name: 'Кладовая', floor: 1, min: { x: 9, z: -17.85 }, max: { x: 16, z: -12.5 } },
  { id: 'laundry', name: 'Прачечная', floor: 1, min: { x: 5, z: -12.5 }, max: { x: 16, z: -7.4 } },
  { id: 'spine-1', name: 'Коридор', floor: 1, min: { x: -16, z: -7.4 }, max: { x: 13.6, z: -4.6 } },
  { id: 'master', name: 'Спальня хозяев', floor: 1, min: { x: -16, z: -4.6 }, max: { x: -3.5, z: 1 } },
  { id: 'master-bath', name: 'Ванная хозяев', floor: 1, min: { x: -16, z: 1 }, max: { x: -3.5, z: 5.85 } },
  { id: 'lounge', name: 'Гостиная', floor: 1, min: { x: -3.5, z: -4.6 }, max: { x: 6, z: 1 } },
  { id: 'media', name: 'Медиа', floor: 1, min: { x: -3.5, z: 1 }, max: { x: 6, z: 5.85 } },
  { id: 'sauna', name: 'Сауна', floor: 1, min: { x: 6, z: -4.6 }, max: { x: 16, z: 1 } },
  { id: 'office', name: 'Кабинет 2', floor: 1, min: { x: 6, z: 1 }, max: { x: 16, z: 5.85 } },
  { id: 'shaft-e-top', name: 'Лестница В', floor: 1, shaft: true, min: { x: 13.6, z: -7.4 }, max: { x: 16, z: 1 } },
];

// ── Tiled floors ──────────────────────────────────────────────────────────
//
// Wet rooms and the kitchen are laid in porcelain, not parquet. The tile is
// cut from the room table above rather than typed out a second time, and it
// goes *into* the slab — the top thirty millimetres of it, standing five
// millimetres proud the way tile stands proud of the screed it is bedded on.
// Five millimetres is nothing to walk over, and it keeps the two surfaces off
// the same plane, which is what map-check is there to catch.
const TILED = ['kitchen', 'bathroom', 'spa', 'kids-bath', 'master-bath', 'laundry'];

const tiledFloors = rooms
  .filter((r) => TILED.includes(r.id))
  .map((r) => {
    const base = r.floor === 1 ? F2 : 0;
    return box(r.min.x, base - 0.03, r.min.z, r.max.x, base + 0.005, r.max.z, M.tile);
  });

// Everything you can walk into, shoot at or stand on. Assembled here rather
// than inside the map object below, because the decoration that follows has to
// be able to find the walls it hangs on.
const solid = [
  ...shell, ...courtStair, ...groundWalls, ...upperWalls, ...eastStair,
  ...blockers, ...furniture, ...tiledFloors, ...mains,
];

// ── Decoration ────────────────────────────────────────────────────────────
//
// Drawn and nothing else. None of this is in `geometry`, so the simulation
// never sees it: no collision, no bullets stopped, no place in the walkable
// graph, nothing for a bot to path around. It exists to stop rooms reading as
// empty boxes with furniture in them.
//
// One rule, and it is the whole reason this list is safe: **nothing here may
// look like something you could hide behind.** Everything is flat against a
// wall, hanging from a ceiling, lying on a floor, or small enough that no
// player would ever mistake it for cover. A picture you cannot shoot through
// is a lie; a picture you would never try to shoot through is furniture for
// the eye.
const DECO = {
  canvas: { name: 'deco-canvas', color: 0x6b7484 },
  paper: { name: 'deco-paper', color: 0xb9b2a4 },
  frame: { name: 'deco-frame', color: 0x2a221a },
  leaf: { name: 'deco-leaf', color: 0x3f5a3a },
  pot: { name: 'deco-pot', color: 0x6d5a4a },
  cloth: { name: 'deco-cloth', color: 0x2f333c },
  rug: { name: 'deco-rug', color: 0x4a4038 },
  screen: { name: 'deco-screen', color: 0x0e1114 },
  chrome: { name: 'deco-chrome', color: 0x8b929c },
  cable: { name: 'deco-cable', color: 0x14161a },
};

// Where the wall behind a point is. `face` is the way a thing looks, so the
// search runs the other way until it meets something solid — which means the
// caller only has to say roughly where in the room it is and which way it
// faces, and nothing ends up buried in the plaster because a coordinate was
// out by ten centimetres.
function wallBehind(x, y, z, face) {
  const back = { n: [0, 1], s: [0, -1], w: [1, 0], e: [-1, 0] }[face];
  for (let d = 0; d < 3; d += 0.02) {
    const px = x + back[0] * d;
    const pz = z + back[1] * d;
    const hit = solid.find((b) => px > b.min.x && px < b.max.x
      && y > b.min.y && y < b.max.y && pz > b.min.z && pz < b.max.z);
    if (!hit) continue;
    if (back[0] > 0) return { axis: 'x', at: hit.min.x, out: -1 };
    if (back[0] < 0) return { axis: 'x', at: hit.max.x, out: 1 };
    if (back[1] > 0) return { axis: 'z', at: hit.min.z, out: -1 };
    return { axis: 'z', at: hit.max.z, out: 1 };
  }
  return null;
}

// A picture on a wall: a frame and what is inside it, hung a centimetre proud
// of whatever wall is behind the point it is given.
function picture(x, y, z, w, h, face, art = DECO.canvas) {
  const wall = wallBehind(x, y, z, face);
  if (!wall) return [];
  const t = 0.03;
  const a0 = wall.out > 0 ? wall.at + 0.01 : wall.at - 0.01 - t;
  const a1 = a0 + t;
  const along = wall.axis === 'z';
  const u = along ? x : z;
  const out = [];
  const at = (u0, u1, v0, v1, mat) => out.push(along
    ? box(u0, v0, a0, u1, v1, a1, mat)
    : box(a0, v0, u0, a1, v1, u1, mat));
  const f = 0.05;
  at(u - w / 2, u + w / 2, y - h / 2, y - h / 2 + f, DECO.frame);
  at(u - w / 2, u + w / 2, y + h / 2 - f, y + h / 2, DECO.frame);
  at(u - w / 2, u - w / 2 + f, y - h / 2 + f, y + h / 2 - f, DECO.frame);
  at(u + w / 2 - f, u + w / 2, y - h / 2 + f, y + h / 2 - f, DECO.frame);
  // The picture itself, a hair shallower than its frame.
  at(u - w / 2 + f, u + w / 2 - f, y - h / 2 + f, y + h / 2 - f, art);
  return out;
}

// A plant: a pot, a stem and a crown of leaves round it. Knee-high to
// waist-high, which is why nobody will ever try to hide behind one — and the
// crown is built as a few overlapping slabs at slightly different heights,
// because four boxes stacked in a staircase read as a staircase.
function plant(x, z, y, o = {}) {
  const r = o.r ?? 0.17;
  const h = o.h ?? 0.34;
  const top = o.top ?? 0.85;
  const stem = y + h;
  const crown = y + top;
  const leaf = (w, d, dx, dz, y0, y1) =>
    box(x + dx - w, y0, z + dz - d, x + dx + w, y1, z + dz + d, DECO.leaf);
  return [
    box(x - r, y, z - r, x + r, y + h, z + r, DECO.pot),
    box(x - 0.035, stem, z - 0.035, x + 0.035, crown - 0.06, z + 0.035, DECO.leaf),
    leaf(r * 1.5, r * 0.9, -r * 0.5, 0, crown - 0.30, crown - 0.24),
    leaf(r * 0.9, r * 1.5, r * 0.4, r * 0.3, crown - 0.22, crown - 0.16),
    leaf(r * 1.3, r * 1.2, r * 0.2, -r * 0.5, crown - 0.14, crown - 0.08),
    leaf(r * 0.8, r * 0.8, -r * 0.2, r * 0.2, crown - 0.08, crown),
  ];
}

// A curtain: cloth hanging beside an opening, flat to the wall and thin as
// cloth. Never wide or deep enough to crouch behind — a curtain in this game
// hides nothing from anybody, because the simulation cannot see it at all, and
// something you *think* you are hidden behind is worse than nothing.
function curtain(x0, z0, x1, z1, yTop, drop) {
  return [box(x0, yTop - drop, z0, x1, yTop, z1, DECO.cloth)];
}

// Something flat on the floor. Two centimetres of it, which is a rug.
function rug(x0, z0, x1, z1, y) {
  return [box(x0, y + 0.002, z0, x1, y + 0.018, z1, DECO.rug)];
}

// A screen on a wall — a television, a monitor, the cinema's own.
function screen(x, y, z, w, h, face) {
  return picture(x, y, z, w, h, face, DECO.screen);
}

const decor = [
  // ── Ground floor ──
  // Entrance hall: something to look at while the door is being opened.
  ...picture(-2.5, 1.6, 2.35, 0.7, 0.9, 'e'),
  ...plant(2.4, 3.6, 0),
  ...rug(-1.6, 3.2, 1.6, 5.4, 0),

  // Cinema: the screen the seats are pointed at, and a strip light cable.
  ...screen(-5.8, 1.7, -3.66, 2.0, 1.2, 's'),
  ...rug(-14.2, -2.0, -10.8, -1.1, 0),

  // Dining and kitchen.
  ...picture(-2.3, 1.7, -12.44, 1.1, 0.8, 's'),
  ...rug(-3.8, -11.1, -0.8, -9.3, 0),
  ...plant(-4.9, -9.6, 0),
  ...picture(4.0, 1.7, -12.44, 0.6, 0.6, 's', DECO.paper),

  // Study and guest bedroom.
  ...picture(-3.2, 1.75, -17.84, 0.9, 0.7, 's'),
  ...rug(5.4, -15.6, 7.4, -13.9, 0),
  ...plant(-0.6, -17.0, 0),

  // Hall, gym, cloakroom.
  ...picture(-2.86, 1.6, -0.4, 0.5, 0.8, 'w'),
  ...picture(9.5, 1.7, -4.54, 1.4, 0.9, 's', DECO.paper),
  ...plant(-8.6, 4.6, 0),
  ...rug(-12.6, 2.6, -9.4, 4.4, 0),

  // Spa and guest room.
  ...plant(11.0, 5.0, 0),
  ...rug(4.3, 2.55, 6.7, 3.35, 0), // at the foot of the bed, not under it

  // The court is outdoors: a planted corner and the tree in the tub.
  ...plant(-6.8, -9.0, 0.5, { r: 0.22, top: 1.6 }),
  ...plant(-15.2, -11.6, 0),

  // ── Upper floor ──
  // Terrace: cloth by the glass doors, a pot in the corner.
  ...curtain(-8.94, -10.35, -8.84, -9.85, F2 + 2.5, 2.3), // tied back beside the glass
  ...plant(-15.4, -7.9, F2),
  ...plant(-6.6, -11.2, F2),

  // Bedrooms and dressing room.
  ...rug(-4.6, -15.5, -2.4, -13.8, F2),
  ...picture(-3.5, F2 + 1.7, -17.84, 1.0, 0.7, 's'),
  ...rug(1.0, -15.5, 3.4, -13.6, F2),
  ...picture(2.2, F2 + 1.7, -17.84, 0.8, 0.6, 's', DECO.paper),

  // Master bedroom and bathroom.
  ...rug(-13.4, -1.0, -10.2, 1.0, F2),
  ...picture(-11.8, F2 + 1.7, -3.64, 1.2, 0.8, 's'),
  ...picture(-13.2, F2 + 1.5, 1.24, 0.9, 0.9, 's', DECO.chrome), // the mirror
  ...plant(-15.3, -0.4, F2),

  // Upper lounge, media room, office.
  ...screen(-1.0, F2 + 1.6, -4.54, 1.6, 0.95, 's'),
  ...rug(-2.6, -1.0, 0.6, 1.2, F2),
  ...picture(4.3, F2 + 1.6, 0.94, 1.0, 0.7, 'n'),
  ...plant(1.4, 4.6, F2),
  ...picture(7.9, F2 + 1.7, 2.24, 0.9, 0.6, 's', DECO.paper),
  ...rug(6.4, 2.4, 9.4, 4.4, F2),

  // A cable run along the utility wall, because a flat has those.
  box(11.9, 2.35, -9.42, 13.3, 2.39, -9.38, DECO.cable),
  box(11.9, 2.29, -9.42, 13.3, 2.33, -9.38, DECO.cable),
].map((b) => ({ ...b, tag: 'decor' }));

export const APARTMENT = {
  id: 'penthouse',
  name: 'Пентхаус',
  bounds: { min: { x: -16.2, y: 0, z: -18.2 }, max: { x: 16.2, y: ROOF + 0.3, z: 9.7 } },
  upperFloorY: F2,
  geometry: solid,
  rooms,
  doors,
  lights,
  switches,
  holes,
  openings,
  // Drawn, never simulated — see the note above the list. Deliberately not in
  // `geometry`: everything that decides what happens in a round reads that,
  // and nothing in here is allowed to decide anything.
  decor,
  // The volumes the flights occupy. Kept in the data so map-check can prove
  // nothing has been put on them.
  // One entry per flight and landing: the footprint plus the headroom a person
  // needs over it. Anything found inside is something to trip on.
  stairways: [
    { id: 'court lower flight', min: { x: -12.4, y: 0, z: -14.2 }, max: { x: -10.9, y: 3.85, z: -11.0 } },
    { id: 'court half-landing', min: { x: -12.4, y: F2 / 2, z: -14.2 }, max: { x: -9.2, y: F2 / 2 + 2.2, z: -13.4 } },
    { id: 'court upper flight', min: { x: -10.9, y: F2 / 2, z: -13.4 }, max: { x: -9.2, y: F2 + 2.2, z: -10.5 } },
    { id: 'east flight', min: { x: 13.75, y: 0, z: -6.0 }, max: { x: 15.85, y: F2 + 2.2, z: 0 } },
  ],
  spawns: {
    attackers: [
      { x: -1.6, z: 8.6, yaw: 0 },
      { x: 1.6, z: 8.6, yaw: 0 },
      { x: -2.2, z: 7.2, yaw: 0 },
      { x: 2.2, z: 7.2, yaw: 0 },
    ],
    // All four defenders start in bedroom 3, spread across it.
    defenders: [
      { x: 0.2, y: F2, z: -16.6, yaw: Math.PI },
      { x: 3.6, y: F2, z: -16.6, yaw: Math.PI },
      { x: 0.2, y: F2, z: -13.6, yaw: Math.PI },
      { x: 3.6, y: F2, z: -13.6, yaw: Math.PI },
    ],
  },
  // Rules the layout is drawn around, for the round to enforce later.
  // How long it lasts is ROUND.prepTime, not a number here; the map only says
  // who may stand where.
  prep: {
    attackersHeld: ['landing'],
    defendersBarred: ['foyer', 'gallery', 'guest-suite', 'cloakroom', 'cinema'],
  },
};
