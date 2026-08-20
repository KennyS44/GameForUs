// Viewmodels, built straight off the blueprint sheets.
//
// Every part below is the same millimetre figure that is printed in
// docs/weapons/<id>.svg: x runs rearward from the muzzle, y is measured from
// the bore axis, positive up, and widths are the ones written on the sheet.
// One number, one gun, three places — the drawing, the simulation and the
// thing in the player's hands.
//
// Blockouts, not props: a dozen masses each. What has to read at arm's length
// is the silhouette — a bullpup with the magazine on its back is not the same
// shape as a sawn-off, and that difference is the whole point of the roster.

import * as THREE from '../../vendor/three.module.js?v=49b50937';

const MM = 0.001;

// A touch of emissive keeps the silhouette readable when every light is out.
const MATS = {
  // Steel and polymer are the two halves of every weapon here, and they were
  // near enough the same shade of black that a receiver read as one lump.
  // Now the metal catches the light and the plastic drinks it: which part of
  // a gun you are looking at is something you can see.
  steel: new THREE.MeshStandardMaterial({
    color: 0x3c424c, roughness: 0.34, metalness: 0.9, emissive: 0x0f1218,
  }),
  polymer: new THREE.MeshStandardMaterial({
    color: 0x15171c, roughness: 0.92, metalness: 0.04, emissive: 0x080a0e,
  }),
  rubber: new THREE.MeshStandardMaterial({
    color: 0x0c0d10, roughness: 1.0, metalness: 0.0, emissive: 0x060709,
  }),
  // Webbing: the sling, and anything else woven.
  webbing: new THREE.MeshStandardMaterial({
    color: 0x262a31, roughness: 1.0, metalness: 0.0, emissive: 0x090b0e,
  }),
  glass: new THREE.MeshStandardMaterial({
    color: 0x2a3a44, roughness: 0.2, metalness: 0.3, emissive: 0x0a1016,
  }),
  glove: new THREE.MeshStandardMaterial({
    color: 0x2b2e35, roughness: 1.0, emissive: 0x0d0f14,
  }),
  // The sleeve above the glove. A gun with nothing behind it hangs in mid-air;
  // what stops that is a forearm running off the bottom of the screen.
  sleeve: new THREE.MeshStandardMaterial({
    color: 0x1b1f26, roughness: 1.0, emissive: 0x080a0d,
  }),
  // The optic's window. Barely there, but it tells you the tube has glass in
  // it — and it sits in front of the dot, the way a real sight is built.
  lens: new THREE.MeshBasicMaterial({
    color: 0x4d6f82, transparent: true, opacity: 0.16, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
  }),
  // The aiming mark itself. Unlit and out of the tone mapper: a projected
  // reticle is light, not a painted object, and it has to stay the same
  // brightness in a black corridor and in a lit room.
  dot: new THREE.MeshBasicMaterial({ color: 0xff2f1c, toneMapped: false }),
  glow: new THREE.MeshBasicMaterial({
    color: 0xff3a22, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false,
  }),
  // A scope's crosshair is etched glass. Ours is pale rather than black: this
  // flat is dark, and a black reticle on a dark doorway is no reticle at all.
  etch: new THREE.MeshBasicMaterial({
    color: 0x9aa1a9, transparent: true, opacity: 0.9, toneMapped: false,
  }),
  // Sight housings are open at both ends and drawn from the inside as well as
  // the outside: aim down one and you look through it, not at it.
  housing: new THREE.MeshStandardMaterial({
    color: 0x1b1d22, roughness: 0.6, metalness: 0.5, emissive: 0x0a0c10,
    side: THREE.DoubleSide,
  }),
};

// ── Part types ─────────────────────────────────────────────────────────────
//
// ['slab', x0, x1, yLow, yHigh, width, material, tilt?] — a rectangular mass,
//   optionally raked back like a pistol grip or a curved magazine.
// ['rod',  x0, x1, radius, material, y?] — barrels, tubes and scope bodies.
//   `y` lifts it off the bore, which is where a scope tube actually sits.
// ['ring', x, radius, thickness, material, y?] — a rear aperture or a lens rim.
// ['sight', x0, x1, radius, y] — an open-ended housing: a red dot's tube or a
//   scope body, hollow so aiming through it shows the room and not a slab.

