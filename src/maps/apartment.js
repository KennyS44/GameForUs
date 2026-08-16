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
  // Glass stops a bullet the only way glass can: by breaking. It hides
  // nothing though — `seeThrough` lets sight straight past it.
  glass: { name: 'glass', penetration: 0, color: 0x88a0aa, hardness: 0.05, seeThrough: true },
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
    { ...box(x1, WALL_H, z1, x2, F2 - 0.1, z2, M.concrete), layer: 'slab' },
    { ...box(x1, F2 - 0.1, z1, x2, F2, z2, M.floor), layer: 'slab' },
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
  ...wall(-16, 6, 16, 6, M.concrete, { thickness: 0.3, height: WALL_H, gaps: [{ at: 0, width: 1.1 }] }),
  ...wall(-16, -18, 16, -18, M.concrete, { thickness: 0.3, height: WALL_H }),
  ...wall(-16, -18, -16, 6, M.concrete, { thickness: 0.3, height: WALL_H }),
  ...wall(16, -18, 16, 6, M.concrete, { thickness: 0.3, height: WALL_H }),

  // Upper-floor outer walls. Where they border the terrace they drop to a
  // parapet you can shoot over — and be shot over.
  ...wall(-15.85, 6, -2, 6, M.concrete, { thickness: 0.3, base: F2, height: 1.1 }),
  ...wall(-2, 6, 16, 6, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),
  ...wall(-16, -4.6, -16, 6, M.concrete, { thickness: 0.3, base: F2, height: 1.1 }),
  ...wall(-16, -18, -16, -4.6, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),
  ...wall(-16, -18, 16, -18, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),
  ...wall(16, -18, 16, 6, M.concrete, { thickness: 0.3, base: F2, height: WALL_H }),

  // Landing outside the front door (attacker spawn).
  ...wall(-3, 9.5, 3, 9.5, M.concrete, { thickness: 0.25 }),
  ...wall(-3, 6, -3, 9.5, M.concrete, { thickness: 0.25 }),
  ...wall(3, 6, 3, 9.5, M.concrete, { thickness: 0.25 }),
  { ...box(-3.2, WALL_H, 6.2, 3.2, F2, 9.7, M.concrete), layer: 'slab' },

  // ── Upper floor slab, with a hole left open over each stairwell ─────────
  ...slab(-16.2, -18.2, -13.6, -12.5), // north of the west shaft
  ...slab(-16.2, -4.6, -13.6, 6.2),
  ...slab(-13.6, -18.2, 13.6, 6.2), // the whole middle
  ...slab(13.6, -18.2, 16.2, -7.4),
  ...slab(13.6, 1, 16.2, 6.2),

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
  ...slab(-15.85, -12.5, -13.6, -10.9), // top landing, up to the main slab
  ...wall(-13.6, -12.5, -13.6, -4.6, M.concrete, {
    thickness: 0.3, height: WALL_H, gaps: [{ at: -5.1, width: 1.0 }],
  }),
  ...wall(-13.6, -12.5, -13.6, -4.6, M.concrete, {
    thickness: 0.3, base: WALL_H, height: WALL_H + SLAB, doorTop: SLAB + 2.1,
    gaps: [{ at: -11.3, width: 1.0 }],
  }),
  ...wall(-16, -12.5, -13.6, -12.5, M.concrete, { thickness: 0.3, height: ROOF }),
  ...wall(-16, -4.6, -13.6, -4.6, M.concrete, { thickness: 0.3, height: ROOF }),

  // East shaft: x 13.75…15.85, climbing south.
  ...stairs(13.75, 15.85, -6.0, 1),
  ...slab(13.6, -1.2, 15.85, 1), // top landing, up to the main slab
  ...wall(13.6, -7.4, 13.6, 1, M.concrete, {
    thickness: 0.3, height: WALL_H, gaps: [{ at: -6.9, width: 1.0 }],
  }),
  ...wall(13.6, -7.4, 13.6, 1, M.concrete, {
    thickness: 0.3, base: WALL_H, height: WALL_H + SLAB, doorTop: SLAB + 2.1,
    gaps: [{ at: -0.7, width: 1.0 }],
  }),
  ...wall(13.6, -7.4, 16, -7.4, M.concrete, { thickness: 0.3, height: ROOF }),
  ...wall(13.6, 1, 16, 1, M.concrete, { thickness: 0.3, height: ROOF }),
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
  ...wall(3, 0, 13.6, 0, M.drywall, {
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
  ...wall(-13.6, -12.5, 16, -12.5, M.drywall, {
    base: F2,
    gaps: [
      { at: -10, width: 1.0 }, // master → master bath
      { at: 2, width: 1.0 }, // study → bedroom 3
      { at: 11, width: 1.0 }, // laundry → store
    ],
  }),

  // South half. The terrace is walled off from the rooms beside it.
  // Starts at the face of the spine wall, not inside it: two wall caps in one
  // plane under the open sky of the terrace would flicker against each other.
  ...wall(-2, -4.54, -2, 5.85, M.drywall, { base: F2, gaps: [{ at: -2, width: 1.0 }] }),
  ...wall(6, -4.6, 6, 5.85, M.drywall, {
    base: F2,
    gaps: [{ at: -2, width: 1.0 }, { at: 3.5, width: 1.4 }],
  }),
  ...wall(-2, 1, 13.6, 1, M.drywall, {
    base: F2,
    gaps: [{ at: 2, width: 1.4 }, { at: 10, width: 1.0 }],
  }),
];

// Furniture — none, deliberately. The plan is being designed first: shells,
// doors and stairs only, so that every sightline you see is the one the walls
// make. Props come back once the layout is settled.
const props = [];

// Doors. `axis` is the wall's axis; the panel swings around `hinge`.
// `swing` is which way it opens (+1 / -1 in the perpendicular axis).
// `y` is the storey the door stands on.
const doors = [
  {
    id: 'front',
    pos: { x: 0, z: 6 },
    axis: 'x',
    width: 1.1,
    frame: 0.3, // set into the outer shell
    hinge: -1, // hinge on the -x side
    swing: -1, // opens inward (north)
    material: M.metal,
    reinforced: true,
    health: 220,
    locked: true,
  },

  // ── Stairwells ──
  { id: 'stair-w-1', pos: { x: -13.6, z: -5.1 }, axis: 'z', width: 1.0, frame: 0.3, hinge: -1, swing: 1, material: M.wood },
  { id: 'stair-w-2', pos: { x: -13.6, z: -11.3 }, axis: 'z', width: 1.0, frame: 0.3, hinge: 1, swing: -1, material: M.wood, y: F2 },
  { id: 'stair-e-1', pos: { x: 13.6, z: -6.9 }, axis: 'z', width: 1.0, frame: 0.3, hinge: 1, swing: -1, material: M.wood },
  { id: 'stair-e-2', pos: { x: 13.6, z: -0.7 }, axis: 'z', width: 1.0, frame: 0.3, hinge: -1, swing: 1, material: M.wood, y: F2 },

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
  { id: 'terrace-spine', pos: { x: -8, z: -4.6 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.glass, health: 2, y: F2 },
  { id: 'lounge-spine', pos: { x: 2, z: -4.6 }, axis: 'x', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'sauna-spine', pos: { x: 10, z: -4.6 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'master-wardrobe', pos: { x: -6, z: -10 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'bath2-bed2', pos: { x: -6, z: -15 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'bed3-bath', pos: { x: 5, z: -15 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
  { id: 'bath-store', pos: { x: 9, z: -15 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'master-bath2', pos: { x: -10, z: -12.5 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood, y: F2 },
  { id: 'study2-bed3', pos: { x: 2, z: -12.5 }, axis: 'x', width: 1.0, hinge: 1, swing: -1, material: M.wood, y: F2 },
  { id: 'laundry-store', pos: { x: 11, z: -12.5 }, axis: 'x', width: 1.0, hinge: -1, swing: -1, material: M.wood, y: F2 },
  { id: 'lounge-terrace', pos: { x: -2, z: -2 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.glass, health: 2, y: F2 },
  { id: 'lounge-sauna', pos: { x: 6, z: -2 }, axis: 'z', width: 1.0, hinge: 1, swing: 1, material: M.wood, y: F2 },
  { id: 'sauna-office', pos: { x: 10, z: 1 }, axis: 'x', width: 1.0, hinge: -1, swing: 1, material: M.wood, y: F2 },
];

// Lamps. Rooms without one stay dark on purpose — the flashlight is the price
// of seeing in them.
//
// `mount` says how each one is fixed: hung from the ceiling by default,
// bracketed to a wall (`face` points away from that wall), or standing on a
// post (`base` is the floor it stands on). The stairwells are open all the way
// to the roof and the terrace has no ceiling at all, so neither of them can
// hang a lamp from anything — they get brackets and posts instead.
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
  // Stairwells. Each shaft is open the full six metres to the roof, so its one
  // lamp hangs at the very top and is strong enough to reach the bottom step —
  // a stairwell lit only at one end is a stairwell nobody can read. It sits
  // over the foot of the flight rather than its middle: from there the light
  // rakes along the risers instead of only landing on the treads, which is the
  // difference between a lit staircase and a ladder of black stripes.
  { id: 'stair-w', pos: { x: -14.8, y: ROOF - 0.3, z: -5.5 }, radius: 18, color: 0xd8e8ff,
    intensity: 7.0, ceiling: ROOF, storey: 'both' },
  { id: 'stair-e', pos: { x: 14.8, y: ROOF - 0.3, z: -6.5 }, radius: 18, color: 0xd8e8ff,
    intensity: 7.0, ceiling: ROOF, storey: 'both' },
  // Upper floor.
  { id: 'master', pos: { x: -10, y: L2, z: -10 }, radius: 9, color: 0xffc890, intensity: 1.2 },
  { id: 'spine2-w', pos: { x: -6, y: L2, z: -6 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'spine2-e', pos: { x: 7, y: L2, z: -6 }, radius: 8, color: 0xffd9a8, intensity: 1.0 },
  { id: 'study2', pos: { x: 2, y: L2, z: -10 }, radius: 7, color: 0xfff0d0, intensity: 1.0 },
  { id: 'bed3', pos: { x: 2, y: L2, z: -15 }, radius: 7, color: 0xffc890, intensity: 0.9 },
  { id: 'lounge', pos: { x: 2, y: L2, z: -2 }, radius: 8, color: 0xffd9a8, intensity: 1.2 },
  { id: 'media', pos: { x: 2, y: L2, z: 3.5 }, radius: 7, color: 0xffc890, intensity: 0.9 },
  { id: 'sauna', pos: { x: 10, y: L2, z: -2 }, radius: 8, color: 0xfff0d0, intensity: 1.0 },
  // Terrace: no roof to hang anything from. Two lamp posts stand at the far
  // corners by the parapet, and two brackets light the doors back inside.
  { id: 'terrace-post-w', pos: { x: -14.8, y: F2 + 2.2, z: 4.8 }, radius: 9, color: 0x9fb4c8,
    intensity: 0.8, mount: 'post', base: F2 },
  { id: 'terrace-post-e', pos: { x: -3.2, y: F2 + 2.2, z: 4.8 }, radius: 9, color: 0x9fb4c8,
    intensity: 0.8, mount: 'post', base: F2 },
  { id: 'terrace-door-n', pos: { x: -8, y: F2 + 2.3, z: -4.3 }, radius: 6, color: 0xd8e8ff,
    intensity: 0.7, mount: 'wall', face: { x: 0, z: 1 } },
  { id: 'terrace-door-e', pos: { x: -2.3, y: F2 + 2.3, z: -2 }, radius: 6, color: 0xd8e8ff,
    intensity: 0.7, mount: 'wall', face: { x: -1, z: 0 } },
];

// Rooms, as data rather than as an implication of where the walls happen to be.
// Nothing in the simulation needs this — walls do all the real work — but the
// floor plans are drawn from it, and it gives every space a name to argue about
// while the layout is being designed.
//
// `floor` 0 is the ground storey, 1 the upper one. The four rooms that wrap
// around a stairwell are given as their bounding box; the shaft is listed
// separately and drawn over them.
const rooms = [
  // ── Ground floor ──
  { id: 'living', name: 'Гостиная', floor: 0, min: { x: -16, z: -17.85 }, max: { x: -5, z: -7.4 } },
  { id: 'study', name: 'Кабинет', floor: 0, min: { x: -5, z: -17.85 }, max: { x: 1, z: -12.5 } },
  { id: 'guest-bed', name: 'Гостевая спальня', floor: 0, min: { x: 1, z: -17.85 }, max: { x: 7.5, z: -12.5 } },
  { id: 'bathroom', name: 'Санузел', floor: 0, min: { x: 7.5, z: -17.85 }, max: { x: 16, z: -12.5 } },
  { id: 'dining', name: 'Столовая', floor: 0, min: { x: -5, z: -12.5 }, max: { x: 1, z: -7.4 } },
  { id: 'kitchen', name: 'Кухня', floor: 0, min: { x: 1, z: -12.5 }, max: { x: 7.5, z: -7.4 } },
  { id: 'utility', name: 'Подсобная', floor: 0, min: { x: 7.5, z: -12.5 }, max: { x: 16, z: -7.4 } },
  { id: 'spine-0', name: 'Коридор', floor: 0, min: { x: -13.6, z: -7.4 }, max: { x: 13.6, z: -4.6 } },
  { id: 'cinema', name: 'Кинозал', floor: 0, min: { x: -16, z: -4.6 }, max: { x: -3, z: 1.5 } },
  { id: 'gallery', name: 'Холл', floor: 0, min: { x: -3, z: -4.6 }, max: { x: 3, z: 1.5 } },
  { id: 'gym', name: 'Спортзал', floor: 0, min: { x: 3, z: -4.6 }, max: { x: 13.6, z: 0 } },
  { id: 'cloakroom', name: 'Гардеробная', floor: 0, min: { x: -16, z: 1.5 }, max: { x: -3, z: 5.85 } },
  { id: 'foyer', name: 'Прихожая', floor: 0, min: { x: -3, z: 1.5 }, max: { x: 3, z: 5.85 } },
  { id: 'guest-suite', name: 'Гостевая', floor: 0, min: { x: 3, z: 0 }, max: { x: 9, z: 5.85 } },
  { id: 'spa', name: 'СПА', floor: 0, min: { x: 9, z: 0 }, max: { x: 16, z: 5.85 } },
  { id: 'landing', name: 'Площадка', floor: 0, outside: true,
    min: { x: -3, z: 6 }, max: { x: 3, z: 9.5 } },

  // ── Upper floor ──
  { id: 'master-bath', name: 'Ванная хозяев', floor: 1, min: { x: -16, z: -17.85 }, max: { x: -6, z: -12.5 } },
  { id: 'bed2', name: 'Спальня 2', floor: 1, min: { x: -6, z: -17.85 }, max: { x: -1, z: -12.5 } },
  { id: 'bed3', name: 'Спальня 3', floor: 1, min: { x: -1, z: -17.85 }, max: { x: 5, z: -12.5 } },
  { id: 'kids-bath', name: 'Санузел', floor: 1, min: { x: 5, z: -17.85 }, max: { x: 9, z: -12.5 } },
  { id: 'store', name: 'Кладовая', floor: 1, min: { x: 9, z: -17.85 }, max: { x: 16, z: -12.5 } },
  { id: 'master', name: 'Спальня хозяев', floor: 1, min: { x: -16, z: -12.5 }, max: { x: -6, z: -7.4 } },
  { id: 'wardrobe', name: 'Гардероб', floor: 1, min: { x: -6, z: -12.5 }, max: { x: -1, z: -7.4 } },
  { id: 'study2', name: 'Кабинет', floor: 1, min: { x: -1, z: -12.5 }, max: { x: 5, z: -7.4 } },
  { id: 'laundry', name: 'Прачечная', floor: 1, min: { x: 5, z: -12.5 }, max: { x: 16, z: -7.4 } },
  { id: 'spine-1', name: 'Коридор', floor: 1, min: { x: -13.6, z: -7.4 }, max: { x: 13.6, z: -4.6 } },
  { id: 'terrace', name: 'Терраса (без крыши)', floor: 1, min: { x: -16, z: -4.6 }, max: { x: -2, z: 5.85 } },
  { id: 'lounge', name: 'Гостиная', floor: 1, min: { x: -2, z: -4.6 }, max: { x: 6, z: 1 } },
  { id: 'sauna', name: 'Сауна', floor: 1, min: { x: 6, z: -4.6 }, max: { x: 16, z: 1 } },
  { id: 'media', name: 'Медиа', floor: 1, min: { x: -2, z: 1 }, max: { x: 6, z: 5.85 } },
  { id: 'office', name: 'Кабинет 2', floor: 1, min: { x: 6, z: 1 }, max: { x: 16, z: 5.85 } },

  // ── Stairwells: one shaft each, open from the ground floor to the roof ──
  { id: 'shaft-w', name: 'Лестница З', floor: 0, shaft: true, min: { x: -16, z: -12.5 }, max: { x: -13.6, z: -4.6 } },
  { id: 'shaft-e', name: 'Лестница В', floor: 0, shaft: true, min: { x: 13.6, z: -7.4 }, max: { x: 16, z: 1 } },
  { id: 'shaft-w-top', name: 'Лестница З', floor: 1, shaft: true, min: { x: -16, z: -12.5 }, max: { x: -13.6, z: -4.6 } },
  { id: 'shaft-e-top', name: 'Лестница В', floor: 1, shaft: true, min: { x: 13.6, z: -7.4 }, max: { x: 16, z: 1 } },
];

export const APARTMENT = {
  id: 'apartment',
  name: 'Пентхаус',
  bounds: { min: { x: -16.2, y: 0, z: -18.2 }, max: { x: 16.2, y: ROOF + 0.3, z: 9.7 } },
  // Where the upper storey begins. Nothing in this engine casts shadows, so
  // the renderer uses this to keep a lamp on one floor from shining through
  // the slab and lighting the other.
  upperFloorY: F2,
  geometry: [...shell, ...stairwells, ...groundWalls, ...upperWalls, ...props],
  rooms,
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
