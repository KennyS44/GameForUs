// Builds the Three.js scene from the same map data the simulation uses, so
// what you see is exactly what you collide with and shoot through.

import * as THREE from '../../vendor/three.module.js?v=45193364';
import { doorAngle, trapWireLocal, TRIPWIRE } from '../sim/world.js?v=45193364';
import { PLAYER } from '../sim/constants.js?v=45193364';
import { buildWeaponModel } from './weapons.js?v=45193364';

const DOOR_HEIGHT = 2.05;
const DOOR_THICKNESS = 0.06;

// CC0 textures from Poly Haven — see vendor/textures/LICENSE.txt.
// Only the surfaces you spend the most time staring at get maps; the rest stay
// flat colours so the page stays light.
const TEXTURES = {
  concrete: { map: 'concrete_diff.jpg', normal: 'concrete_nor.jpg', metresPerTile: 3.0 },
  floor: { map: 'floor_diff.jpg', normal: 'floor_nor.jpg', metresPerTile: 2.4 },
  drywall: { map: 'drywall_diff.jpg', normal: 'drywall_nor.jpg', metresPerTile: 3.4, normalScale: 0.45 },
  // Doors and furniture: walnut veneer, tiled at the size veneer actually
  // comes in, so a door reads as a door and not as a brown block.
  // `tint` multiplies the map. Walls and floors keep the photograph's own
  // colour; furniture does not — the flat is meant to be dark walnut and dark
  // cloth, and a scan of pale veneer would repaint the whole penthouse.
  wood: {
    map: 'wood_diff.jpg', normal: 'wood_nor.jpg',
    metresPerTile: 1.4, normalScale: 0.6, tint: 0x7d6144,
  },
  // Sofas and beds. The weave is small and tiles tight — at three metres it is
  // the difference between upholstery and a painted crate.
  fabric: {
    map: 'fabric_diff.jpg', normal: 'fabric_nor.jpg',
    metresPerTile: 0.55, normalScale: 1.0, tint: 0x878390,
  },
};

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();

function loadTexture(file, { srgb }) {
  if (!textureCache.has(file)) {
    const tex = textureLoader.load(new URL(`../../vendor/textures/${file}`, import.meta.url).href);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    textureCache.set(file, tex);
  }
  return textureCache.get(file);
}

function materialFor(def) {
  const params = {
    color: def.color,
    roughness: 0.92,
    metalness: 0.0,
  };

  const tex = TEXTURES[def.name];
  if (tex) {
    // The texture supplies the colour unless the surface says otherwise.
    params.color = tex.tint ?? 0xffffff;
    params.map = loadTexture(tex.map, { srgb: true });
    if (tex.normal) {
      params.normalMap = loadTexture(tex.normal, { srgb: false });
      // Plaster is nearly flat and cloth is not: how deep the grain reads
      // belongs to the surface, not to one number for the whole flat.
      const s = tex.normalScale ?? 0.8;
      params.normalScale = new THREE.Vector2(s, s);
    }
  }

  if (def.name === 'floor') {
    // Lacquered parquet: enough sheen to catch a torch beam down a corridor.
    params.roughness = 0.55;
  } else if (def.name === 'wood') {
    params.roughness = 0.62;
  } else if (def.name === 'metal') {
    params.roughness = 0.45;
    params.metalness = 0.75;
  } else if (def.name === 'glass') {
    // Visible enough that you know there is a pane there — it stops bullets
    // until it breaks — but clear enough to fight through.
    params.roughness = 0.08;
    params.metalness = 0.25;
    params.transparent = true;
    params.opacity = 0.45;
  } else if (def.name === 'fabric') {
    params.roughness = 1.0;
  } else if (def.name === 'concrete') {
    params.roughness = 0.98;
  }
  return new THREE.MeshStandardMaterial(params);
}

