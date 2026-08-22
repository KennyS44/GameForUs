// The map you go to when you want to know what your sight actually does.
//
// Everything else in this game is fought in a flat: eight metres of gloom, a
// doorway, and a man in it. Nothing there tells you what a 2.4× glass is worth,
// because nothing there is further away than the far wall of the kitchen. So
// this is the opposite building — one straight lane, fifty-odd metres of it,
// lit hard from end to end, with steel to shoot at and the distances written on
// the floor and the walls.
//
// It is a place to look through glass and learn where the rounds go. It is not
// a minigame: the plates do not fall, they do not score, they do not reset.
// They stand where they stand so that "twenty-five metres" stops being a number
// and becomes a picture.
//
// Axes as always: +X east, +Z south, +Y up. Single storey, floor at y = 0.
// The lane runs east: you spawn at the west end facing +X, and everything is
// measured downrange from the firing line at x = −26.

// The flat is the only other map, and it owns the palette: concrete, drywall,
// wood, glass, metal, tile, fabric, with the penetration numbers that make a
// wall cover and a door something everyone shoots through. The range uses the
// same table so it reads as the same game and behaves like it under fire.
//
// Only MATERIALS is exported from there — the builders (`wall`, `box`,
// `onLegs` and the rest of the furniture) are private to that file, so the two
// this map needs are written out again below rather than by prising them loose
// and disturbing the flat.
import { MATERIALS } from './apartment.js?v=5c4f7baa';

const M = MATERIALS;

const H = 3.6; // interior height: a hall, not a room
const T = 0.3; // shell thickness — concrete, which nothing on the roster crosses
const CANOPY = 2.8; // the lower ceiling over the firing line

// Where you stand. Every distance on this map is (x − LINE), so the numbers in
// the report and the numbers on the floor are the same numbers.
const LINE = -26.0;

// The inside faces of the shell.
const IN_X = 28.85;
const IN_Z = 4.85;

// Where the lane is marked, in metres downrange.
const MARKS = [5, 10, 25, 50];

function box(minX, minY, minZ, maxX, maxY, maxZ, material) {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ }, material };
}

// A straight run of wall. `axis` is not decoration: the floor plan draws a box
// as a wall only if it carries one, and the renderer and the checks both read
// it. No doorway gaps here — the range has no doors at all.
function wall(x1, z1, x2, z2, material, opts = {}) {
  const t = opts.thickness ?? T;
  const h = opts.height ?? H;
  const horizontal = Math.abs(x2 - x1) > Math.abs(z2 - z1);
  const b = horizontal
    ? box(Math.min(x1, x2), 0, z1 - t / 2, Math.max(x1, x2), h, z1 + t / 2, material)
    : box(x1 - t / 2, 0, Math.min(z1, z2), x1 + t / 2, h, Math.max(z1, z2), material);
  return { ...b, axis: horizontal ? 'x' : 'z' };
}

