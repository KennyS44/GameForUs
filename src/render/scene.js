// Builds the Three.js scene from the same map data the simulation uses, so
// what you see is exactly what you collide with and shoot through.

import * as THREE from '../../vendor/three.module.js?v=41124dad';
import { doorAngle, trapWireLocal, TRIPWIRE } from '../sim/world.js?v=41124dad';
import { PLAYER, FLARE, NVG, POWER } from '../sim/constants.js?v=41124dad';
import { buildWeaponModel } from './weapons.js?v=41124dad';

// How much light there is in a room with every lamp in it switched off. Kept
// here rather than inline because three different places have to agree on it:
// the light that is built, the breaker that dims it and the tube that lifts it.
const AMBIENT = 0.25;

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
  // Large-format porcelain, laid at 1.2 m to the tile — the floor of a
  // bathroom you would find in a flat like this one.
  tile: { map: 'tile_diff.jpg', normal: 'tile_nor.jpg', metresPerTile: 1.2, normalScale: 0.7 },
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
  } else if (def.name === 'tile') {
    // Glazed: wetter-looking than parquet, and it throws the torch back.
    params.roughness = 0.32;
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

  // Barely-there ambient. Everything else comes from lamps and torches — and
  // this is also the one dial night vision turns: a tube does not add light to
  // a room, it makes the light already in it count for more, which is exactly
  // what raising the ambient does.
  const ambient = new THREE.HemisphereLight(0x30364a, 0x0a0a0c, AMBIENT);
  scene.add(ambient);

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

  // ── The consumer unit ──
  // The box itself is map geometry like any other, because it is something you
  // walk into. What is added here is what tells you it is a consumer unit and
  // not a dark rectangle: a grey door, a handle, and a pilot lamp that is
  // green while the flat has power and dead the moment it does not.
  const pilots = [];
  for (const sw of world.switches ?? []) {
    const yaw = Math.atan2(sw.face.x, sw.face.z);
    // Out from the wall, and sideways along the face of the cabinet.
    const at = (out, side, up) => ({
      x: sw.pos.x + sw.face.x * out + Math.cos(yaw) * side,
      y: sw.pos.y + up,
      z: sw.pos.z + sw.face.z * out - Math.sin(yaw) * side,
    });

    const door = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.66, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x6d737c, roughness: 0.5, metalness: 0.6 }),
    );
    const dp = at(0.09, 0, 0);
    door.position.set(dp.x, dp.y, dp.z);
    door.rotation.y = yaw;
    scene.add(door);

    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.16, 0.03),
      new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.8 }),
    );
    const hp = at(0.115, -0.2, 0);
    handle.position.set(hp.x, hp.y, hp.z);
    scene.add(handle);

    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.024, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x4fe08a, toneMapped: false }),
    );
    const lp = at(0.12, 0.18, 0.24);
    lamp.position.set(lp.x, lp.y, lp.z);
    scene.add(lamp);
    pilots.push(lamp);
  }

  return { scene, world, doorMeshes, lightObjects, staticGroup, ambient, pilots };
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
//
// `nvg` is whether the man behind the camera has the tube down. It does not
// change a single lamp — it changes how much the darkness between them counts.
export function syncLights(view, state, viewerY = 0, nvg = false) {
  const upper = Math.max(0, Math.min(1, (viewerY - 0.8) / 1.7));
  const mains = state.power !== false;
  for (const [id, entry] of view.lightObjects) {
    const broken = state.lights[id]?.broken;
    // One cabinet on the terrace feeds all of them. A lamp marked `mains:
    // false` would be daylight or moonlight and would stay — there are none
    // today, which is the point: cutting the power cuts everything.
    const fed = mains || entry.def.mains === false;
    const share = entry.storey === 'both' ? 1 : entry.storey === 'upper' ? upper : 1 - upper;
    // Dimmed rather than hidden: switching a light off changes how many the
    // shader is compiled for, and rebuilding shaders mid-round stutters.
    entry.light.intensity = broken || !fed ? 0 : entry.power * share;
    entry.bulb.visible = !broken;
    entry.bulb.material.color.setHex(broken ? 0x1a1a1a : fed ? entry.def.color : 0x14161a);
  }
  for (const lamp of view.pilots) lamp.material.color.setHex(mains ? 0x4fe08a : 0x2a1012);

  // With the mains gone there is still a city outside the glass and a sky over
  // the court. It is enough to tell a doorway from a wall at three metres and
  // nothing like enough to fight by — which is what makes the tube worth the
  // key it is on.
  const base = mains ? AMBIENT : AMBIENT * POWER.moonlight;
  view.ambient.intensity = nvg ? NVG.ambient : base;
  view.ambient.color.setHex(nvg ? 0x8ad6a0 : 0x30364a);
  view.ambient.groundColor.setHex(nvg ? 0x11291a : 0x0a0a0c);
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

// ── Smoke ─────────────────────────────────────────────────────────────────

const SMOKE_TINT = new THREE.Color(0x9aa0a9);
const PUFFS = 13;

// One soft disc, drawn once into a canvas: white in the middle, nothing at the
// rim. Everything about the shape of a cloud comes from stacking these.
let puffTex = null;
function puffTexture() {
  if (puffTex) return puffTex;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.42, 'rgba(255,255,255,0.78)');
  grad.addColorStop(0.78, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  puffTex = new THREE.CanvasTexture(canvas);
  puffTex.colorSpace = THREE.SRGBColorSpace;
  return puffTex;
}

// Where the puffs sit inside a cloud of radius 1. Worked out once from a fixed
// seed rather than at random: every cloud in every round is the same shape, so
// there is nothing here that one machine can draw differently from another.
const PUFF_LAYOUT = (() => {
  let s = 20260821;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  for (let i = 0; i < PUFFS; i++) {
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    // Cube root spreads them through the volume instead of onto the shell, so
    // the middle of a cloud is the thick part and the edge is where it frays.
    const r = 0.62 * Math.cbrt(rnd());
    const ring = Math.sqrt(1 - u * u);
    out.push({
      // Flatter than it is wide: smoke pools along a floor, it does not stack.
      x: r * ring * Math.cos(th), y: r * u * 0.66, z: r * ring * Math.sin(th),
      size: 1.0 + rnd() * 0.45,
      spin: rnd() * Math.PI * 2,
      rate: (rnd() - 0.5) * 0.42,
    });
  }
  return out;
})();

function makeCloud(scene, geo, mat) {
  const group = new THREE.Group();
  const material = mat.clone();
  const puffs = PUFF_LAYOUT.map((p) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(p.x, p.y, p.z);
    mesh.scale.setScalar(p.size);
    mesh.userData.spin = p.spin;
    mesh.userData.rate = p.rate;
    group.add(mesh);
    return mesh;
  });
  scene.add(group);
  return { group, puffs, material };
}