// BoxGeometry gives every face UVs from 0 to 1, so one texture would stretch
// across a 15 m wall and repeat identically on a 0.4 m shelf. Rescaling the UVs
// by each face's real size keeps the grain the same everywhere.
//
// Face order is +X, -X, +Y, -Y, +Z, -Z, four vertices each.
function applyBoxUv(geometry, sx, sy, sz, metresPerTile) {
  const uv = geometry.attributes.uv;
  const spans = [
    [sz, sy], [sz, sy], // ±X
    [sx, sz], [sx, sz], // ±Y
    [sx, sy], [sx, sy], // ±Z
  ];
  for (let face = 0; face < 6; face++) {
    const [du, dv] = spans[face];
    const su = du / metresPerTile;
    const sv = dv / metresPerTile;
    for (let i = 0; i < 4; i++) {
      const idx = face * 4 + i;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

// A lamp is a thing hanging in a room, not a glow in mid-air: every one is
// built where it is actually fixed. `mount` says how — hung from the ceiling
// on a flex, bracketed to a wall, or standing on its own post outdoors.
const METAL = { color: 0x2a2a2e, roughness: 0.85, metalness: 0.3 };

function makeFixture(l) {
  const fixture = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial(METAL);
  const { x, y, z } = l.pos;

  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 10, 8),
    new THREE.MeshBasicMaterial({ color: l.color }),
  );
  bulb.position.set(x, y, z);

  // The shade sits over the bulb and is open underneath, so the light falls
  // downward the way the point light does.
  const shade = (radius) => {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.3, radius, radius * 0.8, 14, 1, true),
      new THREE.MeshStandardMaterial({ ...METAL, side: THREE.DoubleSide }),
    );
    m.position.set(x, y + radius * 0.32, z);
    return m;
  };

  const mount = l.mount ?? 'ceiling';

  if (mount === 'wall') {
    // Bracketed to the wall it is drawn beside: a back plate, a short arm and
    // a half shade. `face` points away from the wall, into the room.
    const face = l.face ?? { x: 0, z: 1 };
    const yaw = Math.atan2(face.x, face.z);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.04), metal);
    plate.position.set(x - face.x * 0.22, y + 0.06, z - face.z * 0.22);
    plate.rotation.y = yaw;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.22), metal);
    arm.position.set(x - face.x * 0.11, y + 0.06, z - face.z * 0.11);
    arm.rotation.y = yaw;
    fixture.add(plate, arm, shade(0.15));
  } else if (mount === 'post') {
    // A lamp post: it stands on the floor it is placed on.
    const base = l.base ?? 0;
    const height = Math.max(0.2, y - base - 0.1);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, height, 10), metal);
    pole.position.set(x, base + height / 2, z);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.07, 12), metal);
    foot.position.set(x, base + 0.035, z);
    fixture.add(pole, foot, shade(0.19));
  } else {
    // Hung from the ceiling: a canopy on the slab and a flex down to the shade.
    const ceiling = l.ceiling ?? y + 0.35;
    const drop = Math.max(0.05, ceiling - y - 0.12);
    const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 10), metal);
    canopy.position.set(x, ceiling - 0.015, z);
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, drop, 6), metal);
    cord.position.set(x, ceiling - drop / 2, z);
    fixture.add(canopy, cord, shade(0.2));
  }

  return { bulb, fixture };
}