// Nothing in a workshop has a square edge. A chamfer of a millimetre or two
// down every long corner is the difference between a machined part and a
// child's brick, and it costs one extra quad per corner: the profile is a
// rectangle with its corners cut, extruded along the part.
//
// Geometry is cached by size, because a roster of eleven weapons repeats the
// same few masses over and over.
const boxCache = new Map();
function chamferedBox(w, h, d) {
  const key = `${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}`;
  if (boxCache.has(key)) return boxCache.get(key);

  const c = Math.min(0.004, Math.min(w, h) * 0.22);
  const x = w / 2;
  const y = h / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-x + c, -y);
  shape.lineTo(x - c, -y);
  shape.lineTo(x, -y + c);
  shape.lineTo(x, y - c);
  shape.lineTo(x - c, y);
  shape.lineTo(-x + c, y);
  shape.lineTo(-x, y - c);
  shape.lineTo(-x, -y + c);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -d / 2);
  geo.computeVertexNormals();
  boxCache.set(key, geo);
  return geo;
}

function partsToGroup(parts, anchor) {
  const group = new THREE.Group();
  const z = (x) => (x - anchor) * MM;

  for (const part of parts) {
    const [kind] = part;
    if (kind === 'slab') {
      const [, x0, x1, yLow, yHigh, width, mat, tilt = 0] = part;
      const len = Math.abs(x1 - x0) * MM;
      const height = Math.abs(yHigh - yLow) * MM;
      const mesh = new THREE.Mesh(
        chamferedBox(width * MM, height, len),
        MATS[mat],
      );
      mesh.position.set(0, ((yLow + yHigh) / 2) * MM, z((x0 + x1) / 2));
      mesh.rotation.x = tilt;
      group.add(mesh);
    } else if (kind === 'rod') {
      const [, x0, x1, radius, mat, y = 0] = part;
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * MM, radius * MM, Math.abs(x1 - x0) * MM, 16),
        MATS[mat],
      );
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(0, y * MM, z((x0 + x1) / 2));
      group.add(mesh);
    } else if (kind === 'sight') {
      const [, x0, x1, radius, y = 0] = part;
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * MM, radius * MM, Math.abs(x1 - x0) * MM, 14, 1, true),
        MATS.housing,
      );
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(0, y * MM, z((x0 + x1) / 2));
      group.add(mesh);
    } else if (kind === 'ring') {
      const [, x, radius, thickness, mat, y = 0] = part;
      const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(radius * MM, thickness * MM, 6, 14),
        MATS[mat],
      );
      mesh.position.set(0, y * MM, z(x));
      group.add(mesh);
    }
  }
  return group;
}

// ── The roster, transcribed from the sheets ────────────────────────────────
//
// `grip` is where the firing hand sits, in sheet millimetres from the muzzle.
// Everything hangs off it: it is the one point of a weapon that stays still
// relative to the shooter, so the model is anchored there and a 1448 mm rifle
// puts its extra length out in front rather than through the player's face.
// `sight` is the aiming reference — the middle of the optic on the rail — and
// the renderer lines it up with the centre of the screen when you aim.