// How much light is falling on a point, on a scale where 1 is a well-lit room.
// Cheap enough to run per cloud per frame, and it is the only thing that makes
// smoke look like it belongs to the room it is standing in.
function litness(state, world, pos) {
  let sum = 0.09; // the sky over the court, and nothing else
  for (const l of world.lights) {
    if (state.lights?.[l.id]?.broken) continue;
    if (state.power === false && l.mains !== false) continue;
    const d = Math.hypot(pos.x - l.pos.x, pos.y - l.pos.y, pos.z - l.pos.z);
    if (d > l.radius) continue;
    sum += l.intensity * (1 - d / l.radius) * 0.42;
  }
  for (const t of state.throwables ?? []) {
    if (t.kind !== 'flare') continue;
    const d = Math.hypot(pos.x - t.pos.x, pos.y - t.pos.y, pos.z - t.pos.z);
    if (d < FLARE.radius) sum += 0.8 * (1 - d / FLARE.radius);
  }
  return Math.max(0.1, Math.min(1.15, sum));
}

// The inside of a cloud, which no amount of geometry can draw: from in there
// the smoke is not an object in front of you, it is the air itself. So the
// scene's own fog closes to arm's length and takes the room with it.
//
// The weapon is drawn in its own pass with its own camera, so your hands stay
// where they are — which is exactly right. In smoke you can see your rifle and
// nothing past it.
const CLEAR_FOG = { near: 11, far: 42, color: new THREE.Color(0x05060a) };
const SMOKE_FOG = { near: 0.12, far: 1.7, color: new THREE.Color(0x8f959e) };