export function buildScene(world) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.Fog(0x05060a, 11, 42);

  // Barely-there ambient. Everything else comes from lamps and torches.
  scene.add(new THREE.HemisphereLight(0x30364a, 0x0a0a0c, 0.25));

  const matCache = new Map();
  const getMat = (def) => {
    if (!matCache.has(def.name)) matCache.set(def.name, materialFor(def));
    return matCache.get(def.name);
  };

  // ── Static geometry ──
  const staticGroup = new THREE.Group();
  for (const b of world.boxes) {
    const sx = b.max.x - b.min.x;
    const sy = b.max.y - b.min.y;
    const sz = b.max.z - b.min.z;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const tiling = TEXTURES[b.material.name]?.metresPerTile;
    if (tiling) applyBoxUv(geo, sx, sy, sz, tiling);
    const mesh = new THREE.Mesh(geo, getMat(b.material));
    mesh.position.set(b.min.x + sx / 2, b.min.y + sy / 2, b.min.z + sz / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    staticGroup.add(mesh);
  }
  scene.add(staticGroup);

  // ── Doors ──
  const doorMeshes = new Map();
  for (const door of world.doors) {
    // Pivot sits on the hinge; the panel extends along +x in pivot space.
    const pivot = new THREE.Group();
    pivot.position.set(door.hinge.x, door.floorY ?? 0, door.hinge.z);

    const geo = new THREE.BoxGeometry(door.width, DOOR_HEIGHT, DOOR_THICKNESS);
    const mesh = new THREE.Mesh(geo, getMat(door.material));
    mesh.position.set(door.width / 2, DOOR_HEIGHT / 2, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pivot.add(mesh);

    // Handle, so you can read which way it opens at a glance.
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xb8a078, roughness: 0.35, metalness: 0.8 }),
    );
    knob.position.set(door.width - 0.1, 1.02, DOOR_THICKNESS / 2 + 0.03);
    pivot.add(knob);

    scene.add(pivot);
    doorMeshes.set(door.id, { pivot, mesh, door });
  }

  // ── Room lights ──
  // Point lights without shadow maps: cheap, and the darkness does the work.
  // Three.js uses physical light units, where a room bulb is tens of candela —
  // the map stores a relative brightness and this scales it into that range.
  const BULB_CANDELA = 15;
  const lightObjects = new Map();
  const upperFloorY = world.map.upperFloorY ?? Infinity;
  for (const l of world.lights) {
    const group = new THREE.Group();
    const light = new THREE.PointLight(l.color, l.intensity * BULB_CANDELA, l.radius, 2);
    light.position.set(l.pos.x, l.pos.y, l.pos.z);
    group.add(light);

    const { bulb, fixture } = makeFixture(l);
    group.add(bulb);
    group.add(fixture);

    scene.add(group);
    lightObjects.set(l.id, {
      light,
      bulb,
      shade: fixture,
      def: l,
      // Full brightness, remembered so it can be dimmed and restored.
      power: light.intensity,
      // A shaft lamp lights both floors because its shaft joins them.
      storey: l.storey ?? (l.pos.y < upperFloorY ? 'ground' : 'upper'),
    });
  }

  return { scene, doorMeshes, lightObjects, staticGroup };
}

// ── Per-frame sync ────────────────────────────────────────────────────────

export function syncDoors(view, state) {
  for (const [id, entry] of view.doorMeshes) {
    const ds = state.doors[id];
    if (!ds) continue;
    // A shattered pane is gone from the simulation, so it goes from the screen.
    entry.pivot.visible = !ds.broken;
    if (ds.broken) continue;
    // Our sim rotates (x,z) by +theta; Three.js rotation.y is the opposite sense.
    // A kicked door swings on its hinges like any other — the only thing it
    // loses is the latch, so there is nothing extra to draw.
    entry.pivot.rotation.y = -doorAngle(entry.door, ds.open);
  }
}

// `viewerY` is the floor the player is standing on.
//
// Nothing in this scene casts a shadow — a couple of dozen shadow-casting
// point lights would cost more than everything else in the frame put together
// — so a lamp downstairs shines straight up through the slab and keeps a room
// lit whose own bulb you have just shot out. A lamp therefore only lights the
// storey it belongs to. Climbing the stairs crosses the two over rather than
// snapping, because the stairwell really is open to both.
export function syncLights(view, state, viewerY = 0) {
  const upper = Math.max(0, Math.min(1, (viewerY - 0.8) / 1.7));
  for (const [id, entry] of view.lightObjects) {
    const broken = state.lights[id]?.broken;
    const share = entry.storey === 'both' ? 1 : entry.storey === 'upper' ? upper : 1 - upper;
    // Dimmed rather than hidden: switching a light off changes how many the
    // shader is compiled for, and rebuilding shaders mid-round stutters.
    entry.light.intensity = broken ? 0 : entry.power * share;
    entry.bulb.visible = !broken;
    if (broken) entry.bulb.material.color.setHex(0x1a1a1a);
  }
}