const BUILDS = {
  // Roller-locked 9 mm: telescoping stock, magazine raked forward.
  'smg-9-roller': {
    oal: 680, grip: 400, support: 150, sight: [346, 83],
    parts: [
      ['rod', 0, 52, 13, 'steel'],
      ['rod', 46, 226, 9, 'steel'],
      ['slab', 46, 214, -30, 27, 52, 'polymer'],
      ['slab', 44, 494, 30, 40, 22, 'steel'],
      ['slab', 214, 494, -22, 30, 45, 'steel'],
      ['slab', 236, 424, -64, -22, 40, 'steel'],
      ['slab', 244, 316, -212, -64, 26, 'polymer', 0.17],
      ['slab', 368, 442, -196, -64, 40, 'polymer', 0.28],
      ['slab', 494, 524, -12, 18, 30, 'steel'],
      ['slab', 520, 654, -14, 16, 26, 'steel'],
      ['slab', 654, 680, -40, 46, 45, 'rubber'],
      ['slab', 290, 320, 40, 68, 26, 'steel'],
      ['slab', 372, 402, 40, 68, 26, 'steel'],
      ['sight', 276, 416, 19, 83],
      ['ring', 279, 19, 3, 'steel', 83],
      ['ring', 413, 19, 3, 'steel', 83],
    ],
  },

  // Bullpup PDW: one polymer shell, the magazine lying flat along its back.
  'smg-57-pdw': {
    oal: 500, grip: 316, support: 196, sight: [264, 111],
    parts: [
      ['rod', 0, 44, 11, 'steel'],
      ['rod', 38, 150, 8, 'steel'],
      ['slab', 34, 500, -54, 26, 55, 'polymer'],
      ['slab', 166, 222, -134, -52, 42, 'polymer'],
      ['slab', 286, 356, -152, -54, 48, 'polymer'],
      ['slab', 430, 500, -104, 14, 55, 'polymer'],
      ['slab', 134, 394, 26, 62, 40, 'polymer'],
      ['slab', 140, 392, 62, 72, 22, 'steel'],
      ['slab', 212, 242, 72, 97, 26, 'steel'],
      ['slab', 286, 316, 72, 97, 26, 'steel'],
      ['sight', 198, 330, 17, 111],
      ['ring', 201, 17, 3, 'steel', 111],
      ['ring', 327, 17, 3, 'steel', 111],
      ['slab', 468, 500, -104, 14, 58, 'rubber'],
    ],
  },

  // .45 with the magazine in the grip: tall receiver, side-folding stock.
  'smg-45-inline': {
    oal: 640, grip: 340, support: 120, sight: [281, 96],
    parts: [
      ['rod', 0, 46, 12, 'steel'],
      ['rod', 40, 142, 8, 'steel'],
      ['slab', 40, 190, -32, 30, 50, 'polymer'],
      ['slab', 38, 426, 44, 54, 22, 'steel'],
      ['slab', 142, 426, -30, 44, 48, 'steel'],
      ['slab', 180, 426, 44, 62, 44, 'steel'],
      ['slab', 296, 376, -150, -30, 44, 'polymer', 0.12],
      ['slab', 304, 376, -276, -150, 30, 'polymer', 0.12],
      ['slab', 426, 614, -20, 30, 40, 'polymer'],
      ['slab', 614, 640, -34, 40, 48, 'rubber'],
      ['slab', 226, 256, 54, 81, 26, 'steel'],
      ['slab', 306, 336, 54, 81, 26, 'steel'],
      ['sight', 212, 350, 18, 96],
      ['ring', 215, 18, 3, 'steel', 96],
      ['ring', 347, 18, 3, 'steel', 96],
    ],
  },

  // 5.45 long-stroke piston: the gas tube above the barrel is the profile.
  'ar-545-piston': {
    oal: 940, grip: 500, support: 178, sight: [462, 87],
    parts: [
      ['rod', 0, 68, 16, 'steel'],
      ['rod', 60, 300, 9, 'steel'],
      ['slab', 120, 300, 16, 34, 20, 'steel'],
      ['slab', 148, 196, -14, 48, 26, 'steel'],
      ['slab', 58, 302, -34, 34, 56, 'polymer'],
      ['slab', 56, 606, 34, 44, 22, 'steel'],
      ['slab', 302, 606, -26, 34, 42, 'steel'],
      ['slab', 340, 526, -70, -26, 38, 'steel'],
      ['slab', 352, 436, -256, -70, 26, 'polymer', 0.22],
      ['slab', 468, 544, -206, -70, 40, 'polymer', 0.28],
      ['slab', 606, 912, -14, 18, 28, 'steel'],
      ['slab', 646, 912, 18, 52, 44, 'polymer'],
      ['slab', 912, 940, -44, 52, 46, 'rubber'],
      ['slab', 406, 436, 44, 72, 26, 'steel'],
      ['slab', 488, 518, 44, 72, 26, 'steel'],
      ['sight', 392, 532, 19, 87],
      ['ring', 395, 19, 3, 'steel', 87],
      ['ring', 529, 19, 3, 'steel', 87],
    ],
  },

  // 5.56 short-stroke piston: continuous rail, telescoping stock.
  'ar-556-piston': {
    oal: 800, grip: 554, support: 212, sight: [484, 84],
    parts: [
      ['rod', 0, 60, 14, 'steel'],
      ['rod', 52, 368, 9, 'steel'],
      ['slab', 50, 300, -32, 32, 52, 'polymer'],
      ['slab', 48, 618, 32, 42, 22, 'steel'],
      ['slab', 344, 618, -24, 32, 40, 'steel'],
      ['slab', 618, 652, 6, 30, 20, 'steel'],
      ['slab', 396, 580, -76, -24, 38, 'steel'],
      ['slab', 404, 480, -244, -76, 25, 'polymer', 0.11],
      ['slab', 522, 598, -212, -76, 40, 'polymer', 0.28],
      ['slab', 636, 774, -16, 16, 30, 'steel'],
      ['slab', 664, 774, 16, 48, 42, 'polymer'],
      ['slab', 774, 800, -42, 48, 44, 'rubber'],
      ['slab', 428, 458, 42, 69, 26, 'steel'],
      ['slab', 510, 540, 42, 69, 26, 'steel'],
      ['sight', 414, 554, 18, 84],
      ['ring', 417, 18, 3, 'steel', 84],
      ['ring', 551, 18, 3, 'steel', 84],
    ],
  },

  // 5.56 with a monolithic rail and a folding stock: longer, flatter on top.
  'ar-556-folder': {
    oal: 890, grip: 572, support: 206, sight: [480, 86],
    parts: [
      ['rod', 0, 62, 15, 'steel'],
      ['rod', 54, 351, 9, 'steel'],
      ['slab', 52, 300, -34, 30, 54, 'polymer'],
      ['slab', 50, 646, 34, 44, 24, 'steel'],
      ['slab', 330, 646, -26, 34, 48, 'steel'],
      ['slab', 396, 646, -78, -26, 42, 'polymer'],
      ['slab', 396, 474, -258, -78, 25, 'polymer', 0.10],
      ['slab', 540, 616, -214, -78, 40, 'polymer', 0.28],
      ['slab', 646, 866, -44, 52, 46, 'polymer'],
      ['slab', 866, 890, -50, 62, 48, 'rubber'],
      ['slab', 422, 452, 44, 71, 26, 'steel'],
      ['slab', 508, 538, 44, 71, 26, 'steel'],
      ['sight', 408, 552, 18, 86],
      ['ring', 411, 18, 3, 'steel', 86],
      ['ring', 549, 18, 3, 'steel', 86],
    ],
  },

  // Sawn-off double: two barrels, a break-action frame and nothing else.
  'sg-12-double': {
    oal: 420, grip: 370, support: 176, sling: false, sight: [359, 74],
    parts: [
      ['slab', 0, 300, 3, 26, 46, 'steel'],
      ['slab', 0, 300, -26, -3, 46, 'steel'],
      ['slab', 0, 12, -28, 28, 48, 'rubber'],
      ['slab', 120, 232, -54, -26, 52, 'polymer'],
      ['slab', 298, 420, -36, 33, 44, 'steel'],
      ['slab', 304, 414, 36, 42, 22, 'steel'],
      ['slab', 324, 354, 46, 64, 24, 'steel'],
      ['slab', 364, 394, 46, 64, 24, 'steel'],
      ['sight', 310, 408, 12, 74],
      ['ring', 313, 12, 3, 'steel', 74],
      ['ring', 405, 12, 3, 'steel', 74],
      ['slab', 334, 430, -178, -36, 42, 'polymer', 0.30],
    ],
  },

  // Pump gun: the magazine tube under the barrel and a forend that rides it.
  'sg-12-pump': {
    oal: 1000, grip: 636, support: 226, sight: [570, 78],
    parts: [
      ['slab', 0, 52, -22, 22, 40, 'steel'],
      ['rod', 46, 470, 11, 'steel'],
      ['slab', 60, 430, -40, -18, 22, 'steel'],
      ['slab', 150, 304, -52, -12, 58, 'polymer'],
      ['slab', 470, 684, -28, 30, 44, 'steel'],
      ['slab', 478, 676, 30, 40, 22, 'steel'],
      ['slab', 514, 544, 40, 64, 26, 'steel'],
      ['slab', 596, 626, 40, 64, 26, 'steel'],
      ['sight', 500, 640, 16, 78],
      ['ring', 503, 16, 3, 'steel', 78],
      ['ring', 637, 16, 3, 'steel', 78],
      ['slab', 468, 500, -66, -30, 36, 'steel'],
      ['slab', 598, 700, -172, -28, 42, 'polymer', 0.30],
      ['slab', 684, 968, -14, 18, 30, 'steel'],
      ['slab', 712, 968, 18, 54, 44, 'polymer'],
      ['slab', 968, 1000, -44, 54, 46, 'rubber'],
    ],
  },

  // Magazine-fed semi-auto 12 gauge: a rifle's layout, everything thicker.
  'sg-12-mag': {
    oal: 940, grip: 522, support: 180, sight: [444, 89],
    parts: [
      ['rod', 0, 58, 18, 'steel'],
      ['rod', 50, 290, 11, 'steel'],
      ['slab', 126, 290, 18, 38, 22, 'steel'],
      ['slab', 150, 202, -16, 52, 28, 'steel'],
      ['slab', 58, 292, -36, 38, 58, 'polymer'],
      ['slab', 56, 596, 38, 48, 24, 'steel'],
      ['slab', 292, 596, -28, 38, 46, 'steel'],
      ['slab', 330, 548, -76, -28, 44, 'steel'],
      ['slab', 336, 460, -286, -76, 62, 'polymer', 0.15],
      ['slab', 490, 568, -214, -76, 40, 'polymer', 0.28],
      ['slab', 596, 916, -46, 56, 48, 'polymer'],
      ['slab', 916, 940, -52, 62, 50, 'rubber'],
      ['slab', 388, 418, 48, 74, 26, 'steel'],
      ['slab', 470, 500, 48, 74, 26, 'steel'],
      ['sight', 374, 514, 17, 89],
      ['ring', 377, 17, 3, 'steel', 89],
      ['ring', 511, 17, 3, 'steel', 89],
    ],
  },

  // .50 anti-materiel: barrel shroud, bipod, and a scope you look through.
  'amr-50': {
    oal: 1448, grip: 1000, support: 320, sight: [750, 130], optic: 'scope',
    parts: [
      ['rod', 0, 118, 30, 'steel'],
      ['rod', 110, 520, 15, 'steel'],
      ['slab', 150, 520, 30, 46, 34, 'steel'],
      ['slab', 126, 520, -44, 30, 60, 'polymer'],
      ['slab', 124, 1150, 46, 60, 30, 'steel'],
      ['slab', 520, 1150, -44, 46, 60, 'steel'],
      ['slab', 690, 1040, -96, -44, 52, 'steel'],
      ['slab', 700, 856, -320, -96, 40, 'polymer', 0.08],
      ['slab', 966, 1050, -236, -96, 44, 'polymer', 0.26],
      ['slab', 1150, 1424, -78, 62, 56, 'polymer'],
      ['slab', 1424, 1448, -80, 46, 58, 'rubber'],
      ['sight', 560, 940, 26, 130],
      ['sight', 560, 624, 34, 130],
      ['sight', 880, 940, 32, 130],
      ['ring', 562, 34, 5, 'steel', 130],
      ['ring', 938, 32, 5, 'steel', 130],
      ['slab', 626, 660, 60, 112, 30, 'steel'],
      ['slab', 846, 880, 60, 112, 30, 'steel'],
      ['slab', 300, 340, -284, -44, 18, 'steel', 0.34],
      ['slab', 300, 340, -284, -44, 18, 'steel', -0.34],
    ],
  },

  // 7.62 marksman: carbine layout stretched, scope and bipod as drawn.
  'dmr-762': {
    oal: 1120, grip: 662, support: 210, sight: [606, 100], optic: 'scope',
    parts: [
      ['rod', 0, 70, 15, 'steel'],
      ['rod', 60, 508, 10, 'steel'],
      ['slab', 58, 462, -36, 32, 54, 'polymer'],
      ['slab', 56, 716, 32, 42, 24, 'steel'],
      ['slab', 462, 716, -26, 32, 42, 'steel'],
      ['slab', 716, 754, 6, 30, 20, 'steel'],
      ['slab', 498, 692, -80, -26, 40, 'steel'],
      ['slab', 506, 592, -262, -80, 26, 'polymer', 0.09],
      ['slab', 630, 708, -216, -80, 40, 'polymer', 0.28],
      ['slab', 740, 1094, -16, 18, 32, 'steel'],
      ['slab', 768, 1094, 18, 54, 44, 'polymer'],
      ['slab', 1094, 1120, -46, 54, 46, 'rubber'],
      ['sight', 452, 760, 20, 99],
      ['sight', 452, 504, 27, 99],
      ['sight', 716, 760, 25, 99],
      ['ring', 454, 27, 4, 'steel', 99],
      ['ring', 758, 25, 4, 'steel', 99],
      ['slab', 512, 542, 42, 82, 24, 'steel'],
      ['slab', 676, 706, 42, 82, 24, 'steel'],
      ['slab', 190, 230, -246, -36, 16, 'steel', 0.32],
      ['slab', 190, 230, -246, -36, 16, 'steel', -0.32],
    ],
  },
};

