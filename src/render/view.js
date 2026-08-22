// Camera rig: turns a simulated player into a first-person view — lean, stance,
// recoil, breathing sway — plus the flashlight and the weapon model.

import * as THREE from '../../vendor/three.module.js?v=1a8eeedb';
import { PLAYER, FLASHLIGHT, WEAPONS, FOV, DEFAULT_WEAPON } from '../sim/constants.js?v=1a8eeedb';
import { lerp } from '../sim/math.js?v=1a8eeedb';
import { buildWeaponModel } from './weapons.js?v=1a8eeedb';

// ── Where the weapon is held ───────────────────────────────────────────────
//
// One place for every number that decides what the gun looks like on screen,
// because they only make sense against each other and they are the numbers
// that get compared with a reference screenshot.
//
// At the hip the weapon is carried on the right, muzzle toward the middle of
// the screen and a little low: what the eye gets is its side — receiver,
// magazine, the hands on it — with the stock running off the bottom corner,
// which is how a rifle looks to the man holding it at low ready.
const CARRY = {
  x: 0.125,
  y: -0.125,
  z: -0.36,
  // Barely nosed down and turned only a few degrees across the body, so the
  // barrel runs at the middle of the screen instead of past it. Turned any
  // further and the stock swings into the bottom corner and stays there, which
  // is not a carry, it is a man wearing a rifle. Aiming takes all of this out
  // and puts the sight on the axis instead.
  pitch: -0.018,
  yaw: 0.06,
  roll: 0.04,
};