// ── Equipment in the world ────────────────────────────────────────────────
//
// Three kinds of object, one pass: grenades in the air, clouds on the floor,
// and whatever is bolted to a door. All of them are pooled — a round can throw
// a dozen and a frame must not allocate.

const DEVICE_COLOR = {
  charge: 0xc8531f,
  wedge: 0xb08a4a,
  trap: 0xc23b3b,
  alarm: 0x4a7fc2,
};

export function createEquipmentView(scene) {
  // The door pivots belong to the scene view and are handed in once it exists,
  // so a device can ride the panel it is fitted to.
  let doorMeshes = null;
  const viewOf = (id) => doorMeshes?.get(id);

  const thrown = [];
  const clouds = [];
  const devices = new Map(); // doorId -> mesh

  const grenadeGeo = new THREE.SphereGeometry(0.055, 10, 8);
  const flashMat = new THREE.MeshStandardMaterial({
    color: 0x9aa2ae, roughness: 0.5, metalness: 0.6, emissive: 0x1a1d22,
  });
  const smokeCanMat = new THREE.MeshStandardMaterial({
    color: 0x2f5136, roughness: 0.8, metalness: 0.2, emissive: 0x0d1410,
  });
  // One sphere, drawn big and soft. Depth-write off so two clouds overlapping
  // do not cut a hard edge into each other.
  const cloudGeo = new THREE.SphereGeometry(1, 16, 12);
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xb9bcc2, roughness: 1, metalness: 0,
    transparent: true, opacity: 0.92, depthWrite: false, emissive: 0x14161b,
  });
  const deviceGeo = new THREE.BoxGeometry(0.14, 0.1, 0.06);
  // The wire. Unlit on purpose: a thread you can only find with the torch on
  // is a thread nobody ever shoots, and this one is meant to be spotted from
  // across the room and cut. Built one metre long and scaled to the doorway.
  const wireGeo = new THREE.BoxGeometry(1, TRIPWIRE.halfThickness, TRIPWIRE.halfThickness);
  const wireMat = new THREE.MeshBasicMaterial({ color: 0xff6a4a });

  // Everything bolted to a door, keyed by which door and which slot — the
  // defenders' fitting and the attackers' charge can be on the same panel.
  function deviceMesh(key, fitted, door, entry) {
    const kind = fitted.kind;
    let mesh = devices.get(key);
    if (mesh) {
      mesh.material.color.setHex(DEVICE_COLOR[kind] ?? 0xaaaaaa);
      return;
    }
    mesh = new THREE.Mesh(deviceGeo, new THREE.MeshStandardMaterial({
      color: DEVICE_COLOR[kind] ?? 0xaaaaaa,
      roughness: 0.6, metalness: 0.3, emissive: 0x0a0c10,
    }));
    // Hung on the face of the panel: a wedge at the foot, everything else at
    // handle height, which is where you would actually fit it. A charge goes
    // on the far side of the handle so a wedge underneath it stays visible,
    // and the grenade behind a tripwire sits on the same face as its thread.
    mesh.position.set(
      door.width * (kind === 'charge' ? 0.55 : 0.28),
      kind === 'wedge' ? 0.08 : 1.05,
      kind === 'charge' ? -0.07 : 0.07 * (fitted.side ?? 1),
    );
    entry?.pivot.add(mesh);
    devices.set(key, mesh);
  }

  function dropMesh(key) {
    const mesh = devices.get(key);
    if (!mesh) return;
    mesh.parent?.remove(mesh);
    mesh.material.dispose();
    devices.delete(key);
  }

  function sync(state, world) {
    // Grenades in flight.
    const flying = state.throwables ?? [];
    while (thrown.length < flying.length) {
      const mesh = new THREE.Mesh(grenadeGeo, flashMat);
      scene.add(mesh);
      thrown.push(mesh);
    }
    for (let i = 0; i < thrown.length; i++) {
      const t = flying[i];
      thrown[i].visible = !!t;
      if (!t) continue;
      thrown[i].material = t.kind === 'smoke' ? smokeCanMat : flashMat;
      thrown[i].position.set(t.pos.x, t.pos.y, t.pos.z);
    }

    // Clouds.
    const smokes = state.smokes ?? [];
    while (clouds.length < smokes.length) {
      const mesh = new THREE.Mesh(cloudGeo, cloudMat.clone());
      scene.add(mesh);
      clouds.push(mesh);
    }
    for (let i = 0; i < clouds.length; i++) {
      const c = smokes[i];
      clouds[i].visible = !!c;
      if (!c) continue;
      clouds[i].position.set(c.pos.x, c.pos.y + 0.5, c.pos.z);
      clouds[i].scale.setScalar(Math.max(0.05, c.radius * c.grown));
      clouds[i].material.opacity = 0.92 * Math.min(1, c.grown * 1.6);
    }

    // Devices ride the door panel, so they swing with it.
    for (const door of world.doors) {
      const ds = state.doors[door.id];
      const entry = viewOf(door.id);
      for (const slot of ['device', 'charge']) {
        const fitted = ds?.[slot];
        const key = `${door.id}|${slot}`;
        if (fitted) deviceMesh(key, fitted, door, entry);
        else dropMesh(key);
      }

      // The wire itself, strung across the doorway on the side it was fitted
      // from — the same box the simulation lets you shoot at.
      const wired = ds?.device?.kind === 'trap' ? ds.device : null;
      const key = `${door.id}|wire`;
      if (wired) {
        let mesh = devices.get(key);
        if (!mesh) {
          mesh = new THREE.Mesh(wireGeo, wireMat);
          entry?.pivot.add(mesh);
          devices.set(key, mesh);
        }
        const w = trapWireLocal(door, wired.side ?? 1);
        mesh.position.set(w.x, w.y, w.z);
        mesh.scale.x = w.span;
      } else if (devices.has(key)) {
        // Shared material: unhook it, do not dispose it out from under the
        // next wire.
        const mesh = devices.get(key);
        mesh.parent?.remove(mesh);
        devices.delete(key);
      }
    }
  }

  return {
    attachDoors(meshes) { doorMeshes = meshes; },
    sync,
  };
}

