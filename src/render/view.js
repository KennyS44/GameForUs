// Camera rig: turns a simulated player into a first-person view — lean, stance,
// recoil, breathing sway — plus the flashlight and the weapon model.

import * as THREE from '../../vendor/three.module.js?v=4947c3af';
import { PLAYER, FLASHLIGHT, WEAPONS, FOV } from '../sim/constants.js?v=4947c3af';
import { lerp } from '../sim/math.js?v=4947c3af';

export function createView(scene) {
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 120);
  camera.rotation.order = 'YXZ';

  // Flashlight rides with the camera. This is the only shadow-casting light,
  // which keeps the scene cheap while still feeling properly dark.
  const torch = new THREE.SpotLight(0xf2f0e4, 0, FLASHLIGHT.range, FLASHLIGHT.angle, 0.75, 1.7);
  torch.castShadow = true;
  torch.shadow.mapSize.set(1024, 1024);
  torch.shadow.camera.near = 0.1;
  torch.shadow.camera.far = FLASHLIGHT.range;
  torch.shadow.bias = -0.0016;
  scene.add(torch);
  scene.add(torch.target);
  scene.add(camera);

  // ── Viewmodel pass ──
  //
  // The weapon gets its own scene, camera and lights, drawn on top of the world.
  //
  // Render layers cannot do this job: Three.js decides which lights are active
  // by testing each light's layers against the *camera*, not against individual
  // objects, so the torch — which sits at the camera — would always blow the
  // weapon out to a white slab. A separate pass also means the barrel can never
  // poke through a wall.
  const viewScene = new THREE.Scene();
  const viewCamera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 6);

  // The weapon model sits further out and scaled up rather than close and
  // small: same size on screen, far less perspective distortion at a wide FOV.
  const weapon = buildWeaponModel();
  weapon.group.scale.setScalar(1.7);
  viewScene.add(weapon.group);

  // Key light from the upper right, plus a cool fill so the shadowed side
  // never goes to pure black.
  const keyLight = new THREE.DirectionalLight(0xfff0dc, 3.2);
  keyLight.position.set(0.6, 1, 0.4);
  viewScene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8aa0c0, 1.1);
  fillLight.position.set(-0.8, -0.2, 0.6);
  viewScene.add(fillLight);
  viewScene.add(new THREE.AmbientLight(0x2a3040, 0.9));

  // Flash that lights the weapon itself when it fires.
  const viewMuzzle = new THREE.PointLight(0xffcf8a, 0, 2.5, 2);
  viewMuzzle.position.set(0, 0.02, -0.75);
  viewScene.add(viewMuzzle);
  let viewMuzzleLife = 0;

  const smoothed = {
    lean: 0,
    stance: 1,
    bob: 0,
    sway: { x: 0, y: 0 },
    aim: 0,
    recoilKick: 0,
    crowd: 0,
  };
  let lastYaw = 0;

  // How close a wall has to be before the muzzle would be inside it. The
  // viewmodel is drawn over the world, so without this the barrel appears to
  // hang through the wall you are standing against.
  const CLEARANCE = 1.15;

  function update(player, dt, moving, wallDistance = Infinity) {
    const height = PLAYER.heightCrouch + (PLAYER.heightStand - PLAYER.heightCrouch) * player.stance;
    const eyeY = player.pos.y + height - PLAYER.eyeOffset;

    smoothed.lean = lerp(smoothed.lean, player.lean, Math.min(1, dt * 12));
    smoothed.aim = player.aimAmount;

    // Lean shifts the camera sideways and rolls it a little.
    const yaw = player.look.yaw + player.recoil.yaw;
    const pitch = player.look.pitch + player.recoil.pitch;
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const leanOffset = smoothed.lean * PLAYER.leanMax;

    // Head bob while walking — subtle, and it stops when you aim.
    const speed = Math.hypot(player.vel.x, player.vel.z);
    if (moving && player.grounded) smoothed.bob += dt * speed * 3.4;
    const bobAmount = (1 - smoothed.aim * 0.85) * Math.min(speed / PLAYER.speedRun, 1) * 0.022;
    const bobY = Math.sin(smoothed.bob * 2) * bobAmount;
    const bobX = Math.cos(smoothed.bob) * bobAmount * 0.6;

    camera.position.set(
      player.pos.x + rightX * leanOffset + rightX * bobX,
      eyeY + bobY,
      player.pos.z + rightZ * leanOffset + rightZ * bobX,
    );
    camera.rotation.set(pitch, yaw, -smoothed.lean * PLAYER.leanAngle);

    // Weapon sway: the gun lags behind fast turns.
    let dYaw = yaw - lastYaw;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    lastYaw = yaw;
    smoothed.sway.x = lerp(smoothed.sway.x, -dYaw * 1.6, Math.min(1, dt * 10));
    smoothed.sway.y = lerp(smoothed.sway.y, 0, Math.min(1, dt * 10));

    // Recoil kicks the gun back toward the shooter.
    smoothed.recoilKick = lerp(smoothed.recoilKick, player.recoil.pitch * 6, Math.min(1, dt * 18));

    // Far enough forward that the stock never crowds the near plane — a gun
    // model straddling the eye reads as a grey slab across the screen.
    // In ADS the y offset puts the rear sight exactly on the screen centre.
    const hip = { x: 0.13, y: -0.20, z: -0.80 };
    const ads = { x: 0.0, y: -0.093, z: -0.64 };
    const t = smoothed.aim;
    weapon.group.position.set(
      lerp(hip.x, ads.x, t) + smoothed.sway.x * (1 - t * 0.7) + bobX * 0.8,
      lerp(hip.y, ads.y, t) + smoothed.sway.y + bobY * 0.8,
      lerp(hip.z, ads.z, t) + smoothed.recoilKick * 0.5,
    );
    // At the hip the gun is canted inward and slightly down, the way it sits
    // when carried; aiming straightens it onto the sight line.
    weapon.group.rotation.set(
      lerp(0.05, 0, t) + smoothed.recoilKick * 1.4,
      lerp(-0.07, 0, t) + smoothed.sway.x * 0.6,
      lerp(0.06, 0, t),
    );

    // Up against a wall: pull the weapon in and raise the muzzle, the way you
    // would actually carry it in a doorway. This is what keeps the barrel out
    // of the wall rather than hanging through it.
    const wantCrowd = Math.max(0, Math.min(1, 1 - wallDistance / CLEARANCE));
    smoothed.crowd = lerp(smoothed.crowd, wantCrowd, Math.min(1, dt * 11));
    if (smoothed.crowd > 0.001) {
      const c = smoothed.crowd;
      weapon.group.position.z += c * 0.26;
      weapon.group.position.y -= c * 0.02;
      weapon.group.position.x += c * 0.10;
      weapon.group.rotation.x -= c * 0.34;
      weapon.group.rotation.z += c * 0.12;
    }

    // Reloading dips the weapon out of view.
    const w = player.weapon;
    if (w.reloading > 0) {
      const phase = 1 - Math.abs(w.reloading / w.reloadTotal - 0.5) * 2;
      weapon.group.position.y -= phase * 0.16;
      weapon.group.rotation.x += phase * 0.7;
    }

    // Torch follows the camera, offset toward the weapon so shadows look right.
    torch.intensity = player.flashlight ? FLASHLIGHT.intensity : 0;
    torch.visible = player.flashlight;
    if (player.flashlight) {
      camera.getWorldPosition(torch.position);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      torch.target.position.copy(torch.position).addScaledVector(dir, 10);
      torch.target.updateMatrixWorld();
    }

    weapon.group.visible = player.alive;

    if (viewMuzzleLife > 0) {
      viewMuzzleLife -= dt;
      viewMuzzle.intensity = Math.max(0, (viewMuzzleLife / 0.045) * 6);
    }
  }

  // The viewmodel scene uses camera-local coordinates, so converting a point
  // out of it is just the camera's own transform.
  function muzzleWorldPosition() {
    const v = new THREE.Vector3();
    weapon.muzzle.getWorldPosition(v);
    return camera.localToWorld(v);
  }

  function flash() {
    viewMuzzleLife = 0.045;
    viewMuzzle.intensity = 6;
  }

  function setAspect(aspect) {
    camera.aspect = aspect;
    viewCamera.aspect = aspect;
    camera.updateProjectionMatrix();
    viewCamera.updateProjectionMatrix();
  }

  return {
    camera, torch, weapon, viewScene, viewCamera,
    update, muzzleWorldPosition, flash, setAspect, smoothed,
  };
}

