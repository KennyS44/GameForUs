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

import * as THREE from '../../vendor/three.module.js?v=b0d71194';

const MM = 0.001;

// A touch of emissive keeps the silhouette readable when every light is out.
const MATS = {
  steel: new THREE.MeshStandardMaterial({
    color: 0x24262c, roughness: 0.5, metalness: 0.6, emissive: 0x0c0e13,
  }),
  polymer: new THREE.MeshStandardMaterial({
    color: 0x111216, roughness: 0.95, metalness: 0.05, emissive: 0x080a0e,
  }),
  rubber: new THREE.MeshStandardMaterial({
    color: 0x0c0d10, roughness: 1.0, metalness: 0.0, emissive: 0x060709,
  }),
  glass: new THREE.MeshStandardMaterial({
    color: 0x2a3a44, roughness: 0.2, metalness: 0.3, emissive: 0x0a1016,
  }),
  glove: new THREE.MeshStandardMaterial({
    color: 0x2b2e35, roughness: 1.0, emissive: 0x0d0f14,
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
        new THREE.BoxGeometry(width * MM, height, len),
        MATS[mat],
      );
      mesh.position.set(0, ((yLow + yHigh) / 2) * MM, z((x0 + x1) / 2));
      mesh.rotation.x = tilt;
      group.add(mesh);
    } else if (kind === 'rod') {
      const [, x0, x1, radius, mat, y = 0] = part;
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * MM, radius * MM, Math.abs(x1 - x0) * MM, 10),
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
    oal: 680, grip: 400, support: 150, sight: [346, 50],
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
      ['slab', 286, 310, 38, 44, 26, 'steel'],
      ['slab', 382, 406, 38, 44, 26, 'steel'],
      ['sight', 286, 406, 19, 50],
      ['ring', 288, 19, 3, 'steel', 50],
      ['ring', 404, 19, 3, 'steel', 50],
    ],
  },

  // Bullpup PDW: one polymer shell, the magazine lying flat along its back.
  'smg-57-pdw': {
    oal: 500, grip: 316, support: 196, sight: [264, 88],
    parts: [
      ['rod', 0, 44, 11, 'steel'],
      ['rod', 38, 150, 8, 'steel'],
      ['slab', 34, 500, -54, 26, 55, 'polymer'],
      ['slab', 166, 222, -134, -52, 42, 'polymer'],
      ['slab', 286, 356, -152, -54, 48, 'polymer'],
      ['slab', 430, 500, -104, 14, 55, 'polymer'],
      ['slab', 134, 394, 26, 62, 40, 'polymer'],
      ['slab', 140, 392, 62, 72, 22, 'steel'],
      ['slab', 206, 230, 70, 82, 26, 'steel'],
      ['slab', 300, 324, 70, 82, 26, 'steel'],
      ['sight', 206, 324, 19, 88],
      ['ring', 208, 19, 3, 'steel', 88],
      ['ring', 322, 19, 3, 'steel', 88],
      ['slab', 468, 500, -104, 14, 58, 'rubber'],
    ],
  },

  // .45 with the magazine in the grip: tall receiver, side-folding stock.
  'smg-45-inline': {
    oal: 640, grip: 340, support: 120, sight: [280, 64],
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
      ['slab', 220, 244, 52, 58, 26, 'steel'],
      ['slab', 318, 342, 52, 58, 26, 'steel'],
      ['sight', 220, 342, 19, 64],
      ['ring', 222, 19, 3, 'steel', 64],
      ['ring', 340, 19, 3, 'steel', 64],
    ],
  },

  // 5.45 long-stroke piston: the gas tube above the barrel is the profile.
  'ar-545-piston': {
    oal: 940, grip: 500, support: 178, sight: [462, 54],
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
      ['slab', 400, 424, 42, 48, 26, 'steel'],
      ['slab', 500, 524, 42, 48, 26, 'steel'],
      ['sight', 400, 524, 19, 54],
      ['ring', 402, 19, 3, 'steel', 54],
      ['ring', 522, 19, 3, 'steel', 54],
    ],
  },

  // 5.56 short-stroke piston: continuous rail, telescoping stock.
  'ar-556-piston': {
    oal: 800, grip: 554, support: 212, sight: [484, 52],
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
      ['slab', 422, 446, 40, 46, 26, 'steel'],
      ['slab', 522, 546, 40, 46, 26, 'steel'],
      ['sight', 422, 546, 19, 52],
      ['ring', 424, 19, 3, 'steel', 52],
      ['ring', 544, 19, 3, 'steel', 52],
    ],
  },

  // 5.56 with a monolithic rail and a folding stock: longer, flatter on top.
  'ar-556-folder': {
    oal: 890, grip: 572, support: 206, sight: [480, 54],
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
      ['slab', 416, 440, 42, 48, 26, 'steel'],
      ['slab', 520, 544, 42, 48, 26, 'steel'],
      ['sight', 416, 544, 19, 54],
      ['ring', 418, 19, 3, 'steel', 54],
      ['ring', 542, 19, 3, 'steel', 54],
    ],
  },

  // Sawn-off double: two barrels, a break-action frame and nothing else.
  'sg-12-double': {
    oal: 420, grip: 370, support: 176, sight: [360, 46],
    parts: [
      ['slab', 0, 300, 3, 26, 46, 'steel'],
      ['slab', 0, 300, -26, -3, 46, 'steel'],
      ['slab', 0, 12, -28, 28, 48, 'rubber'],
      ['slab', 120, 232, -54, -26, 52, 'polymer'],
      ['slab', 298, 420, -36, 33, 44, 'steel'],
      ['slab', 304, 414, 36, 42, 22, 'steel'],
      ['slab', 322, 342, 42, 46, 24, 'steel'],
      ['slab', 380, 400, 42, 46, 24, 'steel'],
      ['sight', 322, 400, 16, 46],
      ['ring', 324, 16, 3, 'steel', 46],
      ['ring', 398, 16, 3, 'steel', 46],
      ['slab', 334, 430, -178, -36, 42, 'polymer', 0.30],
    ],
  },

  // Pump gun: the magazine tube under the barrel and a forend that rides it.
  'sg-12-pump': {
    oal: 1000, grip: 636, support: 226, sight: [570, 44],
    parts: [
      ['slab', 0, 52, -22, 22, 40, 'steel'],
      ['rod', 46, 470, 11, 'steel'],
      ['slab', 60, 430, -40, -18, 22, 'steel'],
      ['slab', 150, 304, -52, -12, 58, 'polymer'],
      ['slab', 470, 684, -28, 30, 44, 'steel'],
      ['slab', 478, 676, 30, 40, 22, 'steel'],
      ['slab', 508, 532, 38, 44, 26, 'steel'],
      ['slab', 608, 632, 38, 44, 26, 'steel'],
      ['sight', 508, 632, 18, 44],
      ['ring', 510, 18, 3, 'steel', 44],
      ['ring', 630, 18, 3, 'steel', 44],
      ['slab', 468, 500, -66, -30, 36, 'steel'],
      ['slab', 598, 700, -172, -28, 42, 'polymer', 0.30],
      ['slab', 684, 968, -14, 18, 30, 'steel'],
      ['slab', 712, 968, 18, 54, 44, 'polymer'],
      ['slab', 968, 1000, -44, 54, 46, 'rubber'],
    ],
  },

  // Magazine-fed semi-auto 12 gauge: a rifle's layout, everything thicker.
  'sg-12-mag': {
    oal: 940, grip: 522, support: 180, sight: [444, 58],
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
      ['slab', 382, 406, 46, 52, 26, 'steel'],
      ['slab', 482, 506, 46, 52, 26, 'steel'],
      ['sight', 382, 506, 19, 58],
      ['ring', 384, 19, 3, 'steel', 58],
      ['ring', 504, 19, 3, 'steel', 58],
    ],
  },

  // .50 anti-materiel: barrel shroud, bipod, and a scope you look through.
  'amr-50': {
    oal: 1448, grip: 1000, support: 320, sight: [750, 130],
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
    oal: 1120, grip: 662, support: 210, sight: [606, 100],
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
export function buildWeaponModel(id) {
  const def = BUILDS[id] ?? BUILDS['smg-9-roller'];
  const group = partsToGroup(def.parts, def.grip);
  const z = (x) => (x - def.grip) * MM;

  // Gloved hands: one wrapped round the grip, one under the forend. Kept small
  // and a shade lighter than the polymer so they read as hands rather than as
  // more gun.
  const firing = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.07, 0.058), MATS.glove);
  firing.position.set(0.002, -0.072, z(def.grip + 30));
  firing.rotation.x = 0.3;
  group.add(firing);

  const support = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.058, 0.08), MATS.glove);
  support.position.set(0.002, -0.03, z(def.support));
  group.add(support);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, z(-20));
  group.add(muzzle);

  const sight = new THREE.Object3D();
  sight.position.set(0, def.sight[1] * MM, z(def.sight[0]));
  group.add(sight);

  return { group, muzzle, sight, scale: viewScale(def.oal) };
}