// ── Player avatars ────────────────────────────────────────────────────────
//
// A man, built to the same measurements the simulation shoots at. The three
// hitboxes in sim.js are fractions of a player's height — head in the top
// 26 cm, chest from 45% to that, legs below — so the rig below is laid out on
// exactly those figures. What you aim at is what is there: a head that reads
// as a head is a head you can hit, and the difference between hitting a
// shoulder and hitting a helmet is the whole of this game.
//
// Two dozen boxes and cylinders, no skinning, no imported mesh: the silhouette
// does the work. Gear tells the sides apart at a glance in a dark room —
// attackers come in with helmets and plate carriers, defenders hold the flat
// in soft caps and chest rigs.

const KIT = {
  attackers: {
    cloth: 0x2b3442, webbing: 0x1d2530, hard: 0x21262e, skin: 0x6b5344,
  },
  defenders: {
    cloth: 0x3d3327, webbing: 0x2a2118, hard: 0x2a2620, skin: 0x6b5344,
  },
};

// Materials are shared per side: five bodies on screen is five draw calls'
// worth of material, not thirty.
// How far the head sits above the chest pivot. Named because the lean maths
// needs the same figure the rig is built with.
const HEAD_HEIGHT = 0.70;

const kitMaterials = new Map();
function kitMats(team) {
  if (!kitMaterials.has(team)) {
    const c = KIT[team] ?? KIT.attackers;
    kitMaterials.set(team, {
      cloth: new THREE.MeshStandardMaterial({ color: c.cloth, roughness: 0.95 }),
      webbing: new THREE.MeshStandardMaterial({ color: c.webbing, roughness: 1.0 }),
      hard: new THREE.MeshStandardMaterial({ color: c.hard, roughness: 0.55, metalness: 0.35 }),
      skin: new THREE.MeshStandardMaterial({ color: c.skin, roughness: 0.9 }),
      visor: new THREE.MeshStandardMaterial({
        color: 0x11161c, roughness: 0.25, metalness: 0.6, emissive: 0x080c12,
      }),
    });
  }
  return kitMaterials.get(team);
}

