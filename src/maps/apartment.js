// Map data — plain data only, no engine types. The renderer and the simulation
// both read this, so geometry can never drift between what you see and what you hit.
//
// Axes: +X east, +Z south, +Y up. Yaw 0 faces -Z (north).
//
//   z=-6  ┌─────────────────────┬──────────────┐
//         │                     │   BEDROOM    │
//         │   LIVING ROOM       ├───door───────┤
//   z=-1  │                     │              │
//         │                     │   KITCHEN    │
//   z= 3  ├──────door───────────┼──door────────┤
//         │  BATHROOM │  HALL   │              │
//   z= 6  └───────────┴──FRONT──┴──────────────┘
//                        DOOR
//                     (landing / attacker spawn)

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

const WALL_H = 3.0;

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

const walls = [
  // ── Outer shell (concrete, unbreachable) ────────────────────────────────
  ...wall(-7, 6, 7, 6, M.concrete, {
    thickness: 0.25,
    gaps: [{ at: 0, width: 1.1 }], // front door
  }),
  ...wall(-7, -6, 7, -6, M.concrete, { thickness: 0.25 }),
  ...wall(-7, -6, -7, 6, M.concrete, { thickness: 0.25 }),
  ...wall(7, -6, 7, 6, M.concrete, { thickness: 0.25 }),

  // ── Landing outside the front door (attacker spawn) ─────────────────────
  ...wall(-3, 9.5, 3, 9.5, M.concrete, { thickness: 0.25 }),
  ...wall(-3, 6, -3, 9.5, M.concrete, { thickness: 0.25 }),
  ...wall(3, 6, 3, 9.5, M.concrete, { thickness: 0.25 }),

  // ── Interior partitions (drywall — shootable through) ───────────────────
  // Bathroom + hall north wall, with the living-room doorway.
  ...wall(-7, 3, 1, 3, M.drywall, { gaps: [{ at: -0.5, width: 1.0 }] }),
  // Bathroom / hall.
  ...wall(-2, 3, -2, 6, M.drywall, { gaps: [{ at: 4.5, width: 0.9 }] }),
  // Hall / kitchen, and living / kitchen+bedroom — one long spine.
  ...wall(1, 3, 1, 6, M.drywall, { gaps: [{ at: 4.5, width: 1.0 }] }),
  ...wall(1, -6, 1, 3, M.drywall, {
    gaps: [
      { at: 1, width: 1.0 }, // living → kitchen
      { at: -3.5, width: 1.0 }, // living → bedroom
    ],
  }),
  // Bedroom / kitchen.
  ...wall(1, -1, 7, -1, M.drywall, { gaps: [{ at: 5, width: 0.9 }] }),
];

// Floor and ceiling.
const shell = [
  box(-7.5, -0.5, -6.5, 7.5, 0, 10, M.floor), // floor
  box(-7.5, 3.0, -6.5, 7.5, 3.3, 6.2, M.concrete), // ceiling (flat interior)
  box(-3.2, 3.0, 6, 3.2, 3.3, 10, M.concrete), // ceiling over landing
];

// Furniture — cover you can hide behind, and mostly shoot through.
const props = [
  box(-6.2, 0, -3.4, -5.4, 0.85, 0.4, M.fabric), // sofa, living room west
  box(-4.6, 0, -1.6, -2.2, 0.75, -0.7, M.wood), // coffee table
  box(-6.6, 0, -5.6, -4.0, 1.9, -5.2, M.wood), // shelving unit, north wall
  box(1.6, 0, 0.2, 6.6, 0.92, 0.9, M.wood), // kitchen counter
  box(5.6, 0, 1.4, 6.6, 1.85, 3.2, M.metal), // fridge
  box(2.0, 0, -5.4, 4.6, 0.55, -2.6, M.fabric), // bed
  box(5.4, 0, -5.6, 6.6, 1.4, -4.6, M.wood), // wardrobe
  box(-6.6, 0, 4.2, -5.4, 0.9, 5.6, M.metal), // bathroom sink block
];

// Doors. `axis` is the wall's axis; the panel swings around `hinge`.
// `swing` is which way it opens (+1 / -1 in the perpendicular axis).
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
  { id: 'living-hall', pos: { x: -0.5, z: 3 }, axis: 'x', width: 1.0, hinge: 1, swing: 1, material: M.wood },
  { id: 'bathroom', pos: { x: -2, z: 4.5 }, axis: 'z', width: 0.9, hinge: -1, swing: 1, material: M.wood },
  { id: 'hall-kitchen', pos: { x: 1, z: 4.5 }, axis: 'z', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'living-kitchen', pos: { x: 1, z: 1 }, axis: 'z', width: 1.0, hinge: -1, swing: 1, material: M.wood },
  { id: 'living-bedroom', pos: { x: 1, z: -3.5 }, axis: 'z', width: 1.0, hinge: 1, swing: -1, material: M.wood },
  { id: 'kitchen-bedroom', pos: { x: 5, z: -1 }, axis: 'x', width: 0.9, hinge: -1, swing: -1, material: M.wood },
];

const lights = [
  { id: 'living', pos: { x: -3, y: 2.65, z: -2 }, radius: 9, color: 0xffd9a8, intensity: 1.5 },
  { id: 'living2', pos: { x: -3.5, y: 2.65, z: 1.5 }, radius: 7, color: 0xffd9a8, intensity: 1.0 },
  { id: 'kitchen', pos: { x: 4, y: 2.65, z: 2.5 }, radius: 8, color: 0xfff0d0, intensity: 1.4 },
  { id: 'bedroom', pos: { x: 4, y: 2.65, z: -3.5 }, radius: 8, color: 0xffc890, intensity: 1.1 },
  { id: 'hall', pos: { x: -0.5, y: 2.65, z: 4.6 }, radius: 6, color: 0xffd9a8, intensity: 1.2 },
  { id: 'bathroom', pos: { x: -4.5, y: 2.65, z: 4.6 }, radius: 6, color: 0xd8e8ff, intensity: 1.0 },
  { id: 'landing', pos: { x: 0, y: 2.65, z: 8 }, radius: 7, color: 0x9fb4c8, intensity: 0.8 },
];

export const APARTMENT = {
  id: 'apartment',
  name: 'Квартира',
  bounds: { min: { x: -7.5, y: 0, z: -6.5 }, max: { x: 7.5, y: 3, z: 10 } },
  geometry: [...shell, ...walls, ...props],
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
    // Defenders hold the flat.
    defenders: [
      { x: -4.5, z: -3.5, yaw: Math.PI * 0.75 },
      { x: 4.0, z: -4.5, yaw: Math.PI },
      { x: 4.5, z: 2.0, yaw: Math.PI },
      { x: -5.0, z: 1.0, yaw: Math.PI },
    ],
  },
};
