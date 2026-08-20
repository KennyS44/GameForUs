// Builds the Three.js scene from the same map data the simulation uses, so
// what you see is exactly what you collide with and shoot through.

import * as THREE from '../../vendor/three.module.js?v=d547eb56';
import { doorAngle } from '../sim/world.js?v=d547eb56';

const DOOR_HEIGHT = 2.05;
const DOOR_THICKNESS = 0.06;

// CC0 textures from Poly Haven — see vendor/textures/LICENSE.txt.
// Only the surfaces you spend the most time staring at get maps; the rest stay
// flat colours so the page stays light.
const TEXTURES = {
  concrete: { map: 'concrete_diff.jpg', normal: 'concrete_nor.jpg', metresPerTile: 3.0 },
  floor: { map: 'floor_diff.jpg', normal: 'floor_nor.jpg', metresPerTile: 2.4 },
  drywall: { map: 'drywall_diff.jpg', metresPerTile: 3.4 },
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
    // The texture supplies the colour, so the tint is pulled back to white —
    // otherwise the map gets multiplied down into mud.
    params.color = 0xffffff;
    params.map = loadTexture(tex.map, { srgb: true });
    if (tex.normal) {
      params.normalMap = loadTexture(tex.normal, { srgb: false });
      params.normalScale = new THREE.Vector2(0.8, 0.8);
    }
  }

  if (def.name === 'floor') {
    params.roughness = 0.85;
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

// ── Player avatars ────────────────────────────────────────────────────────

const TEAM_COLOR = {
  attackers: 0x2e3d52,
  defenders: 0x4a3328,
};

export function makeAvatar(team) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: TEAM_COLOR[team] ?? 0x333333,
    roughness: 0.85,
  });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.55, 4, 8), mat);
  torso.position.y = 1.15;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), mat);
  head.position.y = 1.63;
  head.castShadow = true;
  group.add(head);

  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.5, 4, 8), mat);
  legs.position.y = 0.45;
  legs.castShadow = true;
  group.add(legs);

  // The gun, so you can tell which way someone is actually facing.
  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.12, 0.42),
    new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.6, metalness: 0.4 }),
  );
  gun.position.set(0.16, 1.3, -0.3);
  group.add(gun);

  group.userData = { torso, head, legs, gun };
  return group;
}