// A box, given its centre and size. Everything below is measured in metres off
// the floor, for a man of PLAYER.heightStand; the whole rig is scaled by the
// player's actual height, which is what keeps it inside the hitboxes.
function box(parent, mat, w, h, d, x, y, z, rx = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.x = rx;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function limb(parent, mat, radius, length, x, y, z, rx) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 3, 8), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.x = rx;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

export function makeAvatar(team) {
  const m = kitMats(team);
  const group = new THREE.Group();

  // ── Legs: floor to 45% of height ──
  const legsRig = new THREE.Group();
  group.add(legsRig);
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(side * 0.105, 0.78, 0);
    legsRig.add(leg);
    limb(leg, m.cloth, 0.075, 0.24, 0, -0.16, 0, 0);        // thigh
    box(leg, m.webbing, 0.135, 0.10, 0.14, 0, -0.30, 0.02);  // knee pad
    limb(leg, m.cloth, 0.06, 0.24, 0, -0.46, 0.01, 0);      // shin
    box(leg, m.webbing, 0.115, 0.09, 0.27, 0, -0.72, -0.03); // boot
  }
  // The hips belong to the legs, not to the chest: a man leaning out of a
  // doorway swings his shoulders over them and leaves his belt where it was.
  box(legsRig, m.cloth, 0.30, 0.16, 0.21, 0, 0.80, 0);
  box(legsRig, m.webbing, 0.32, 0.06, 0.23, 0, 0.87, 0);     // belt

  // ── Chest: 45% to the base of the head ──
  const chest = new THREE.Group();
  chest.position.y = 0.79;
  group.add(chest);

  // Waist first, tapered in, so the join over the belt reads as a body
  // bending rather than a block sliding sideways.
  box(chest, m.cloth, 0.26, 0.16, 0.17, 0, 0.06, 0);        // waist
  box(chest, m.cloth, 0.34, 0.24, 0.20, 0, 0.20, 0);        // belly
  box(chest, m.cloth, 0.40, 0.30, 0.22, 0, 0.44, 0);        // ribs
  // The carrier: the thing that makes a torso hit worth less than a head hit.
  box(chest, m.webbing, 0.42, 0.36, 0.26, 0, 0.42, 0);
  box(chest, m.hard, 0.24, 0.20, 0.03, 0, 0.44, 0.135);     // front plate
  box(chest, m.webbing, 0.11, 0.10, 0.07, -0.13, 0.30, 0.13); // pouches
  box(chest, m.webbing, 0.11, 0.10, 0.07, 0.13, 0.30, 0.13);
  box(chest, m.webbing, 0.26, 0.22, 0.11, 0, 0.44, -0.16);  // pack on the back
  box(chest, m.cloth, 0.44, 0.10, 0.22, 0, 0.58, 0);        // shoulders
  box(chest, m.skin, 0.11, 0.07, 0.11, 0, 0.65, 0);         // neck

  // ── Head: the top 26 cm, and it turns on its own ──
  const head = new THREE.Group();
  head.position.y = HEAD_HEIGHT;
  chest.add(head);
  box(head, m.skin, 0.155, 0.20, 0.19, 0, 0.09, 0);
  if (team === 'defenders') {
    box(head, m.webbing, 0.185, 0.075, 0.20, 0, 0.185, 0);       // soft cap
    box(head, m.webbing, 0.17, 0.03, 0.09, 0, 0.165, 0.135);     // peak
    box(head, m.cloth, 0.16, 0.10, 0.02, 0, 0.10, 0.10);         // face wrap
  } else {
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 8), m.hard);
    helmet.scale.set(1, 0.92, 1.05);
    helmet.position.set(0, 0.135, -0.005);
    helmet.castShadow = true;
    head.add(helmet);
    box(head, m.hard, 0.085, 0.05, 0.06, 0, 0.20, 0.075);        // mount
    box(head, m.visor, 0.17, 0.055, 0.02, 0, 0.115, 0.098);      // goggles
  }

  // ── Arms and whatever they are holding ──
  //
  // One rig: both arms and the weapon move together, so a man aiming up
  // raises his gun with his eyes instead of pointing it at the floor.
  const arms = new THREE.Group();
  arms.position.set(0, 0.55, 0);
  chest.add(arms);

  limb(arms, m.cloth, 0.058, 0.16, -0.185, -0.09, -0.02, 0.55);  // support upper
  limb(arms, m.cloth, 0.055, 0.17, -0.14, -0.19, -0.20, 1.15);   // support fore
  limb(arms, m.cloth, 0.058, 0.16, 0.185, -0.10, -0.03, 0.75);   // firing upper
  limb(arms, m.cloth, 0.055, 0.15, 0.11, -0.20, -0.16, 1.05);    // firing fore

  const hold = new THREE.Group();          // the grip hand, where a gun goes
  hold.position.set(0.055, -0.235, -0.24);
  arms.add(hold);
  // Gloves: the viewmodel's own pair is switched off for an avatar, because
  // these are the hands that belong to these arms.
  box(hold, m.webbing, 0.055, 0.085, 0.07, 0, 0.01, 0.02);
  box(hold, m.webbing, 0.06, 0.07, 0.09, -0.055, 0.055, -0.20);

  group.userData = { team, chest, head, arms, hold, legsRig, weaponId: null, weapon: null };
  return group;
}