// Viewmodels are not to scale with the world and never have been: a rifle held
// at true size fills the screen. Long guns are compressed toward the reference
// SMG rather than shrunk to match it, so an AMR still reads as an armful.
function viewScale(oal) {
  return Math.min(1.5, Math.max(0.95, 1.4 * Math.sqrt(680 / oal)));
}

// Build the viewmodel for one weapon id.
//
// Returns the group, the muzzle (where the flash and the tracer start) and the
// sight (what ADS puts on the centre of the screen), plus the scale the
// renderer should apply.
// `hands` draws the gloves that belong to a first-person view. Hung on another
// player's avatar the gun already has arms attached to it, and a second pair
// of hands inside the first is exactly the sort of thing you notice.
export function buildWeaponModel(id, { hands = true } = {}) {
  const def = BUILDS[id] ?? BUILDS['smg-9-roller'];
  const group = partsToGroup(def.parts, def.grip);
  const z = (x) => (x - def.grip) * MM;
  const scale = viewScale(def.oal);

  if (hands) addHands(group, def, z);
  addOptic(group, def, z, scale);
  addSling(group, def, z);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, z(-20));
  group.add(muzzle);

  const sight = new THREE.Object3D();
  sight.position.set(0, def.sight[1] * MM, z(def.sight[0]));
  group.add(sight);

  return { group, muzzle, sight, scale };
}

