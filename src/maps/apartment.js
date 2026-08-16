// Map data — plain data only, no engine types. The renderer and the simulation
// both read this, so geometry can never drift between what you see and what you hit.
//
// Axes: +X east, +Z south, +Y up. Yaw 0 faces -Z (north).
//
// A two-storey penthouse, 32 × 24 m per floor. Two staircases sit at the west
// and east edges and are the only way between the floors — they never meet, so
// holding one never holds both. Both floors share one east–west corridor
// (the "spine") at z ≈ -6; every room hangs off it.
//
// GROUND FLOOR (y = 0)
//   z=-17.9 ┌──────────┬─────────┬─────────┬──────────┐
//           │  LIVING  │  STUDY  │ GUEST   │ BATHROOM │
//   z=-12.5 │  ROOM    ├─────────┼─────────┼──────────┤
//           │ (2 floors│ DINING  │ KITCHEN │ UTILITY  │
//   z= -7.4 ├─┬─high)  ┴─────────┴─────────┴────────┬─┤
//           │W│ · · · · · S P I N E · · · · · · · · │E│   stair shafts
//   z= -4.6 ├─┴────────────┬───────┬───────────────┬┴─┤
//           │   CINEMA     │GALLERY│      GYM      │  │
//   z=  0   ├──────────────┼───────┼───────┬───────┴──┤
//           │   CLOAKROOM  │ FOYER │ GUEST │   SPA    │
//   z=  5.9 └──────────────┴──door─┴───────┴──────────┘
//                          front door → landing (attacker spawn)
//
// UPPER FLOOR (y = 3.3)
//   z=-17.9 ┌──────────┬───────┬───────┬─────┬────────┐
//           │  MASTER  │ BED 2 │ BED 3 │BATH │ STORE  │
//   z=-12.5 │  BATH    ├───────┼───────┴─┬───┴────────┤
//           ├──────────┤WARDROBE│ STUDY  │  LAUNDRY   │
//   z= -7.4 │  MASTER  ┴────────┴────────┴──────────┬─┤
//           │W· · · · · S P I N E · · · · · · · · · │E│
//   z= -4.6 ├─┴──────────────┬──────────┬───────────┴─┤
//           │                │  LOUNGE  │   SAUNA     │
//   z=  1   │    TERRACE     ├──────────┼─────────────┤
//           │   (open sky)   │  MEDIA   │   OFFICE    │
//   z=  5.9 └────────────────┴──────────┴─────────────┘

export const MATERIALS = {
  concrete: { name: 'concrete', penetration: 0, color: 0x3a3a3e, hardness: 1.0 },
  // Same behaviour as concrete underfoot; it exists so the floor can be boards
  // instead of another grey slab.
  floor: { name: 'floor', penetration: 0, color: 0x5b4835, hardness: 1.0 },
  drywall: { name: 'drywall', penetration: 14, color: 0x5a544c, hardness: 0.25 },
  wood: { name: 'wood', penetration: 6, color: 0x4a3826, hardness: 0.5 },
  glass: { name: 'glass', penetration: 40, color: 0x88a0aa, hardness: 0.05 },
  metal: { name: 'metal', penetration: 1, color: 0x4a4e52, hardness: 0.9 },
  fabric: { name: 'fabric', penetration: 20, color: 0x3d3a42, hardness: 0.2 },
};

const WALL_H = 3.0; // floor to ceiling, one storey
const SLAB = 0.3; // thickness of the floor between the storeys
const F2 = WALL_H + SLAB; // 3.3 — walking level upstairs
const ROOF = F2 + WALL_H; // 6.3