// The gun in their hands is the gun they picked: same model as the viewmodel,
// at true size rather than the compressed scale a first-person weapon uses.
export function setAvatarWeapon(av, weaponId) {
  const u = av.userData;
  if (!weaponId || u.weaponId === weaponId) return;
  if (u.weapon) {
    u.hold.remove(u.weapon.group);
    u.weapon.group.traverse((o) => o.geometry?.dispose());
  }
  const built = buildWeaponModel(weaponId, { hands: false });
  built.group.position.set(0, 0.03, -0.02);
  built.group.traverse((o) => { o.castShadow = true; });
  u.hold.add(built.group);
  u.weapon = built;
  u.weaponId = weaponId;
}

// Pose one avatar from one player's state.
//
// Height, lean and where they are looking all come straight out of the
// simulation, in the same proportions it uses to decide what a bullet hit.
export function poseAvatar(av, p) {
  const u = av.userData;
  const height = PLAYER.heightCrouch + (PLAYER.heightStand - PLAYER.heightCrouch) * p.stance;
  av.position.set(p.pos.x, p.pos.y, p.pos.z);
  av.rotation.y = p.look.yaw;
  // Every hitbox is a fraction of the player's height, so scaling the whole
  // man is what keeps the drawing and the shooting in agreement.
  av.scale.setScalar(height / PLAYER.heightStand);

  // Leaning moves the head out over the shoulder and takes the chest part of
  // the way with it — exactly the offsets sim.js applies to the hitboxes. The
  // feet stay planted, which is why a lean is a peek and not a step.
  const lean = p.lean ?? 0;
  const out = lean * PLAYER.leanMax;
  // A body tilts as well as slides, and a tilt carries the head sideways on
  // its own — so whatever the tilt gives, the neck takes back. The head lands
  // exactly where the simulation put its hitbox, and the man still leans.
  const roll = lean * PLAYER.leanAngle * 0.3;
  u.chest.position.x = out * 0.6;
  u.chest.rotation.z = -roll;
  u.head.position.x = out * 0.4 - HEAD_HEIGHT * Math.sin(roll);
  u.head.rotation.z = -roll * 0.5;

  const pitch = clampPitch(p.look.pitch ?? 0);
  u.head.rotation.x = pitch * 0.7;
  u.arms.rotation.x = pitch;

  // Crouching folds the knees forward rather than sinking the man into the
  // floor: same envelope, better shape.
  u.legsRig.rotation.x = (1 - p.stance) * 0.12;
}

function clampPitch(pitch) {
  return Math.max(-1.1, Math.min(1.1, pitch));
}