export function syncSmokeFog(view, state, camPos) {
  let inside = 0;
  for (const c of state.smokes ?? []) {
    const r = c.radius * c.grown;
    if (r <= 0.05) continue;
    const d = Math.hypot(camPos.x - c.pos.x, camPos.y - (c.pos.y + 0.55), camPos.z - c.pos.z);
    // Full thickness a metre past the edge, so walking into a cloud closes in
    // over a stride rather than snapping shut on one frame.
    inside = Math.max(inside, Math.min(1, (r - d) / 1.0));
  }
  inside = Math.max(0, inside);
  // A cloud is as dark as the room it is in, and so is the inside of it.
  const lit = inside > 0 ? litness(state, view.world, camPos) : 1;
  const fog = view.scene.fog;
  fog.near = CLEAR_FOG.near + (SMOKE_FOG.near - CLEAR_FOG.near) * inside;
  fog.far = CLEAR_FOG.far + (SMOKE_FOG.far - CLEAR_FOG.far) * inside;
  fog.color.copy(CLEAR_FOG.color).lerp(
    SMOKE_FOG.color.clone().multiplyScalar(Math.min(1, lit)), inside,
  );
  view.scene.background.copy(fog.color);
}

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
  // A burning flare is its own light source, so it is drawn unlit and simply
  // bright — a lamp does not need lighting.
  const flareMat = new THREE.MeshBasicMaterial({ color: 0xff8a3a, toneMapped: false });

  // The light the flares throw. Pooled and alive from the first frame at zero
  // intensity for the same reason the impact sparks are: a point light that
  // appears mid-round changes the set of lights every material in the scene is
  // compiled against, and Three rebuilds all of them on the spot.
  const FLARE_LIGHTS = 6;
  const flareLights = [];
  for (let i = 0; i < FLARE_LIGHTS; i++) {
    const light = new THREE.PointLight(0xff7a30, 0, FLARE.radius, 2);
    scene.add(light);
    flareLights.push(light);
  }
  // A cloud is not a ball.
  //
  // It used to be one: a single sphere at 92% opacity. From outside that reads
  // as a grey balloon with a hard rim, and from inside it reads as nothing at
  // all — a sphere is drawn from the front only, so walking into your own
  // smoke deleted it and left you with a clear view of a room that could not
  // see you back. That is not cover, that is a wall hack.
  //
  // So: a dozen soft billboards through the volume, and — since the geometry
  // can only ever be the outside of the cloud — a wall of fog for the inside,
  // handled by `syncSmokeFog` below. Between the two there is no angle from
  // which the smoke is not in the way.
  const cloudGeo = new THREE.PlaneGeometry(1, 1);
  const cloudMat = new THREE.MeshBasicMaterial({
    map: puffTexture(),
    color: 0x9aa0a9,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
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

  function sync(state, world, camera) {
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
      thrown[i].material = t.kind === 'smoke' ? smokeCanMat
        : t.kind === 'flare' ? flareMat : flashMat;
      // A lit flare is a coal, not a grenade: small and far too bright to look
      // straight at, which is exactly the problem it makes for night vision.
      thrown[i].scale.setScalar(t.kind === 'flare' ? 0.55 : 1);
      thrown[i].position.set(t.pos.x, t.pos.y, t.pos.z);
    }

    // The pool of flare lights, handed out to whatever is burning. More flares
    // than lights would mean a stick that glows and lights nothing — with two
    // per defender and six lights that takes a whole side spending everything
    // at once, and even then the extra ones are still visible.
    const burning = flying.filter((t) => t.kind === 'flare');
    for (let i = 0; i < flareLights.length; i++) {
      const t = burning[i];
      if (!t) {
        flareLights[i].intensity = 0;
        continue;
      }
      flareLights[i].position.set(t.pos.x, t.pos.y + 0.05, t.pos.z);
      // The last three seconds gutter out rather than switching off.
      flareLights[i].intensity = FLARE.intensity * Math.min(1, t.fuse / 3);
    }

    // Clouds.
    const smokes = state.smokes ?? [];
    while (clouds.length < smokes.length) clouds.push(makeCloud(scene, cloudGeo, cloudMat));
    for (let i = 0; i < clouds.length; i++) {
      const c = smokes[i];
      const cloud = clouds[i];
      cloud.group.visible = !!c;
      if (!c) continue;
      cloud.group.position.set(c.pos.x, c.pos.y + 0.55, c.pos.z);
      cloud.group.scale.setScalar(Math.max(0.05, c.radius * c.grown));
      cloud.material.opacity = 0.52 * Math.min(1, c.grown * 1.6);
      // Smoke has no light of its own. It is as bright as the room it is
      // standing in — which means a cloud in a lit hallway is a white wall,
      // and the same cloud after somebody throws the breaker is a black one.
      cloud.material.color.copy(SMOKE_TINT).multiplyScalar(litness(state, world, c.pos));
      // Billboards face the camera; the slow spin is what keeps them from
      // reading as a stack of flat cards.
      if (camera) {
        for (const puff of cloud.puffs) {
          puff.quaternion.copy(camera.quaternion);
          puff.rotateZ(puff.userData.spin + state.time * puff.userData.rate);
        }
      }
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
  if (!p.alive) return poseBody(av, p);
  u.down = null;
  av.rotation.set(0, p.look.yaw, 0);

  const height = PLAYER.heightCrouch + (PLAYER.heightStand - PLAYER.heightCrouch) * p.stance;
  av.position.set(p.pos.x, p.pos.y, p.pos.z);
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

// A man who is hit goes down where he was standing and stays there.
//
// The simulation has nothing to say about a body — it stopped caring the
// moment the health reached zero — so the fall is recorded here, once, at the
// spot and the facing he had when it happened. After that nothing moves: a
// corpse in a doorway is information, and information that drifts is a lie.
export function poseBody(av, p) {
  const u = av.userData;
  if (!u.down) {
    // Which way he goes over is decided by his own name, so every client
    // draws the same body in the same place without anyone sending it.
    let h = 0;
    for (let i = 0; i < p.id.length; i++) h = (h * 31 + p.id.charCodeAt(i)) & 0xffff;
    u.down = {
      pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      yaw: p.look.yaw + ((h % 100) / 100 - 0.5) * 0.9,
      roll: ((h >> 7) % 100) / 100 < 0.5 ? -1 : 1,
    };
    // Arms and legs let go: nothing here is held up any more.
    u.chest.position.x = 0;
    u.chest.rotation.z = 0;
    u.head.position.x = 0;
    u.head.rotation.set(0.25, 0, u.down.roll * 0.5);
    u.arms.rotation.x = -0.35;
    u.legsRig.rotation.x = 0.12;
  }
  const d = u.down;
  // Face down, feet where they were, and lifted just clear of the floor so a
  // shoulder is lying on the boards rather than through them.
  av.position.set(d.pos.x, d.pos.y + 0.16, d.pos.z);
  av.rotation.set(-Math.PI / 2, d.yaw, d.roll * 0.22);
  av.scale.setScalar(1);
}

function clampPitch(pitch) {
  return Math.max(-1.1, Math.min(1.1, pitch));
}