// Build an axis-aligned wall segment, splitting it around doorways.
// `gaps` are measured along the segment's long axis: {at, width}.
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
      ? {
          min: { x: a, y: yBase, z: fixed - t / 2 },
          max: { x: b, y: yTop, z: fixed + t / 2 },
        }
      : {
          min: { x: fixed - t / 2, y: yBase, z: a },
          max: { x: fixed + t / 2, y: yTop, z: b },
        };
    out.push({ ...box, material, axis });
  };

  const sorted = [...gaps].sort((g1, g2) => g1.at - g2.at);
  let cursor = from;
  for (const g of sorted) {
    const gStart = g.at - g.width / 2;
    const gEnd = g.at + g.width / 2;
    push(cursor, gStart, base, base + h);
    // Lintel above the doorway.
    push(gStart, gEnd, base + doorTop, base + h);
    cursor = gEnd;
  }
  push(cursor, to, base, base + h);
  return out;
}

function box(minX, minY, minZ, maxX, maxY, maxZ, material) {
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    material,
  };
}

const M = MATERIALS;

// A floor slab: concrete from below, boards on top, so a ceiling still reads as
// a ceiling and the storey above still reads as a floor.
function slab(x1, z1, x2, z2) {
  return [
    box(x1, WALL_H, z1, x2, F2 - 0.1, z2, M.concrete),
    box(x1, F2 - 0.1, z1, x2, F2, z2, M.floor),
  ];
}

// A straight flight of stairs climbing exactly one storey. Each tread is a
// solid block, so it is climbed with the same step-up rule as any low obstacle
// and never leaves a gap to fall through. `dir` is +1 south, -1 north.
const STAIR_STEPS = 16;
const STAIR_RISE = F2 / STAIR_STEPS; // 0.206 m — well under the 0.32 step height
const STAIR_TREAD = 0.30;

function stairs(x1, x2, zBottom, dir) {
  const out = [];
  for (let i = 0; i < STAIR_STEPS; i++) {
    const zA = zBottom + dir * i * STAIR_TREAD;
    const zB = zA + dir * STAIR_TREAD;
    out.push(box(x1, 0, Math.min(zA, zB), x2, (i + 1) * STAIR_RISE, Math.max(zA, zB), M.floor));
  }
  return out;
}

// ── Shell ─────────────────────────────────────────────────────────────────
// Outer walls are concrete: the flat is never breached from outside.
const shell = [
  // Ground slab, reaching out under the entrance landing.
  box(-16.2, -0.5, -18.2, 16.2, 0, 9.7, M.floor),

  // Ground-floor outer walls (0 → 3.3, flush with the slab above).
  ...wall(-16, 6, 16, 6, M.concrete, { thickness: 0.3, height: F2, gaps: [{ at: 0, width: 1.1 }] }),
  ...wall(-16, -18, 16, -18, M.concrete, { thickness: 0.3, height: F2 }),
  ...wall(-16, -18, -16, 6, M.concrete, { thickness: 0.3, height: F2 }),
  ...wall(16, -18, 16, 6, M.concrete, { thickness: 0.3, height: F2 }),

  // Upper-floor outer walls. Where they border the terrace they drop to a
  // parapet you can shoot over — and be shot over.
  ...wall(-16, 6, -2, 6, M.concrete, { thickness: 0.3, base: F2, height: 1.1 }),
  ...wall(-2, 6, 16, 6, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),
  ...wall(-16, -4.6, -16, 6, M.concrete, { thickness: 0.3, base: F2, height: 1.1 }),
  ...wall(-16, -18, -16, -4.6, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),
  ...wall(-16, -18, 16, -18, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),
  ...wall(16, -18, 16, 6, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),

  // Landing outside the front door (attacker spawn).
  ...wall(-3, 9.5, 3, 9.5, M.concrete, { thickness: 0.25 }),
  ...wall(-3, 6, -3, 9.5, M.concrete, { thickness: 0.25 }),
  ...wall(3, 6, 3, 9.5, M.concrete, { thickness: 0.25 }),
  box(-3.2, WALL_H, 6, 3.2, F2, 9.7, M.concrete),

  // ── Upper floor slab, with a hole left open over each stairwell ─────────
  ...slab(-16.2, -18.2, -13.6, -11.9), // west of the west shaft
  ...slab(-16.2, -4.6, -13.6, 6.2),
  ...slab(-13.6, -18.2, 13.6, 6.2), // the whole middle
  ...slab(13.6, -18.2, 16.2, -7.4),
  ...slab(13.6, 0, 16.2, 6.2),

  // Roof — everything except the terrace, which is open to the sky.
  box(-16.2, ROOF, -18.2, 16.2, ROOF + 0.3, -4.6, M.concrete),
  box(-2, ROOF, -4.6, 16.2, ROOF + 0.3, 6.2, M.concrete),
];