// ── Hands ──────────────────────────────────────────────────────────────────
//
// A weapon on its own hangs in mid-air. What fixes that is not a bigger gun,
// it is the pair of arms holding it: a fist wrapped round the grip with a
// forearm running back and down out of frame, and a support hand over the
// forend with its own arm going the other way. Both are children of the
// weapon, so they follow every kick, sway and reload it makes.
// How far in front of the grip the support hand may sit. A man's arm is only
// so long: an AMR's forend is a metre and a half out, and a hand drawn there
// would belong to nobody.
const REACH = 0.44;

function addHands(group, def, z) {
  const firingZ = z(def.grip + 26);
  const supportZ = Math.max(z(def.support), -REACH);

  // Firing hand: fist on the grip, thumb over the top, wrist and forearm
  // trailing back toward the shooter's shoulder.
  const fist = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.082, 0.062), MATS.glove);
  fist.position.set(0.004, -0.078, firingZ);
  fist.rotation.x = 0.28;
  group.add(fist);

  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.028, 0.05), MATS.glove);
  thumb.position.set(-0.022, -0.044, firingZ - 0.008);
  thumb.rotation.x = 0.5;
  group.add(thumb);

  // The forearm runs from the wrist down and back, and it has to leave the
  // frame rather than end inside it: an arm that stops in mid-air reads worse
  // than no arm at all. Both lengths below are set by where the bottom of the
  // screen is, not by anatomy.
  limbAlong(group, MATS.sleeve, { x: 0.02, y: -0.09, z: firingZ + 0.02 },
    { x: 0.20, y: -0.58, z: 0.79 }, 0.34, 0.027);

  // Support hand: fingers curled over the forend, forearm dropping away on
  // the other side so the two arms make a triangle rather than a pair of
  // blocks stuck to the gun.
  const grasp = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.062, 0.088), MATS.glove);
  grasp.position.set(0.002, -0.034, supportZ);
  group.add(grasp);

  const fingers = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.026, 0.075), MATS.glove);
  fingers.position.set(0.006, -0.062, supportZ + 0.004);
  fingers.rotation.z = -0.12;
  group.add(fingers);

  // The other arm comes across from the far side, which is what makes the two
  // read as a man holding a weapon rather than as two posts under it. It has
  // further to travel, because the hand it starts from is further out.
  limbAlong(group, MATS.sleeve, { x: 0.0, y: -0.05, z: supportZ + 0.02 },
    { x: -0.22, y: -0.44, z: 0.87 }, 0.58, 0.025);
}