// ADS is computed rather than tuned: whatever puts this weapon's own sight on
// the middle of the screen, this far from the eye, with the viewmodel's lens
// narrowed to that angle. The narrow field is what does the work — it
// magnifies the whole weapon while the world keeps its own wide angle, so the
// optic grows to the size it should be and the barrel recedes the way it does
// along a real rifle.
const ADS_SIGHT_DIST = 0.255;
const ADS_FOV = 30;

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
    // The three ways a shot shows in the hands: the muzzle climbing, the
    // muzzle walking sideways, and the whole thing shoved back at you.
    climb: 0,
    swing: 0,
    push: 0,
    crowd: 0,
  };
  // What the aim is doing to the field of view, so the runtime can slow the
  // mouse down by the same amount: glass that magnifies the target magnifies
  // the twitch as well, and a scope that turns like a red dot is unusable.
  let zoomNow = 1;
  // How far into a scope's own sight picture we are: 0 at the hip, 1 with the
  // eyepiece filling the screen. The HUD reads it every frame.
  let scoped = 0;
  let lastYaw = 0;
  let lastRecoilPitch = 0;
  let lastRecoilYaw = 0;
  let lastBurstShots = 0;

  // ── What aiming does to the camera the weapon is drawn with ──
  //
  // The sights used to come up and change almost nothing: the optic stayed a
  // metre from the eye and four per cent of the screen high, so aiming a rifle
  // read as looking down at the top of one. A real sight picture is the other
  // way round — the glass is a hand's width from your eye and fills a third of
  // what you can see, and the barrel runs away from it into the distance.
  //
  // Two numbers get that without pretending the eye is really 80 mm behind the
  // rail (at which distance the stock would be through the back of your head):
  //
  //   ADS_SIGHT_DIST — where the weapon's own sight sits when the aim is up.
  //   ADS_FOV        — the viewmodel pass's field of view at that moment.
  //
  // The narrow field is what does the work. It magnifies the whole viewmodel
  // about three times while the world keeps its own wide angle, so the optic
  // grows to the size it should be, the parts nearer the muzzle recede the way
  // they do along a real rifle, and nothing about where the rounds go moves —
  // the mark is on the axis, and the axis is the middle of the screen.
  let viewFov = FOV;

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

    // Recoil, as the muzzle moving rather than as the hands shaking.
    //
    // The simulation already owns the recoil: it walks the sights up and side
    // to side along a pattern you can learn. What the viewmodel adds is the
    // sight of that happening — the weapon pivots about its own sight, so the
    // barrel climbs and swings while the mark stays exactly where the rounds
    // are going. It follows the pattern's own steps rather than inventing a
    // tremble of its own, and the one thing it adds is a shove straight back
    // into the shoulder, which is the only motion that cannot move the aim.
    const burst = player.burstShots ?? 0;
    const fired = burst > lastBurstShots;
    lastBurstShots = burst;
    const kickedPitch = Math.max(0, player.recoil.pitch - lastRecoilPitch);
    lastRecoilPitch = player.recoil.pitch;
    const kickedYaw = player.recoil.yaw - lastRecoilYaw;
    lastRecoilYaw = player.recoil.yaw;

    smoothed.climb = lerp(
      Math.min(0.11, smoothed.climb + kickedPitch * 2.4 + (fired ? 0.012 : 0)),
      0, Math.min(1, dt * 9),
    );
    smoothed.swing = lerp(
      Math.max(-0.09, Math.min(0.09, smoothed.swing + kickedYaw * 2.4)),
      0, Math.min(1, dt * 9),
    );
    smoothed.push = lerp(
      Math.min(0.05, smoothed.push + (fired ? 0.018 : 0)),
      0, Math.min(1, dt * 11),
    );

    // Carried, not posed. The hip keeps the weapon far enough forward that the
    // stock never crowds the near plane — a gun model straddling the eye reads
    // as a grey slab across the screen — and turned a couple of degrees across
    // the body, which is a carry. Nine degrees, which this used to have, is a
    // photograph: a man holding his rifle sideways while the rounds go where
    // the crosshair is.
    const t = smoothed.aim;
    weapon.group.scale.setScalar(weapon.scale);

    // The viewmodel's own lens narrows as the sights come up. Only when it
    // actually moves: rebuilding a projection matrix every frame of a round is
    // work for nothing.
    const wantFov = lerp(FOV, ADS_FOV, t);
    if (Math.abs(wantFov - viewFov) > 0.01) {
      viewFov = wantFov;
      viewCamera.fov = viewFov;
      viewCamera.updateProjectionMatrix();
    }

    // Where the weapon points. The rotation goes first, because where it has
    // to *sit* depends on it.
    weapon.group.rotation.set(
      lerp(CARRY.pitch, 0, t) + smoothed.climb,
      lerp(CARRY.yaw, 0, t) + smoothed.sway.x * 0.6 * (1 - t) + smoothed.swing,
      lerp(CARRY.roll, 0, t) + smoothed.swing * 0.5 * (1 - t),
    );

    // ...and the sight goes on the middle of the screen and stays there.
    //
    // This is the one thing aiming has to get right, and it used to be wrong:
    // sway, head bob and the recoil rotation all moved the model after the
    // aiming offset was worked out, and since the model turns about the grip,
    // half a degree of it swung the optic a long way off the axis. The mark
    // wandered; the rounds did not, because the simulation fires down the
    // camera. On a submachine gun held on a distant target that reads as a
    // weapon that does not shoot where it is pointed.
    //
    // So: rotate the sight's own offset by whatever the weapon is doing, and
    // put the model wherever leaves that offset on the axis. Now the barrel
    // can climb and swing all it likes — it pivots about the glass, and the
    // dot sits on the point of impact through the whole burst. Everything that
    // is not on the axis fades out with the aim.
    const hip = CARRY;
    const pinned = weapon.sight.position.clone()
      .multiplyScalar(weapon.scale)
      .applyEuler(weapon.group.rotation);
    const ads = { x: -pinned.x, y: -pinned.y, z: -ADS_SIGHT_DIST - pinned.z };
    const loose = 1 - t;
    weapon.group.position.set(
      lerp(hip.x, ads.x, t) + (smoothed.sway.x + bobX * 0.8) * loose,
      lerp(hip.y, ads.y, t) + (smoothed.sway.y + bobY * 0.8) * loose,
      lerp(hip.z, ads.z, t) + smoothed.push,
    );

    // Up against a wall: pull the weapon in and raise the muzzle, the way you
    // would actually carry it in a doorway. This is what keeps the barrel out
    // of the wall rather than hanging through it.
    const wantCrowd = Math.max(0, Math.min(1, 1 - wallDistance / CLEARANCE));
    smoothed.crowd = lerp(smoothed.crowd, wantCrowd, Math.min(1, dt * 11));
    if (smoothed.crowd > 0.001 && loose > 0.001) {
      // ...but not while aiming. Nothing moves the sight off the axis.
      const c = smoothed.crowd * loose;
      weapon.group.position.z += c * 0.26;
      weapon.group.position.y -= c * 0.02;
      weapon.group.position.x += c * 0.10;
      weapon.group.rotation.x -= c * 0.34;
      weapon.group.rotation.z += c * 0.12;
    }

    // Aiming folds the arms down and back and out of frame.
    //
    // The support forearm runs back toward the eye, and the narrow lens the
    // sights are drawn with magnifies whatever is nearest the camera about
    // three times — so at the eye that sleeve was a slab across the bottom
    // corner of the screen. At the shoulder the arms are below the sight line
    // and behind the weapon, which on a screen means gone.
    // Mostly a drop, barely a fold: swinging them about the grip past a
    // radian brings the far end of the support forearm back up and into the
    // sight picture, which is the opposite of the point — at the eye it filled
    // the bottom corner of the screen with a black slab, and on the shorter
    // weapons it filled the window.
    if (weapon.arms) {
      weapon.arms.rotation.x = t * 0.5;
      weapon.arms.position.y = -t * 0.30;
      weapon.arms.position.z = t * 0.16;
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

    // Down a scope there is no weapon to see. Magnified glass fills the whole
    // eye — a circle of picture with black around it, which the HUD draws —
    // and a rifle drawn across the middle of that is a rifle in the way. Every
    // game with a real scope does this; ours just does it a frame earlier.
    scoped = weapon.optic === 'scope' ? Math.max(0, (t - 0.55) / 0.4) : 0;
    scoped = Math.min(1, scoped);
    weapon.group.visible = player.alive && scoped < 0.98;

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
    // ...and how much of the screen the eyepiece has taken over, which is only
    // ever non-zero on the two weapons with glass on them.
    get scoped() { return scoped; },
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