// ── Stairwells ────────────────────────────────────────────────────────────
// Two shafts at opposite edges. Each one is entered from the spine downstairs
// and leaves into a room upstairs, so neither staircase feeds the other.
const stairwells = [
  // West shaft: x −15.85…−13.75, climbing north.
  ...stairs(-15.85, -13.75, -6.1, -1),
  ...slab(-15.85, -11.9, -13.45, -10.9), // top landing, running under the door
  ...wall(-13.6, -11.9, -13.6, -4.6, M.concrete, {
    thickness: 0.3, height: F2, gaps: [{ at: -5.1, width: 1.0 }],
  }),
  ...wall(-13.6, -11.9, -13.6, -4.6, M.concrete, {
    thickness: 0.3, base: F2, height: WALL_H, gaps: [{ at: -11.3, width: 1.0 }],
  }),
  ...wall(-16, -11.9, -13.6, -11.9, M.concrete, { thickness: 0.3, height: ROOF }),
  ...wall(-16, -4.6, -13.6, -4.6, M.concrete, { thickness: 0.3, height: ROOF }),

  // East shaft: x 13.75…15.85, climbing south.
  ...stairs(13.75, 15.85, -6.0, 1),
  ...slab(13.45, -1.2, 15.85, 0), // top landing, running under the door
  ...wall(13.6, -7.4, 13.6, 0, M.concrete, {
    thickness: 0.3, height: F2, gaps: [{ at: -6.9, width: 1.0 }],
  }),
  ...wall(13.6, -7.4, 13.6, 0, M.concrete, {
    thickness: 0.3, base: F2, height: WALL_H, gaps: [{ at: -0.7, width: 1.0 }],
  }),
  ...wall(13.6, -7.4, 16, -7.4, M.concrete, { thickness: 0.3, height: ROOF }),
  ...wall(13.6, 0, 16, 0, M.concrete, { thickness: 0.3, height: ROOF }),
];

// ── Ground floor partitions (drywall — shootable through) ──────────────────
const groundWalls = [
  // Spine, north side.
  ...wall(-13.6, -7.4, 13.6, -7.4, M.drywall, {
    gaps: [
      { at: -9, width: 1.0 }, // living room
      { at: -2, width: 1.0 }, // dining
      { at: 4, width: 1.0 }, // kitchen
      { at: 10.5, width: 1.0 }, // utility
    ],
  }),
  // Spine, south side.
  ...wall(-13.6, -4.6, 13.6, -4.6, M.drywall, {
    gaps: [
      { at: -9, width: 1.0 }, // cinema
      { at: 0, width: 1.6 }, // open archway into the gallery
      { at: 8, width: 1.0 }, // gym
    ],
  }),

  // North half.
  ...wall(-5, -17.85, -5, -7.4, M.drywall, {
    gaps: [{ at: -10, width: 1.0 }, { at: -15, width: 1.0 }],
  }),
  ...wall(1, -17.85, 1, -7.4, M.drywall, {
    gaps: [{ at: -10, width: 1.4 }, { at: -15, width: 1.0 }],
  }),
  ...wall(7.5, -17.85, 7.5, -7.4, M.drywall, {
    gaps: [{ at: -9.5, width: 1.0 }, { at: -15, width: 1.0 }],
  }),
  ...wall(-5, -12.5, 16, -12.5, M.drywall, {
    gaps: [{ at: -2, width: 1.0 }, { at: 10.5, width: 1.0 }],
  }),

  // South half.
  ...wall(-3, -4.6, -3, 5.85, M.drywall, {
    gaps: [{ at: -2, width: 1.0 }, { at: 3.5, width: 1.0 }],
  }),
  ...wall(3, -4.6, 3, 5.85, M.drywall, {
    gaps: [{ at: -2, width: 1.0 }, { at: 3.5, width: 1.0 }],
  }),
  ...wall(-16, 1.5, 3, 1.5, M.drywall, {
    gaps: [{ at: -8, width: 1.0 }, { at: 0, width: 1.6 }],
  }),
  ...wall(3, 0, 16, 0, M.drywall, {
    gaps: [{ at: 6, width: 1.4 }, { at: 11.5, width: 1.0 }],
  }),
  ...wall(9, 0, 9, 5.85, M.drywall, { gaps: [{ at: 3.5, width: 1.0 }] }),
];