// A capsule laid along a direction, starting at `from`. Easier to reason about
// than three Euler angles, and the arms are the one place that matters.
const UP = new THREE.Vector3(0, 1, 0);
function limbAlong(group, mat, from, dir, len, radius) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, len, 4, 10), mat);
  const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
  mesh.quaternion.setFromUnitVectors(UP, d);
  mesh.position.set(
    from.x + d.x * len * 0.5,
    from.y + d.y * len * 0.5,
    from.z + d.z * len * 0.5,
  );
  group.add(mesh);
  return mesh;
}

// A two-point sling, hanging where a sling hangs: off the handguard, under
// the weapon, and back onto the stock. It is the piece that says the thing in
// your hands is carried rather than spawned, and it is one tube.
function addSling(group, def, z) {
  if (def.sling === false) return;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.006, -0.030, z(def.support - 10)),
    new THREE.Vector3(0.016, -0.150, z((def.support + def.oal) / 2)),
    new THREE.Vector3(0.008, -0.022, z(def.oal - 90)),
  ]);
  const strap = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 14, 0.0055, 5, false),
    MATS.webbing,
  );
  group.add(strap);
}

// ── Optics ─────────────────────────────────────────────────────────────────
//
// Every sight on the roster is a tube you look through, and until now there
// was nothing inside it. Now there is a mark.
//
// A reticle is projected light, not a painted part: a dot sized in real
// millimetres would be a fraction of a pixel across, so these are sized to
// what they must be on screen and divided back out of the weapon's viewmodel
// scale, which is why an AMR's mark is the same size as an SMG's.
const DOT_RADIUS = 0.0052;   // on-screen size of a collimator dot
const LINE = 0.0011;         // thickness of an etched crosshair line

