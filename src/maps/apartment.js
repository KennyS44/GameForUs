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


// ── Furniture ─────────────────────────────────────────────────────────────
// Blockouts, not decoration: a few solid shapes per room, placed the way a
// flat is actually furnished — beds and counters against walls, seating and
// tables out in the floor. Two rules they all obey, and map-check enforces
// both: nothing stands in a doorway or in the arc a door sweeps, and from any
// door of a room you can walk to any other door of it. A table across the
// middle is welcome; a table across a threshold is not.
const furniture = ([
  // ── Ground floor ──
  // Open court: a bench and a planter along the parapet, clear of the stair.
  box(-15.6, 0, -16.6, -14.4, 0.45, -13.6, M.wood),
  box(-7.6, 0, -9.4, -6.0, 0.5, -8.6, M.wood),

  // Study + guest bedroom (one room, column in the middle).
  box(-4.4, 0, -17.6, -1.9, 0.78, -16.8, M.wood), // desk on the north wall
  box(3.0, 0, -17.7, 5.5, 1.85, -17.1, M.wood), // bookcase, north wall
  box(5.6, 0, -17.6, 7.2, 0.55, -15.8, M.fabric), // bed against the east wall

  // Dining: a table in the middle — you walk round it, not through it.
  box(-3.4, 0, -10.7, -1.2, 0.75, -9.7, M.wood),
  box(-4.7, 0, -12.2, -3.7, 1.85, -11.0, M.wood), // sideboard in the corner

  // Kitchen: counter and fridge on the north wall, island off-centre.
  box(1.4, 0, -12.3, 6.4, 0.92, -11.7, M.wood),
  box(6.6, 0, -12.3, 7.3, 1.85, -11.3, M.metal),
  box(2.6, 0, -10.4, 4.4, 0.92, -9.6, M.wood),

  // Bathroom + utility, split by the bar-height barrier.
  box(8.2, 0, -17.6, 10.4, 0.9, -17.0, M.metal), // washbasins
  box(15.1, 0, -16.0, 15.8, 1.85, -13.4, M.metal), // shelving, east wall
  box(12.0, 0, -10.6, 13.2, 0.9, -9.4, M.wood), // crates in the utility half

  // Cinema: two rows of seating and a low cabinet under the screen.
  box(-14.0, 0, -2.7, -11.0, 0.85, -2.0, M.fabric),
  box(-14.0, 0, -1.1, -11.0, 0.85, -0.4, M.fabric),
  box(-7.0, 0, -4.3, -4.6, 0.6, -3.7, M.wood),

  // Hall: a bench on the west wall, out of every doorway.
  box(-2.8, 0, -1.2, -2.2, 0.45, 0.8, M.wood),

  // Gym.
  box(5.0, 0, -4.4, 7.4, 1.3, -3.9, M.metal), // weight rack, north wall
  box(9.0, 0, -2.6, 12.0, 0.15, -1.2, M.fabric), // mats
  box(4.2, 0, -1.7, 5.6, 0.5, -1.1, M.wood), // bench

  // Cloakroom: lockers on the south wall, bench in the middle.
  box(-14.0, 0, 5.2, -9.0, 1.85, 5.7, M.metal),
  box(-12.0, 0, 3.3, -10.0, 0.45, 3.9, M.wood),

  // Entrance hall: shoe bench and console, both clear of the front door.
  box(2.1, 0, 4.6, 2.8, 0.45, 5.6, M.wood),
  box(-2.8, 0, 1.9, -2.2, 0.8, 2.9, M.wood),

  // Guest room by the entrance hall.
  box(4.4, 0, 0.3, 6.4, 0.55, 2.4, M.fabric), // bed
  box(8.2, 0, 0.3, 8.8, 1.85, 2.0, M.wood), // wardrobe

  // Spa.
  box(15.1, 0, 1.5, 15.8, 0.5, 4.5, M.wood), // bench, east wall
  box(12.5, 0, 4.2, 14.5, 0.6, 5.5, M.metal), // tub block

  // ── Upper floor ──
  // Terrace: loungers along the parapet, nothing near the glass doors.
  box(-15.6, F2, -9.9, -13.2, F2 + 0.5, -9.1, M.wood),
  box(-7.6, F2, -16.8, -6.2, F2 + 0.5, -14.4, M.wood),

  // Bedroom 2.
  box(-4.4, F2, -17.6, -2.6, F2 + 0.55, -15.7, M.fabric), // bed
  box(-1.9, F2, -13.4, -1.3, F2 + 1.85, -12.4, M.wood), // wardrobe

  // Dressing room: a run of wardrobes along the north wall.
  box(-4.6, F2, -12.3, -1.4, F2 + 1.85, -11.7, M.wood),

  // Bedroom 3 — the defenders' room, kept roomy.
  box(1.2, F2, -17.6, 3.2, F2 + 0.55, -15.7, M.fabric), // bed
  box(3.7, F2, -12.9, 4.9, F2 + 0.78, -12.6, M.wood), // desk

  // Study.
  box(-0.6, F2, -12.3, 1.6, F2 + 0.78, -11.5, M.wood),
  box(3.4, F2, -12.3, 4.6, F2 + 1.8, -11.9, M.wood),

  // Bathroom and store.
  box(5.3, F2, -17.6, 7.0, F2 + 0.9, -17.0, M.metal),
  box(9.3, F2, -17.6, 9.9, F2 + 1.85, -16.2, M.wood), // shelving, clear of the hole
  box(12.6, F2, -14.4, 13.8, F2 + 0.9, -13.2, M.wood),

  // Laundry.
  box(5.4, F2, -12.3, 8.0, F2 + 1.0, -11.6, M.metal),

  // Master bedroom and bathroom.
  box(-13.0, F2, -3.2, -10.6, F2 + 0.6, -1.0, M.fabric), // bed, clear of the door arc
  box(-15.7, F2, -3.5, -15.1, F2 + 0.9, -1.5, M.wood), // dresser
  box(-15.6, F2, 4.4, -13.6, F2 + 0.6, 5.6, M.metal), // tub
  box(-14.4, F2, 1.3, -12.0, F2 + 0.9, 1.9, M.metal), // basins

  // Upper lounge and media room.
  box(-2.4, F2, -1.4, 0.4, F2 + 0.85, -0.6, M.fabric), // sofa
  box(3.9, F2, -4.3, 5.5, F2 + 0.95, -3.7, M.wood), // bar counter
  box(-2.6, F2, 4.2, 0.6, F2 + 0.8, 5.2, M.fabric), // sofa
  box(3.2, F2, 1.3, 5.4, F2 + 0.6, 1.9, M.wood), // media cabinet

  // Sauna and office.
  box(6.4, F2, -4.4, 8.4, F2 + 0.45, -3.8, M.wood),
  box(6.8, F2, 2.6, 9.0, F2 + 0.78, 3.6, M.wood), // desk
  box(14.6, F2, 3.0, 15.8, F2 + 1.8, 5.0, M.wood), // shelving
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

export const APARTMENT = {
  id: 'penthouse',
  name: 'Пентхаус',
  bounds: { min: { x: -16.2, y: 0, z: -18.2 }, max: { x: 16.2, y: ROOF + 0.3, z: 9.7 } },
  upperFloorY: F2,
  geometry: [
    ...shell, ...courtStair, ...groundWalls, ...upperWalls, ...eastStair,
    ...blockers, ...furniture, ...tiledFloors, ...mains,
  ],
  rooms,
  doors,
  lights,
  switches,
  holes,
  openings,
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