// ── Upper floor partitions ────────────────────────────────────────────────
const upperWalls = [
  ...wall(-13.6, -7.4, 13.6, -7.4, M.drywall, {
    base: F2,
    gaps: [
      { at: -10, width: 1.0 }, // master bedroom
      { at: -3.5, width: 1.0 }, // wardrobe
      { at: 2, width: 1.0 }, // study
      { at: 9, width: 1.0 }, // laundry
    ],
  }),
  ...wall(-13.6, -4.6, 13.6, -4.6, M.drywall, {
    base: F2,
    gaps: [
      { at: -8, width: 1.0 }, // terrace
      { at: 2, width: 1.0 }, // lounge
      { at: 10, width: 1.0 }, // sauna
    ],
  }),

  // North half.
  ...wall(-6, -17.85, -6, -7.4, M.drywall, {
    base: F2,
    gaps: [{ at: -10, width: 1.0 }, { at: -15, width: 1.0 }],
  }),
  ...wall(-1, -17.85, -1, -7.4, M.drywall, { base: F2, gaps: [{ at: -15, width: 1.4 }] }),
  ...wall(5, -17.85, 5, -7.4, M.drywall, { base: F2, gaps: [{ at: -15, width: 1.0 }] }),
  ...wall(9, -17.85, 9, -12.5, M.drywall, { base: F2, gaps: [{ at: -15, width: 1.0 }] }),
  ...wall(-16, -12.5, 16, -12.5, M.drywall, {
    base: F2,
    gaps: [
      { at: -10, width: 1.0 }, // master → master bath
      { at: 2, width: 1.0 }, // study → bedroom 3
      { at: 11, width: 1.0 }, // laundry → store
    ],
  }),

  // South half. The terrace is walled off from the rooms beside it.
  ...wall(-2, -4.6, -2, 5.85, M.drywall, { base: F2, gaps: [{ at: -2, width: 1.0 }] }),
  ...wall(6, -4.6, 6, 5.85, M.drywall, {
    base: F2,
    gaps: [{ at: -2, width: 1.0 }, { at: 3.5, width: 1.4 }],
  }),
  ...wall(-2, 1, 16, 1, M.drywall, {
    base: F2,
    gaps: [{ at: 2, width: 1.4 }, { at: 10, width: 1.0 }],
  }),
];