// A slab on four legs — the one piece of furniture on the range. Same shape as
// the flat's benches, written out here because that one is private to its file.
function onLegs(x0, z0, x1, z1, y, o = {}) {
  const h = o.h ?? 0.55;
  const thick = o.thick ?? 0.045;
  const mat = o.mat ?? M.wood;
  const leg = 0.06;
  const inset = 0.05;
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

// ── Shell ─────────────────────────────────────────────────────────────────
//
// Concrete on all four sides and over the top. That is not scenery: concrete
// has resist 0, so nothing on the roster leaves this building, which is the
// whole reason a range is built out of it.
const shell = [
  box(-29.2, -0.5, -5.2, 29.2, 0, 5.2, M.floor),
  box(-29.2, H, -5.2, 29.2, H + 0.3, 5.2, M.concrete), // roof

  wall(-29, -5, 29, -5, M.concrete), // north side
  wall(-29, 5, 29, 5, M.concrete), // south side
  wall(-29, -5, -29, 5, M.concrete), // west end, behind the shooter
  wall(29, -5, 29, 5, M.concrete), // east end, behind the backstop

  // The canopy over the firing line. The lane is a 3.6 m hall; the bay you
  // stand in is 2.8 m and closed overhead, which is what makes a firing line
  // read as covered rather than as the near end of a corridor.
  box(-IN_X, CANOPY, -IN_Z, -23.0, CANOPY + 0.2, IN_Z, M.concrete),

  // The backstop: two and a half metres of concrete across the far end, tall
  // enough that nothing sails over it and deep enough to be the thing that
  // stops the round rather than the wall behind it. Built as a wall rather
  // than as a block so the floor plan draws it — on paper this is the end of
  // the range, and a plan that leaves it out is a plan of an open lane.
  wall(27.525, -IN_Z, 27.525, IN_Z, M.concrete, { thickness: 2.65, height: 2.4 }),
];

// ── The firing line ───────────────────────────────────────────────────────
// A low bench behind the line, out of the way of everything: somewhere to put
// a magazine down, and the only thing in this building you can sit on.
const bench = onLegs(-27.4, -1.8, -26.8, 1.8, 0, { h: 0.55 });

// ── Targets ───────────────────────────────────────────────────────────────
//
// A steel plate at chest height on a pale board, on two legs. Ordinary
// geometry, so the bullet ray already hits it and a round that lands on steel
// sparks off steel — nothing here reacts, falls or keeps score, because this
// map is for reading a reticle, not for playing against.
//
// The board behind the plate is the part that earns its place: dark steel on
// dark concrete is invisible at forty metres, and a plate you cannot see is a
// plate you cannot learn from. Tile is the palest thing in the flat's table,
// and it is real geometry too, so shooting the white space around the plate
// still tells you where the round went.
//
// `d` is metres downrange, and the plate's front face is exactly there.
function target(d, z) {
  const x = LINE + d;
  const out = [
    // Feet, one under each leg.
    box(x - 0.04, 0, z - 0.41, x + 0.26, 0.05, z - 0.23, M.metal),
    box(x - 0.04, 0, z + 0.23, x + 0.26, 0.05, z + 0.41, M.metal),
    // Legs.
    box(x + 0.08, 0.05, z - 0.35, x + 0.14, 1.80, z - 0.29, M.metal),
    box(x + 0.08, 0.05, z + 0.29, x + 0.14, 1.80, z + 0.35, M.metal),
    // The board, let into the legs so it is carried by them rather than
    // touching them.
    box(x + 0.04, 0.85, z - 0.36, x + 0.10, 1.75, z + 0.36, M.tile),
    // The plate: 44 cm across, half a metre tall, centred at 1.30 m — the
    // middle of a standing man's chest.
    box(x, 1.05, z - 0.22, x + 0.06, 1.55, z + 0.22, M.metal),
  ];
  out[out.length - 1].note = `${d} м`;
  return out;
}

// Staggered across the lane so that from the middle of the firing line every
// one of them stands clear of the others: the near plates sit wide, the far
// ones close in on the centre line.
const targets = [
  ...target(5, -3.2),
  ...target(10, 3.2),
  ...target(15, -2.2),
  ...target(25, 2.2),
  ...target(35, -1.2),
  ...target(50, 0),
];

// ── Distance markers ──────────────────────────────────────────────────────
//
// A pair of posts at each marked distance, one off each side wall, capped in
// the same pale tile as the target boards so they carry down the lane. Two and
// not one because there are plates standing in the lane: from the far end of
// the firing line a single post spends half its life behind whichever target
// is nearer, and a marker you cannot see from where you are standing is not a
// marker. A pair is also a gate, and a gate is a shape you read at fifty
// metres.
//
// The post is 1.2 m to the cap, which is the second thing it does: a known
// height at a known distance is what a mil reticle is for.
//
// The paint that goes with it — a band up each side wall and a stripe across
// the floor — is decoration, further down.
function markerPost(d) {
  const x = LINE + d;
  return [-4.45, 4.45].flatMap((z) => [
    box(x - 0.05, 0, z - 0.05, x + 0.05, 1.20, z + 0.05, M.metal),
    { ...box(x - 0.09, 1.20, z - 0.09, x + 0.09, 1.32, z + 0.09, M.tile), note: `${d} м` },
  ]);
}

const markerPosts = MARKS.flatMap(markerPost);

// Everything on the range that is not the building is furniture, and the
// checks hold furniture to the rule that says nothing floats.
const fittings = [...bench, ...targets, ...markerPosts].map((b) => ({ ...b, tag: 'furniture' }));

const solid = [...shell, ...fittings];

// ── Lighting ──────────────────────────────────────────────────────────────
//
// The flat is dark on purpose and this is the one place that is not. You
// cannot judge where a reticle sits on a plate in the dark, and a range lit
// from one end has a bright bay and forty metres of guesswork after it — so
// the lamps march down the middle of the lane at six-metre spacing with a
// reach that overlaps, and the light is flat from the line to the backstop.
const LANE_Y = H - 0.35; // just under the roof slab
const BAY_Y = CANOPY - 0.25; // just under the canopy

const lights = [
  { id: 'bay-w', pos: { x: -27.4, y: BAY_Y, z: 0 }, radius: 10, color: 0xfff0d0, intensity: 1.5, ceiling: CANOPY },
  { id: 'bay-e', pos: { x: -24.4, y: BAY_Y, z: 0 }, radius: 10, color: 0xfff0d0, intensity: 1.5, ceiling: CANOPY },
  ...[-21, -15, -9, -3, 3, 9, 15, 21, 27].map((x) => ({
    id: `lane${x}`,
    pos: { x, y: LANE_Y, z: 0 },
    radius: 14,
    color: 0xfff0d0,
    intensity: 1.8,
    ceiling: H,
  })),
];

// ── Rooms ─────────────────────────────────────────────────────────────────
// One space, cut into three on paper: the bay you shoot from and the two
// halves of the lane. The split is at the 25 m mark, so the plan says which
// half of the range you are looking at.
const rooms = [
  { id: 'bay', name: 'Огневой рубеж', floor: 0, min: { x: -IN_X, z: -IN_Z }, max: { x: -23, z: IN_Z } },
  { id: 'lane-near', name: 'Директриса, 0–25 м', floor: 0, min: { x: -23, z: -IN_Z }, max: { x: -1, z: IN_Z } },
  { id: 'lane-far', name: 'Директриса, 25–50 м', floor: 0, min: { x: -1, z: -IN_Z }, max: { x: 26.2, z: IN_Z } },
];

// ── Paint ─────────────────────────────────────────────────────────────────
//
// Drawn and nothing else — not in `geometry`, so the simulation never hears
// about it: no collision, no bullets stopped, nothing in the walkable graph.
// The rule the flat's decoration lives by holds here too, and it is easy to
// keep on a range: paint is two or three centimetres thick and lies flat on
// the surface it was rolled onto. Nobody has ever tried to hide behind a
// stripe.
const PAINT = {
  // Pale, because it goes onto concrete and has to be read at fifty metres.
  mark: { name: 'deco-mark', color: 0xc9c2b2 },
  // The line itself, in the amber every range paints it: stand behind this.
  line: { name: 'deco-line', color: 0xb8863c },
};

// A band up both side walls and a stripe across the floor. The stripe is what
// you actually read — looking down a lane, the floor is the surface you see
// most of — and the bands are what you read when you are lying behind the
// sight and the floor has gone out of the picture.
function markerPaint(d) {
  const x = LINE + d;
  return [
    box(x - 0.10, 0.05, -IN_Z, x + 0.10, 2.20, -IN_Z + 0.03, PAINT.mark),
    box(x - 0.10, 0.05, IN_Z - 0.03, x + 0.10, 2.20, IN_Z, PAINT.mark),
    box(x - 0.075, 0.002, -IN_Z, x + 0.075, 0.018, IN_Z, PAINT.mark),
  ];
}

const decor = [
  ...MARKS.flatMap(markerPaint),

  // The firing line, painted where you stand rather than a stride in front of
  // it: toes on the line is what a firing line means, and it keeps every
  // distance on this map honest — the paint and the spawn are the same x.
  box(LINE - 0.075, 0.002, -IN_Z, LINE + 0.075, 0.018, IN_Z, PAINT.line),

  // The backstop, painted pale above the height a plate stands at, so the far
  // target is seen against something other than more concrete.
  box(26.17, 0.60, -IN_Z, 26.20, 2.30, IN_Z, PAINT.mark),

  // A board on the end wall behind the bench, so the bay is not a blank box.
  box(-IN_X, 1.20, -1.20, -IN_X + 0.03, 2.00, 1.20, PAINT.mark),
].map((b) => ({ ...b, tag: 'decor' }));

export const RANGE = {
  id: 'range',
  name: 'Полигон',
  // Written under the title on the drawn plan; see tools/floorplan.mjs.
  planNote: 'Огневой рубеж слева, мишени по директрисе, за 50 м — пулеулавливатель. Столбики — отметки дистанции.',
  bounds: { min: { x: -29.2, y: 0, z: -5.2 }, max: { x: 29.2, y: H + 0.3, z: 5.2 } },
  // Single storey. `null` rather than a number, because there is no second
  // floor here and every reader of this field treats a missing one correctly.
  upperFloorY: null,
  // Clear air the whole length of the lane. The flat's own figures start
  // closing at eleven metres and have swallowed everything by forty-two, which
  // is atmosphere indoors and a fault here: the 50 m plate is the one you came
  // to look at. See CLEAR_FOG in src/render/scene.js.
  fog: { near: 40, far: 140 },
  // Not a place where anything is at stake. Nobody is scored, nobody dies, and
  // the point of standing here is to try things — so the rack stays open and
  // the pockets never empty. The simulation reads this off the map rather than
  // being told by the menu, because it is the simulation that refuses a weapon
  // change once a round has started, and it has to know when not to.
  practice: true,
  geometry: solid,
  rooms,
  // No doors, no ways through, no holes, no stairs and no consumer unit: the
  // range is one room with a wall round it. The fields stay so the shape of a
  // map is the same shape everywhere.
  doors: [],
  openings: [],
  holes: [],
  stairways: [],
  switches: [],
  lights,
  decor,
  // Eight places on the line, four to a side, 90 cm apart — far enough not to
  // stand in each other and all at the same x, so "five metres" means the same
  // thing from every one of them. Yaw −π/2 is looking down the lane.
  spawns: {
    attackers: [-3.15, -2.25, -1.35, -0.45].map((z) => ({ x: LINE, z, yaw: -Math.PI / 2 })),
    defenders: [0.45, 1.35, 2.25, 3.15].map((z) => ({ x: LINE, z, yaw: -Math.PI / 2 })),
  },
  // Nobody is held anywhere. On a range the staging minute is just more time
  // on the line, and there is no other side of the map to keep anyone off.
  prep: { attackersHeld: [], defendersBarred: [] },
};