// A blocky MP5. The shapes are simple, but the proportions and the two-tone
// finish are what make it read as a weapon rather than a plank.
function buildWeaponModel() {
  const group = new THREE.Group();

  // A touch of emissive keeps the silhouette readable when every light is out.
  const steel = new THREE.MeshStandardMaterial({
    color: 0x24262c, roughness: 0.5, metalness: 0.6, emissive: 0x0c0e13,
  });
  const polymer = new THREE.MeshStandardMaterial({
    color: 0x111216, roughness: 0.95, metalness: 0.05, emissive: 0x080a0e,
  });

  const add = (geo, mat, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    group.add(m);
    return m;
  };

  // Receiver: the long spine of the gun, running away from the camera.
  const receiver = add(new THREE.BoxGeometry(0.05, 0.072, 0.26), steel, 0, 0, -0.05);
  // Raised top rail, so the top face has an edge to catch light.
  add(new THREE.BoxGeometry(0.028, 0.018, 0.24), steel, 0, 0.044, -0.05);

  // Handguard and barrel out front.
  add(new THREE.BoxGeometry(0.046, 0.05, 0.15), polymer, 0, -0.008, -0.245);
  const barrel = add(new THREE.CylinderGeometry(0.011, 0.011, 0.13, 10), steel, 0, 0.008, -0.36);
  barrel.rotation.x = Math.PI / 2;
  // Muzzle ring gives the front end some weight.
  const cap = add(new THREE.CylinderGeometry(0.017, 0.017, 0.03, 10), steel, 0, 0.008, -0.415);
  cap.rotation.x = Math.PI / 2;

  // Magazine, raked forward the way an MP5's is.
  add(new THREE.BoxGeometry(0.026, 0.15, 0.042), polymer, 0, -0.10, -0.105, -0.14);

  // Pistol grip and trigger guard.
  add(new THREE.BoxGeometry(0.032, 0.105, 0.045), polymer, 0, -0.095, 0.035, 0.3);
  add(new THREE.BoxGeometry(0.026, 0.012, 0.05), steel, 0, -0.048, -0.02);

  // Folding stock: two thin rails and a pad, not a solid block.
  add(new THREE.BoxGeometry(0.012, 0.012, 0.15), steel, 0.024, -0.01, 0.15);
  add(new THREE.BoxGeometry(0.012, 0.012, 0.15), steel, -0.024, -0.01, 0.15);
  add(new THREE.BoxGeometry(0.05, 0.055, 0.018), polymer, 0, -0.01, 0.225);

  // Iron sights — the aiming reference when you press RMB. The rear aperture
  // sits at x=0 so it lands exactly on the screen centre in ADS.
  const rearSight = new THREE.Mesh(new THREE.TorusGeometry(0.010, 0.0028, 6, 12), steel);
  rearSight.position.set(0, 0.06, 0.055);
  group.add(rearSight);

  // Front sight tower with a post inside it.
  add(new THREE.BoxGeometry(0.004, 0.026, 0.005), steel, 0.013, 0.052, -0.33);
  add(new THREE.BoxGeometry(0.004, 0.026, 0.005), steel, -0.013, 0.052, -0.33);
  add(new THREE.BoxGeometry(0.003, 0.018, 0.004), steel, 0, 0.05, -0.33);

  // Charging handle on the left — an asymmetric detail that sells the shape.
  add(new THREE.BoxGeometry(0.018, 0.012, 0.05), steel, -0.033, 0.03, -0.19);

  // Gloved hands, wrapped tight onto the grip and handguard. Kept small and
  // slightly lighter than the polymer, so they read as hands holding the gun
  // rather than as dark blocks floating beneath it.
  const glove = new THREE.MeshStandardMaterial({
    color: 0x2b2e35, roughness: 1.0, emissive: 0x0d0f14,
  });
  // Firing hand on the pistol grip.
  add(new THREE.BoxGeometry(0.048, 0.07, 0.058), glove, 0.002, -0.072, 0.028, 0.3);
  // Support hand on the handguard.
  add(new THREE.BoxGeometry(0.056, 0.058, 0.08), glove, 0.002, -0.03, -0.245);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.008, -0.44);
  group.add(muzzle);

  return { group, muzzle, receiver };
}