// ── Furniture — cover you can hide behind, and mostly shoot through ────────
const props = [
  // Ground: living room.
  box(-13.0, 0, -13.6, -12.2, 0.85, -10.6, M.fabric), // sofa
  box(-11.4, 0, -12.4, -9.0, 0.75, -11.5, M.wood), // coffee table
  box(-15.4, 0, -17.4, -12.8, 1.9, -17.0, M.wood), // shelving on the north wall
  box(-7.6, 0, -10.5, -6.8, 1.5, -8.6, M.wood), // sideboard by the spine door
  // Dining, kitchen, utility.
  box(-4.2, 0, -11.2, -1.6, 0.78, -9.2, M.wood), // dining table
  box(1.6, 0, -8.6, 6.8, 0.92, -7.9, M.wood), // kitchen counter
  box(6.4, 0, -12.2, 7.2, 1.85, -10.4, M.metal), // fridge
  box(8.4, 0, -12.2, 12.0, 1.6, -11.6, M.metal), // utility racking
  // Study, guest bedroom, bathroom.
  box(-4.4, 0, -15.4, -2.0, 0.78, -14.0, M.wood), // desk
  box(2.2, 0, -17.2, 4.8, 0.55, -14.4, M.fabric), // guest bed
  box(6.2, 0, -17.4, 7.2, 1.4, -16.0, M.wood), // wardrobe
  box(8.2, 0, -16.6, 9.4, 0.9, -15.2, M.metal), // washbasin block
  // Cinema, cloakroom, foyer.
  box(-13.6, 0, -3.6, -9.6, 0.9, -2.9, M.fabric), // cinema seating
  box(-6.2, 0, -0.4, -3.6, 1.2, 0.2, M.wood), // media cabinet
  box(-15.4, 0, 2.2, -14.6, 1.9, 5.2, M.metal), // cloakroom lockers
  box(-2.6, 0, 4.6, -1.4, 1.2, 5.6, M.wood), // shoe bench by the front door
  // Gym, guest suite, spa.
  box(4.6, 0, -3.4, 7.4, 1.3, -2.6, M.metal), // weight rack
  box(10.0, 0, -3.8, 12.6, 0.6, -1.4, M.fabric), // mats
  box(4.0, 0, 2.4, 6.6, 0.55, 5.0, M.fabric), // guest bed
  box(11.0, 0, 1.0, 15.2, 0.9, 2.0, M.metal), // spa bench

  // Upper: master suite.
  box(-12.6, F2, -11.4, -9.0, F2 + 0.6, -8.6, M.fabric), // master bed
  box(-8.6, F2, -12.3, -6.6, F2 + 0.9, -11.6, M.wood), // dresser
  box(-13.0, F2, -16.8, -10.4, F2 + 0.9, -15.8, M.metal), // bathtub block
  box(-4.8, F2, -12.0, -1.4, F2 + 1.9, -11.4, M.wood), // wardrobe run
  // Bedrooms and services.
  box(-5.2, F2, -17.2, -3.0, F2 + 0.55, -14.8, M.fabric), // bed 2
  box(1.4, F2, -17.2, 3.6, F2 + 0.55, -14.8, M.fabric), // bed 3
  box(-0.6, F2, -10.4, 2.0, F2 + 0.78, -9.2, M.wood), // study desk
  box(9.6, F2, -11.4, 12.8, F2 + 1.0, -10.6, M.metal), // laundry machines
  box(10.0, F2, -17.2, 14.0, F2 + 1.7, -16.6, M.wood), // storage shelving
  // Terrace, lounge, media, sauna, office.
  box(-12.0, F2, -1.6, -8.0, F2 + 0.7, 0.4, M.wood), // terrace loungers
  box(-5.6, F2, 3.2, -3.2, F2 + 0.9, 4.6, M.fabric), // terrace planter
  box(-1.2, F2, -3.4, 2.2, F2 + 0.95, -2.6, M.wood), // bar counter
  box(-1.2, F2, 2.8, 2.4, F2 + 0.75, 4.4, M.fabric), // media sofa
  box(9.0, F2, -3.8, 12.4, F2 + 0.7, -3.0, M.wood), // sauna benches
  box(8.0, F2, 2.6, 11.2, F2 + 0.78, 3.6, M.wood), // office desk
];