function addOptic(group, def, z, scale) {
  const tube = def.parts.find((p) => p[0] === 'sight');
  if (!tube) return;
  const inner = tube[3] * MM * 0.92;
  const y = def.sight[1] * MM;
  const at = z(def.sight[0]);
  const s = 1 / scale;

  // Glass across the front of the tube, in front of the mark.
  const lens = new THREE.Mesh(new THREE.CircleGeometry(inner, 20), MATS.lens);
  lens.position.set(0, y, z(tube[1] + 10));
  group.add(lens);

  if (def.optic === 'scope') {
    // Marksman glass: an etched cross with a gap in the middle, a couple of
    // holdover marks under it, and the centre dot lit up.
    const bar = (w, h, x, dy) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.0006), MATS.etch);
      m.position.set(x, y + dy, at);
      group.add(m);
    };
    const reach = inner * 0.95;
    const gap = inner * 0.16;
    bar(reach - gap, LINE * s, -(gap + (reach - gap) / 2), 0);
    bar(reach - gap, LINE * s, gap + (reach - gap) / 2, 0);
    bar(LINE * s, reach - gap, 0, gap + (reach - gap) / 2);
    bar(LINE * s, reach - gap, 0, -(gap + (reach - gap) / 2));
    for (const drop of [0.3, 0.55, 0.8]) {
      bar(inner * 0.2, LINE * s * 0.8, 0, -reach * drop);
    }
    const core = new THREE.Mesh(new THREE.CircleGeometry(DOT_RADIUS * s * 0.55, 10), MATS.dot);
    core.position.set(0, y, at + 0.0004);
    group.add(core);
    return;
  }

  // Everything else carries a collimator: one floating dot, nothing round it
  // to hide a body behind, which is the whole reason to fit one.
  const halo = new THREE.Mesh(new THREE.CircleGeometry(DOT_RADIUS * s * 2.1, 14), MATS.glow);
  halo.position.set(0, y, at);
  group.add(halo);

  const core = new THREE.Mesh(new THREE.CircleGeometry(DOT_RADIUS * s, 14), MATS.dot);
  core.position.set(0, y, at + 0.0004);
  group.add(core);
}
