// Camera rig: turns a simulated player into a first-person view — lean, stance,
// recoil, breathing sway — plus the flashlight and the weapon model.

import * as THREE from '../../vendor/three.module.js?v=41124dad';
import { PLAYER, FLASHLIGHT, WEAPONS, FOV, DEFAULT_WEAPON } from '../sim/constants.js?v=41124dad';
import { lerp } from '../sim/math.js?v=41124dad';
import { buildWeaponModel } from './weapons.js?v=41124dad';

export function createView(scene) {
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 120);
  camera.rotation.order = 'YXZ';

  // Flashlight rides with the camera. This is the only shadow-casting light,
  // which keeps the scene cheap while still feeling properly dark.
  const torch = new THREE.SpotLight(0xf2f0e4, 0, FLASHLIGHT.range, FLASHLIGHT.angle, 0.75, 1.7);
  torch.castShadow = true;
  torch.shadow.mapSize.set(2048, 2048);
  torch.shadow.camera.near = 0.1;
  torch.shadow.camera.far = FLASHLIGHT.range;
  torch.shadow.bias = -0.0016;
  // A torch is a lamp in someone's hand, not the sun: its shadows have soft
  // edges. The map is doubled so there is detail to blur — a megabyte more of
  // video memory, and every doorway stops looking cut out with scissors.
  torch.shadow.radius = 3;
  torch.shadow.blurSamples = 12;
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
  //
  // Which model is in hand follows the player: the pick reaches this pass the
  // same way it reaches the simulation, by id, and the group is rebuilt only
  // when that id actually changes.
  let weapon = buildWeaponModel(DEFAULT_WEAPON);
  let weaponId = DEFAULT_WEAPON;
  weapon.group.scale.setScalar(weapon.scale);
  viewScene.add(weapon.group);

  function carry(id) {
    if (id === weaponId || !id) return;
    viewScene.remove(weapon.group);
    // Materials are shared across the roster; geometry is not. Drop it, or a
    // player who tries all eleven leaves eleven models on the graphics card.
    weapon.group.traverse((o) => o.geometry?.dispose());
    weapon = buildWeaponModel(id);
    weaponId = id;
    weapon.group.scale.setScalar(weapon.scale);
    viewScene.add(weapon.group);
  }

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
    recoilRoll: 0,
    crowd: 0,
  };
  // What the aim is doing to the field of view, so the runtime can slow the
  // mouse down by the same amount: glass that magnifies the target magnifies
  // the twitch as well, and a scope that turns like a red dot is unusable.
  let zoomNow = 1;
  let lastYaw = 0;
  let lastRecoilPitch = 0;
  let lastRecoilYaw = 0;
  let lastBurstShots = 0;

  // How close a wall has to be before the muzzle would be inside it. The
  // viewmodel is drawn over the world, so without this the barrel appears to
  // hang through the wall you are standing against.
  const CLEARANCE = 1.15;

  function update(player, dt, moving, wallDistance = Infinity) {
    carry(player.weapon?.id);
    const height = PLAYER.heightCrouch + (PLAYER.heightStand - PLAYER.heightCrouch) * player.stance;
    const eyeY = player.pos.y + height - PLAYER.eyeOffset;

    smoothed.lean = lerp(smoothed.lean, player.lean, Math.min(1, dt * 12));
    smoothed.aim = player.aimAmount;

    // Marksman glass pulls the room in. The weapon carries its own figure —
    // 2.4× on the two scoped rifles, 1× on everything with a dot — and the
    // camera follows the aim between the two. The viewmodel pass keeps the
    // wide angle: magnifying the weapon in your hands is not what a scope
    // does, and it would put the stock through the near plane.
    const wantZoom = 1 + (weapon.zoom - 1) * smoothed.aim;
    if (Math.abs(wantZoom - zoomNow) > 0.001) {
      zoomNow = wantZoom;
      camera.fov = FOV / zoomNow;
      camera.updateProjectionMatrix();
    }

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

    // Recoil kicks the gun back toward the shooter — once per round fired.
    //
    // This follows the kick of each shot, not the total climb of the sights.
    // Seven shots into a burst the sights sit eight degrees high and stay
    // there, and a viewmodel driven by that total would stand the weapon on
    // its end and fill half the screen with it. Driven by the step instead,
    // the gun punches and settles no matter how long you hold the trigger.
    // Every round gets a punch of its own on top of however far it moved the
    // sights, so the muzzle still jumps late in a burst, where the pattern has
    // settled and the sights barely climb any more.
    const burst = player.burstShots ?? 0;
    const fired = burst > lastBurstShots;
    lastBurstShots = burst;
    const kicked = Math.max(0, player.recoil.pitch - lastRecoilPitch);
    lastRecoilPitch = player.recoil.pitch;
    smoothed.recoilKick = Math.min(0.30, smoothed.recoilKick + (fired ? 0.1 : 0) + kicked * 4);
    smoothed.recoilKick = lerp(smoothed.recoilKick, 0, Math.min(1, dt * 14));

    // Sideways kick rolls the weapon a little, so the tremble is not purely
    // up and down.
    const kickedYaw = player.recoil.yaw - lastRecoilYaw;
    lastRecoilYaw = player.recoil.yaw;
    smoothed.recoilRoll = lerp(smoothed.recoilRoll + kickedYaw * 2.5, 0, Math.min(1, dt * 12));

    // Far enough forward that the stock never crowds the near plane — a gun
    // model straddling the eye reads as a grey slab across the screen.
    //
    // ADS is computed rather than tuned: the offset is whatever puts this
    // weapon's own sight on the middle of the screen. A scope sits 130 mm over
    // the bore and an SMG's optic 50 mm, and neither needs a magic number.
    // Carried, not posed. The old hip sat the weapon nine degrees off the line
    // of the screen, which reads as a man holding his rifle sideways — and
    // since the rounds go where the crosshair is and not where the barrel
    // points, it also reads as a lie. Two degrees of cant is a carry; nine is
    // a photograph.
    const hip = { x: 0.155, y: -0.205, z: -0.60 };
    const ads = {
      x: -weapon.sight.position.x * weapon.scale,
      y: -weapon.sight.position.y * weapon.scale,
      z: -0.60,
    };
    const t = smoothed.aim;
    weapon.group.position.set(
      lerp(hip.x, ads.x, t) + smoothed.sway.x * (1 - t * 0.7) + bobX * 0.8,
      lerp(hip.y, ads.y, t) + smoothed.sway.y + bobY * 0.8,
      lerp(hip.z, ads.z, t) + smoothed.recoilKick * 0.5,
    );
    // At the hip the weapon is carried on the right and turned a few degrees
    // across the body, so what the eye gets is its side — receiver, magazine,
    // the hands on it — rather than the back of a stock pointing at the lens.
    // Aiming swings all of that onto the sight line.
    weapon.group.rotation.set(
      lerp(0.045, 0, t) + smoothed.recoilKick * 1.4,
      lerp(0.115, 0, t) + smoothed.sway.x * 0.6 + smoothed.recoilRoll * 0.8,
      lerp(0.055, 0, t) + smoothed.recoilRoll,
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

    // Aiming folds the arms down and back: at the eye they are behind the
    // weapon, not beside it.
    if (weapon.arms) {
      weapon.arms.rotation.x = t * 0.42;
      weapon.arms.position.y = -t * 0.05;
      weapon.arms.position.z = t * 0.03;
    }

    // Reloading dips the weapon out of view.
    const w = player.weapon;
    if (w.reloading > 0) {
      const phase = 1 - Math.abs(w.reloading / w.reloadTotal - 0.5) * 2;
      weapon.group.position.y -= phase * 0.16;
      weapon.group.rotation.x += phase * 0.7;
    }

    // Torch follows the camera, offset toward the weapon so shadows look right.
    // Intensity only, never visibility: a spotlight that appears mid-round
    // makes Three recompile every material in the scene, and this one casts
    // shadows, so it would also allocate its shadow map at that moment.
    torch.intensity = player.flashlight ? FLASHLIGHT.intensity : 0;
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
    camera, torch, viewScene, viewCamera,
    // How much the sight is magnifying right now: 1 at the hip, up to the
    // weapon's own figure at full aim.
    get zoom() { return zoomNow; },
    // A getter, not the object: the model is replaced whenever the player
    // picks a different weapon.
    get weapon() { return weapon; },
    update, muzzleWorldPosition, flash, setAspect, smoothed,
    // Burn the torch for one warm-up frame: that is what allocates its shadow
    // map and compiles the shaders that use it.
    primeTorch(on) {
      torch.intensity = on ? FLASHLIGHT.intensity : 0;
      if (on) {
        torch.position.set(0, 1.6, 0);
        torch.target.position.set(0, 1.6, -5);
        torch.target.updateMatrixWorld();
      }
    },
  };
}