// Doors. `axis` is the wall's axis; the panel swings around `hinge`.
// `swing` is which way it opens (+1 / -1 in the perpendicular axis).
// `y` is the storey the door stands on.
const doors = [
  {
    id: 'front',
    pos: { x: 0, z: 6 },
    axis: 'x',
    width: 1.1,
    hinge: -1, // hinge on the -x side
    swing: -1, // opens inward (north)
    material: M.metal,
    reinforced: true,
    health: 220,
    locked: true,
  },

  // ── Stairwells ──
  { id: 'stair-w-1', pos: { x: -13.6, z: -5.1 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'stair-w-2', pos: { x: -13.6, z: -11.3 }, axis: 'z', width: 1.0, hinge: 1, swing: -1, material: M.wood, y: F2 },
  { id: 'stair-e-1', pos: { x: 13.6, z: -6.9 }, axis: 'z', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'stair-e-2', pos: { x: 13.6, z: -0.7 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },

  // ── Ground floor ──
  { id: 'living-spine', pos: { x: -9, z: -7.4 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood },
  { id: 'dining-spine', pos: { x: -2, z: -7.4 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'kitchen-spine', pos: { x: 4, z: -7.4 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood },
  { id: 'utility-spine', pos: { x: 10.5, z: -7.4 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'cinema-spine', pos: { x: -9, z: -4.6 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'gym-spine', pos: { x: 8, z: -4.6 }, axis: 'x', width: 1.0, hinge: 1, swing: 1, material: M.wood },
  { id: 'living-dining', pos: { x: -5, z: -10 }, axis: 'z', width: 1.0, hinge: -1, swing: -1, material: M.wood },
  { id: 'living-study', pos: { x: -5, z: -15 }, axis: 'z', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'study-guest', pos: { x: 1, z: -15 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'kitchen-utility', pos: { x: 7.5, z: -9.5 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood },
  { id: 'guest-bath', pos: { x: 7.5, z: -15 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'dining-study', pos: { x: -2, z: -12.5 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood },
  { id: 'utility-bath', pos: { x: 10.5, z: -12.5 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'cinema-gallery', pos: { x: -3, z: -2 }, axis: 'z', width: 1.0, hinge: -1, swing: -1, material: M.wood },
  { id: 'cloak-foyer', pos: { x: -3, z: 3.5 }, axis: 'z', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'gallery-gym', pos: { x: 3, z: -2 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'foyer-guest', pos: { x: 3, z: 3.5 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood },
  { id: 'cinema-cloak', pos: { x: -8, z: 1.5 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'gym-spa', pos: { x: 11.5, z: 0 }, axis: 'x', width: 1.0, hinge: 1, swing: 1, material: M.wood },
  { id: 'guest-spa', pos: { x: 9, z: 3.5 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood },

  // ── Upper floor ──
  { id: 'master-spine', pos: { x: -10, z: -7.4 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood, y: F2 },
  { id: 'wardrobe-spine', pos: { x: -3.5, z: -7.4 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood, y: F2 },
  { id: 'study2-spine', pos: { x: 2, z: -7.4 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood, y: F2 },
  { id: 'laundry-spine', pos: { x: 9, z: -7.4 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood, y: F2 },
  { id: 'terrace-spine', pos: { x: -8, z: -4.6 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.glass, y: F2 },
  { id: 'lounge-spine', pos: { x: 2, z: -4.6 }, axis: 'x', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'sauna-spine', pos: { x: 10, z: -4.6 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'master-wardrobe', pos: { x: -6, z: -10 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'bath2-bed2', pos: { x: -6, z: -15 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'bed3-bath', pos: { x: 5, z: -15 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'bath-store', pos: { x: 9, z: -15 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'master-bath2', pos: { x: -10, z: -12.5 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood, y: F2 },
  { id: 'study2-bed3', pos: { x: 2, z: -12.5 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood, y: F2 },
  { id: 'laundry-store', pos: { x: 11, z: -12.5 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood, y: F2 },
  { id: 'lounge-terrace', pos: { x: -2, z: -2 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.glass, y: F2 },
  { id: 'lounge-sauna', pos: { x: 6, z: -2 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'sauna-office', pos: { x: 10, z: 1 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
];

// Lamps. Rooms without one stay dark on purpose — the flashlight is the price
// of seeing in them.
const L1 = 2.65; // ground-floor ceiling height for fittings
const L2 = F2 + 2.65;
const lights = [
  // Ground floor.
  { id: 'living', pos: { x: -10, y: L1, z: -14 }, radius: 10, color: 0xffd9a8, intensity: 1.4 },
  { id: 'living2', pos: { x: -9, y: L1, z: -9.5 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'dining', pos: { x: -2, y: L1, z: -10 }, radius: 8, color: 0xffd9a8, intensity: 1.2 },
  { id: 'kitchen', pos: { x: 4, y: L1, z: -10 }, radius: 8, color: 0xfff0d0, intensity: 1.3 },
  { id: 'spine-w', pos: { x: -7, y: L1, z: -6 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'spine-e', pos: { x: 7, y: L1, z: -6 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'gallery', pos: { x: 0, y: L1, z: -2 }, radius: 7, color: 0xffd9a8, intensity: 1.1 },
  { id: 'foyer', pos: { x: 0, y: L1, z: 3.5 }, radius: 7, color: 0xffd9a8, intensity: 1.2 },
  { id: 'cinema', pos: { x: -9, y: L1, z: -1 }, radius: 8, color: 0xffc890, intensity: 0.9 },
  { id: 'gym', pos: { x: 8, y: L1, z: -2 }, radius: 8, color: 0xfff0d0, intensity: 1.1 },
  { id: 'guest', pos: { x: 6, y: L1, z: 3 }, radius: 7, color: 0xffc890, intensity: 1.0 },
  { id: 'landing', pos: { x: 0, y: L1, z: 8 }, radius: 7, color: 0x9fb4c8, intensity: 0.8 },
  // Stairwells — the only light in either shaft.
  { id: 'stair-w', pos: { x: -14.8, y: L1, z: -8 }, radius: 7, color: 0xd8e8ff, intensity: 0.9 },
  { id: 'stair-e', pos: { x: 14.8, y: L1, z: -3.5 }, radius: 7, color: 0xd8e8ff, intensity: 0.9 },
  // Upper floor.
  { id: 'master', pos: { x: -10, y: L2, z: -10 }, radius: 9, color: 0xffc890, intensity: 1.2 },
  { id: 'spine2-w', pos: { x: -6, y: L2, z: -6 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'spine2-e', pos: { x: 7, y: L2, z: -6 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'study2', pos: { x: 2, y: L2, z: -10 }, radius: 7, color: 0xfff0d0, intensity: 1.0 },
  { id: 'bed3', pos: { x: 2, y: L2, z: -15 }, radius: 7, color: 0xffc890, intensity: 0.9 },
  { id: 'lounge', pos: { x: 2, y: L2, z: -2 }, radius: 8, color: 0xffd9a8, intensity: 1.2 },
  { id: 'media', pos: { x: 2, y: L2, z: 3.5 }, radius: 7, color: 0xffc890, intensity: 0.9 },
  { id: 'sauna', pos: { x: 10, y: L2, z: -2 }, radius: 8, color: 0xfff0d0, intensity: 1.0 },
  // Terrace: a cold outdoor fitting under the open sky.
  { id: 'terrace', pos: { x: -8, y: L2, z: 1 }, radius: 9, color: 0x9fb4c8, intensity: 0.7 },
];

export const APARTMENT = {
  id: 'apartment',
  name: 'Пентхаус',
  bounds: { min: { x: -16.2, y: 0, z: -18.2 }, max: { x: 16.2, y: ROOF + 0.3, z: 9.7 } },
  geometry: [...shell, ...stairwells, ...groundWalls, ...upperWalls, ...props],
  doors,
  lights,
  spawns: {
    // Attackers stack up on the landing and breach the front door.
    attackers: [
      { x: -1.6, z: 8.6, yaw: 0 },
      { x: 1.6, z: 8.6, yaw: 0 },
      { x: -2.2, z: 7.2, yaw: 0 },
      { x: 2.2, z: 7.2, yaw: 0 },
    ],
    // Defenders hold the penthouse, split across both storeys.
    defenders: [
      { x: -11.0, z: -15.5, yaw: Math.PI * 0.75 },
      { x: 10.5, z: -9.0, yaw: Math.PI },
      { x: -13.0, y: F2, z: -9.5, yaw: Math.PI * 0.5 },
      { x: 9.0, z: -2.0, y: F2, yaw: Math.PI },
    ],
  },
};
