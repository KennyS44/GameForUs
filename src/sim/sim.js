// The authoritative simulation.
//
// Contract: inputs in, world state out, nothing else. No Three.js, no DOM, no
// Math.random, no Date.now. Today this runs inside the host's browser tab; to
// go online it runs unchanged inside a Node process and only the transport
// around it changes.

import {
  PLAYER, LOOK, DAMAGE, WEAPONS, DOOR, FLASHLIGHT, NOISE, ROUND, DT,
} from './constants.js?v=dd0e4e06';
import {
  clamp, approach, dirFromAngles, distXZ, makeRng, rayBox,
} from './math.js?v=dd0e4e06';
import {
  moveAndCollide, groundedAt, raycastGeometry, doorFrame, worldToLocal, dirToLocal,
} from './world.js?v=dd0e4e06';

const GRAVITY = 18;

export function createInput() {
  return {
    moveX: 0, moveZ: 0,
    yaw: 0, pitch: 0,
    run: false, sneak: false, crouch: false, jump: false,
    lean: 0,
    fire: false, aim: false, reload: false,
    use: false, kick: false, toggleLight: false,
  };
}

function createPlayer(id, team, spawn, name) {
  const w = WEAPONS.mp5;
  return {
    id, team, name,
    // Spawns carry their own height, so a defender can start upstairs.
    pos: { x: spawn.x, y: spawn.y ?? 0, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    look: { yaw: spawn.yaw ?? 0, pitch: 0 },
    recoil: { yaw: 0, pitch: 0 },
    stance: 1, // 1 = standing, 0 = fully crouched
    crouching: false,
    lean: 0,
    grounded: true,
    health: PLAYER.maxHealth,
    armour: true,
    alive: true,
    flashlight: false,
    aimAmount: 0,
    weapon: {
      id: 'mp5',
      ammo: w.magSize,
      mags: w.reserveMags,
      cooldown: 0,
      reloading: 0,
      reloadTotal: 0,
    },
    kickCooldown: 0,
    useCooldown: 0,
    jumpCooldown: 0,
    airborne: false,
    burstShots: 0,
    sinceShot: 99,
    lastNoise: 0,
    kills: 0,
    deaths: 0,
  };
}

export function createState(world, seed = 12345) {
  const doors = {};
  for (const d of world.doors) {
    doors[d.id] = {
      open: 0,
      target: 0,
      speed: DOOR.openSpeed,
      health: d.maxHealth,
      // `forced` means the latch is destroyed: the door swings free and can no
      // longer be shut. The panel itself stays on its hinges and still stops
      // bullets — a kicked door is cover you can no longer close.
      forced: false,
      // Glass does not swing open when it loses: the pane falls out and the
      // doorway is simply gone.
      broken: false,
      locked: d.lockedByDefault,
    };
  }
  const lights = {};
  for (const l of world.lights) lights[l.id] = { broken: false };

  return {
    tick: 0,
    time: 0,
    phase: 'prep',
    phaseTime: ROUND.prepTime,
    players: {},
    doors,
    lights,
    events: [],
    seed,
    rngCalls: 0,
  };
}

export function addPlayer(world, state, id, team, name) {
  const spawns = world.map.spawns[team === 'attackers' ? 'attackers' : 'defenders'];
  const taken = Object.values(state.players).filter((p) => p.team === team).length;
  const spawn = spawns[taken % spawns.length];
  state.players[id] = createPlayer(id, team, spawn, name);
  return state.players[id];
}

export function removePlayer(state, id) {
  delete state.players[id];
}

// Deterministic randomness: derived from seed + call count, so the host and any
// future server produce identical spread patterns from identical inputs.
function nextRandom(state) {
  const rng = makeRng(state.seed + state.rngCalls * 2654435761);
  state.rngCalls++;
  return rng();
}

function emit(state, ev) {
  state.events.push(ev);
}

function makeNoise(state, pos, radius, kind, by) {
  emit(state, { type: 'noise', pos: { ...pos }, radius, kind, by });
}

// ── Player hitboxes ───────────────────────────────────────────────────────

function playerHeight(p) {
  return PLAYER.heightCrouch + (PLAYER.heightStand - PLAYER.heightCrouch) * p.stance;
}

// Sideways offset of the head when leaning. The renderer moves the camera by
// exactly this much, so muzzle, eye and hitbox all agree: if you can see round
// the corner, you can shoot round it — and be shot.
export function leanOffset(p) {
  const amount = (p.lean ?? 0) * PLAYER.leanMax;
  return {
    x: Math.cos(p.look.yaw) * amount,
    z: -Math.sin(p.look.yaw) * amount,
  };
}

// Cast sideways from the spine at head height: whatever the shoulder would
// pass through is where the lean has to stop.
const LEAN_CLEARANCE = 0.16;

function clampLeanToCover(world, state, p) {
  if (!p.lean) return;
  const h = playerHeight(p);
  const from = { x: p.pos.x, y: p.pos.y + h - PLAYER.eyeOffset, z: p.pos.z };
  const side = Math.sign(p.lean);
  const dir = {
    x: Math.cos(p.look.yaw) * side,
    y: 0,
    z: -Math.sin(p.look.yaw) * side,
  };
  const reach = Math.abs(p.lean) * PLAYER.leanMax + LEAN_CLEARANCE;
  const hits = raycastGeometry(world, state, from, dir, reach);
  if (!hits.length) return;
  const room = Math.max(0, hits[0].t - LEAN_CLEARANCE);
  p.lean = side * Math.min(Math.abs(p.lean), room / PLAYER.leanMax);
}

export function eyePosition(p) {
  const h = playerHeight(p);
  const off = leanOffset(p);
  return {
    x: p.pos.x + off.x,
    y: p.pos.y + h - PLAYER.eyeOffset,
    z: p.pos.z + off.z,
  };
}

function hitboxes(p) {
  const h = playerHeight(p);
  const off = leanOffset(p);
  // Leaning is a movement of the upper body: the head swings out fully, the
  // chest follows part way, the legs stay planted behind cover.
  const hx = p.pos.x + off.x;
  const hz = p.pos.z + off.z;
  const tx = p.pos.x + off.x * 0.6;
  const tz = p.pos.z + off.z * 0.6;
  const { x, z } = p.pos;
  const y = p.pos.y;
  return [
    {
      zone: 'head',
      min: { x: hx - 0.12, y: y + h - 0.26, z: hz - 0.12 },
      max: { x: hx + 0.12, y: y + h, z: hz + 0.12 },
    },
    {
      zone: 'torso',
      min: { x: tx - 0.22, y: y + h * 0.45, z: tz - 0.19 },
      max: { x: tx + 0.22, y: y + h - 0.26, z: tz + 0.19 },
    },
    {
      zone: 'limb',
      min: { x: x - 0.22, y: y, z: z - 0.19 },
      max: { x: x + 0.22, y: y + h * 0.45, z: z + 0.19 },
    },
  ];
}

// ── Bullets ───────────────────────────────────────────────────────────────

const MAX_RANGE = 60;

function fireBullet(world, state, shooter, origin, dir) {
  const weapon = WEAPONS[shooter.weapon.id];
  let penetrationLeft = weapon.penetration; // in centimetres of drywall
  let damageScale = 1;
  let start = 0;

  for (let bounce = 0; bounce < 6; bounce++) {
    const geo = raycastGeometry(world, state, addScaled(origin, dir, start), dir, MAX_RANGE - start);

    // Nearest player along the remaining ray.
    let best = null;
    for (const p of Object.values(state.players)) {
      if (!p.alive || p.id === shooter.id) continue;
      for (const hb of hitboxes(p)) {
        const r = rayBox(addScaled(origin, dir, start), dir, hb);
        if (!r.hit || r.tNear < 0) continue;
        if (!best || r.tNear < best.t) best = { t: r.tNear, player: p, zone: hb.zone };
      }
    }

    const firstGeo = geo[0];
    // Player hit first — nothing blocking.
    if (best && (!firstGeo || best.t < firstGeo.t)) {
      applyDamage(state, shooter, best.player, best.zone, damageScale);
      const at = addScaled(origin, dir, start + best.t);
      emit(state, { type: 'impact', pos: at, normal: { x: 0, y: 1, z: 0 }, material: 'flesh' });
      return;
    }

    if (!firstGeo) {
      return; // into the void
    }

    const at = addScaled(origin, dir, start + firstGeo.t);
    emit(state, {
      type: 'impact',
      pos: at,
      normal: firstGeo.normal,
      material: firstGeo.material.name,
    });

    // Can the round punch through?
    const thicknessCm = Math.max(1, (firstGeo.exit - firstGeo.t) * 100);
    const mat = firstGeo.material;
    if (mat.penetration <= 0 || thicknessCm > penetrationLeft) {
      if (firstGeo.kind === 'door') damageDoor(world, state, firstGeo.doorId, 8, shooter);
      return; // stopped
    }
    if (firstGeo.kind === 'door') damageDoor(world, state, firstGeo.doorId, 8, shooter);
    if (mat.name === 'glass') breakGlass(state, firstGeo);

    penetrationLeft -= thicknessCm;
    damageScale *= Math.max(0.25, 1 - (thicknessCm * DAMAGE.penetrationLossPerCm) / 100);
    start += firstGeo.exit + 0.02;
    if (start >= MAX_RANGE) return;
  }
}

function addScaled(o, d, s) {
  return { x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s };
}

function applyDamage(state, shooter, target, zone, scale) {
  // Nobody dies during the staging phase. Rounds are one life each, so being
  // shot before the round has even started is not a fair way to lose it.
  if (state.phase === 'prep') return;

  let dmg = DAMAGE[zone] * scale;
  if (zone === 'torso' && target.armour) dmg = Math.max(6, dmg - DAMAGE.armourReduction);

  target.health -= dmg;
  emit(state, { type: 'hit', targetId: target.id, by: shooter.id, zone, damage: dmg });

  if (target.health <= 0 && target.alive) {
    target.alive = false;
    target.health = 0;
    target.deaths++;
    shooter.kills++;
    emit(state, { type: 'death', id: target.id, by: shooter.id, zone });
  }
}

function breakGlass(state, hit) {
  emit(state, { type: 'glass', pos: hit.pos });
}

function damageDoor(world, state, doorId, amount, by) {
  const ds = state.doors[doorId];
  if (!ds || ds.forced || ds.broken) return;
  const d = world.doors.find((x) => x.id === doorId);
  const glass = d?.material.name === 'glass';

  // A pane is counted in hits, not in points: two rounds anywhere on it, or
  // one boot, and it is gone. A solid door is worn down as before.
  ds.health -= glass ? (amount >= DOOR.kickDamage ? ds.health : 1) : amount;
  if (ds.health > 0) return;

  const at = { x: d ? d.pos.x : 0, y: (d?.pos.y ?? 0) + 1, z: d ? d.pos.z : 0 };
  if (glass) {
    ds.broken = true;
    ds.open = 0;
    ds.target = 0;
    ds.locked = false;
    emit(state, { type: 'doorShatter', doorId, by: by?.id });
    makeNoise(state, at, DOOR.loudnessKick, 'doorShatter', by?.id);
    return;
  }

  ds.forced = true;
  ds.locked = false;
  ds.target = 1;
  ds.speed = DOOR.kickSpeed;
  emit(state, { type: 'doorBreak', doorId, by: by?.id });
  makeNoise(state, at, DOOR.loudnessKick, 'doorBreak', by?.id);
}

// Shooting out a bulb: check whether the bullet line passes near a light.
function checkLightHits(world, state, origin, dir, shooter) {
  for (const l of world.lights) {
    const ls = state.lights[l.id];
    if (ls.broken) continue;
    const box = {
      min: { x: l.pos.x - 0.16, y: l.pos.y - 0.16, z: l.pos.z - 0.16 },
      max: { x: l.pos.x + 0.16, y: l.pos.y + 0.16, z: l.pos.z + 0.16 },
    };
    const r = rayBox(origin, dir, box);
    if (!r.hit || r.tNear < 0 || r.tNear > MAX_RANGE) continue;
    // Only if nothing solid is in the way.
    const geo = raycastGeometry(world, state, origin, dir, r.tNear - 0.02);
    if (geo.length) continue;
    ls.broken = true;
    emit(state, { type: 'lightBreak', id: l.id, pos: { ...l.pos } });
    makeNoise(state, l.pos, 12, 'glass', shooter.id);
  }
}

// ── Doors ─────────────────────────────────────────────────────────────────

// Which door is the player looking at, within reach?
function doorInReach(world, state, p, range) {
  const eye = eyePosition(p);
  const dir = aimDirection(p);
  let best = null;
  for (const door of world.doors) {
    const ds = state.doors[door.id];
    if (ds.broken) continue; // there is nothing left to push
    const frame = doorFrame(door, ds.open);
    const lo = worldToLocal(frame, eye);
    const ld = dirToLocal(frame, dir);
    const r = rayBox(lo, ld, door.localBox);
    if (!r.hit || r.tNear < 0 || r.tNear > range) continue;
    if (!best || r.tNear < best.t) best = { door, state: ds, t: r.tNear, localHit: lo.x + ld.x * r.tNear };
  }
  return best;
}

function pushDoor(world, state, p, target, speed, loudness) {
  const found = doorInReach(world, state, p, 1.9);
  if (!found) return false;
  const ds = found.state;
  if (ds.locked) {
    emit(state, { type: 'doorLocked', doorId: found.door.id });
    return true;
  }
  ds.target = target;
  ds.speed = speed;
  makeNoise(state, { x: found.door.pos.x, y: (found.door.pos.y ?? 0) + 1, z: found.door.pos.z }, loudness, 'door', p.id);
  emit(state, { type: 'doorMove', doorId: found.door.id, target });
  return true;
}

// One kick takes any door, locked or not. It flies open on its hinges — loudly,
// which is the real cost of doing it.
function kickDoor(world, state, p) {
  const found = doorInReach(world, state, p, DOOR.kickRange);
  if (!found) return false;
  const ds = found.state;

  emit(state, { type: 'doorKick', doorId: found.door.id, by: p.id });
  makeNoise(state, { x: found.door.pos.x, y: (found.door.pos.y ?? 0) + 1, z: found.door.pos.z }, DOOR.loudnessKick, 'kick', p.id);

  // A door with nothing left to break just gets shoved the rest of the way.
  if (ds.forced || ds.broken) {
    ds.target = 1;
    ds.speed = DOOR.kickSpeed;
    return true;
  }

  // Everything else goes through the same rule a bullet does, so a boot in a
  // pane of glass takes it out of the frame instead of swinging it open.
  damageDoor(world, state, found.door.id, DOOR.kickDamage, p);
  return true;
}

// ── Per-player step ───────────────────────────────────────────────────────

export function aimDirection(p) {
  return dirFromAngles(p.look.yaw + p.recoil.yaw, clamp(p.look.pitch + p.recoil.pitch, -LOOK.pitchLimit, LOOK.pitchLimit));
}

function stepPlayer(world, state, p, input, dt) {
  // Aim comes from the client (mouse); recoil is added by the simulation.
  p.look.yaw = input.yaw;
  p.look.pitch = clamp(input.pitch, -LOOK.pitchLimit, LOOK.pitchLimit);

  const weapon = WEAPONS[p.weapon.id];
  // While the trigger is down the pattern owns the sights. Letting recovery
  // pull against it between shots would smear the path into mush and there
  // would be nothing to learn; the sights start falling once you stop firing.
  const settling = clamp(((p.sinceShot ?? 9) - 0.06) / 0.12, 0, 1);
  const recoverRate = weapon.recoilRecovery * dt * settling;
  p.recoil.pitch = approach(p.recoil.pitch, 0, Math.abs(p.recoil.pitch) * recoverRate + 0.0004);
  p.recoil.yaw = approach(p.recoil.yaw, 0, Math.abs(p.recoil.yaw) * recoverRate + 0.0002);

  if (!p.alive) {
    p.vel.x = p.vel.z = 0;
    return;
  }

  // Stance.
  p.crouching = input.crouch;
  p.stance = approach(p.stance, input.crouch ? 0 : 1, PLAYER.stanceSpeed * dt);

  // Lean, but only when there's room for your shoulder.
  const wantLean = clamp(input.lean, -1, 1);
  p.lean = approach(p.lean, wantLean, PLAYER.leanSpeed * dt);

  // Aim-down-sights blend.
  const wantAim = input.aim && p.weapon.reloading <= 0 ? 1 : 0;
  p.aimAmount = approach(p.aimAmount, wantAim, dt / weapon.aimTime);

  // ── Movement ──
  let speed;
  if (input.crouch) speed = PLAYER.speedCrouch;
  else if (input.sneak) speed = PLAYER.speedSneak;
  else if (input.run && !input.aim) speed = PLAYER.speedRun;
  else speed = PLAYER.speedWalk;
  if (p.aimAmount > 0.5) speed *= 0.7;

  const sin = Math.sin(p.look.yaw);
  const cos = Math.cos(p.look.yaw);
  // Forward is -Z at yaw 0.
  const wishX = -input.moveZ * sin + input.moveX * cos;
  const wishZ = -input.moveZ * cos - input.moveX * sin;
  const wishLen = Math.hypot(wishX, wishZ);
  const wish = wishLen > 1 ? { x: wishX / wishLen, z: wishZ / wishLen } : { x: wishX, z: wishZ };

  const targetVX = wish.x * speed;
  const targetVZ = wish.z * speed;
  const accel = PLAYER.accelGround * dt;
  p.vel.x = approach(p.vel.x, targetVX, Math.max(accel, PLAYER.friction * dt));
  p.vel.z = approach(p.vel.z, targetVZ, Math.max(accel, PLAYER.friction * dt));

  // Jumping. Only from the ground, never while crouched, and it costs you the
  // element of surprise on landing.
  p.jumpCooldown = Math.max(0, (p.jumpCooldown ?? 0) - dt);
  if (input.jump && p.grounded && !input.crouch && p.jumpCooldown <= 0) {
    p.vel.y = PLAYER.jumpSpeed;
    p.grounded = false;
    p.jumpCooldown = PLAYER.jumpCooldown;
    p.airborne = true;
    makeNoise(state, p.pos, NOISE.walk, 'jump', p.id);
  }

  p.vel.y -= GRAVITY * dt;

  const height = playerHeight(p);
  const before = { ...p.pos };
  p.pos = moveAndCollide(
    world, state, p.pos,
    { x: p.vel.x * dt, y: p.vel.y * dt, z: p.vel.z * dt },
    PLAYER.radius, height, PLAYER.stepHeight,
  );

  // Zero out velocity on axes we got stopped on, so we don't build up speed
  // pressed against a wall.
  if (Math.abs(p.pos.x - before.x) < Math.abs(p.vel.x * dt) * 0.5) p.vel.x *= 0.2;
  if (Math.abs(p.pos.z - before.z) < Math.abs(p.vel.z * dt) * 0.5) p.vel.z *= 0.2;

  const fallSpeed = p.vel.y;
  // Leaning must stop at the wall you are hiding behind, not pass through it.
  clampLeanToCover(world, state, p);

  p.grounded = groundedAt(world, p.pos, PLAYER.radius);
  if (p.grounded && p.vel.y < 0) p.vel.y = 0;

  // Landing thuds — the price of jumping around a corner.
  if (p.grounded && p.airborne) {
    p.airborne = false;
    if (fallSpeed < -2) {
      makeNoise(state, p.pos, NOISE.land, 'land', p.id);
      emit(state, { type: 'land', pos: { ...p.pos }, by: p.id, loud: NOISE.land });
    }
  }

  // ── Noise ──
  const movedSpeed = Math.hypot(p.pos.x - before.x, p.pos.z - before.z) / dt;
  if (movedSpeed > 0.25) {
    const stride = input.run ? 0.34 : input.sneak ? 0.75 : 0.5;
    p.lastNoise += dt;
    if (p.lastNoise >= stride) {
      p.lastNoise = 0;
      const loud = input.sneak ? NOISE.sneak : input.crouch ? NOISE.crouch : input.run ? NOISE.run : NOISE.walk;
      makeNoise(state, p.pos, loud, 'step', p.id);
      emit(state, { type: 'step', pos: { ...p.pos }, by: p.id, loud });
    }
  }

  // ── Flashlight ──
  if (input.toggleLight && p.useCooldown <= 0) {
    p.flashlight = !p.flashlight;
    p.useCooldown = 0.25;
  }

  // ── Doors ──
  p.useCooldown = Math.max(0, p.useCooldown - dt);
  p.kickCooldown = Math.max(0, p.kickCooldown - dt);

  if (input.use && p.useCooldown <= 0) {
    const found = doorInReach(world, state, p, 1.9);
    if (found) {
      // A kicked-in door has no latch left, so it can only be pushed further
      // open — you cannot shut it again to hide behind it.
      const wantOpen = found.state.forced ? 1 : found.state.target < 0.5 ? 1 : 0;
      const sneaky = input.sneak;
      pushDoor(
        world, state, p, wantOpen,
        sneaky ? DOOR.sneakSpeed : DOOR.openSpeed,
        sneaky ? DOOR.loudnessSneak : DOOR.loudnessOpen,
      );
      p.useCooldown = 0.35;
    }
  }

  if (input.kick && p.kickCooldown <= 0) {
    if (kickDoor(world, state, p)) p.kickCooldown = 0.9;
  }

  // ── Weapon ──
  stepWeapon(world, state, p, input, dt);
}

function stepWeapon(world, state, p, input, dt) {
  const w = p.weapon;
  const def = WEAPONS[w.id];

  w.cooldown = Math.max(0, w.cooldown - dt);

  // Let go of the trigger for a moment and the muzzle climb starts over.
  p.sinceShot = (p.sinceShot ?? 0) + dt;
  if (p.sinceShot > def.burstResetTime) p.burstShots = 0;

  if (w.reloading > 0) {
    w.reloading -= dt;
    if (w.reloading <= 0) {
      // Hardcore: the partial magazine is dropped, not merged.
      if (w.mags > 0) {
        w.mags--;
        w.ammo = def.magSize;
      }
      w.reloading = 0;
      emit(state, { type: 'reloadDone', by: p.id });
    }
    return;
  }

  if (input.reload && w.ammo < def.magSize && w.mags > 0) {
    w.reloadTotal = w.ammo > 0 ? def.reloadTime : def.reloadTimeEmpty;
    w.reloading = w.reloadTotal;
    makeNoise(state, p.pos, NOISE.reload, 'reload', p.id);
    emit(state, { type: 'reload', by: p.id, empty: w.ammo === 0 });
    return;
  }

  if (!input.fire || w.cooldown > 0) return;

  if (w.ammo <= 0) {
    if (input.fire) emit(state, { type: 'dryFire', by: p.id });
    w.cooldown = 0.25;
    return;
  }

  w.ammo--;
  w.cooldown = 60 / def.rpm;
  p.sinceShot = 0;

  const eye = eyePosition(p);
  const moving = Math.hypot(p.vel.x, p.vel.z) > 1.2;
  let spread = def.spreadHip * (1 - p.aimAmount) + def.spreadAim * p.aimAmount;
  if (moving) spread += def.spreadMoving * (1 - p.aimAmount * 0.7);
  if (p.crouching) spread *= 0.7;

  const base = aimDirection(p);
  // Random point in the cone.
  const a = nextRandom(state) * Math.PI * 2;
  const r = Math.sqrt(nextRandom(state)) * spread;
  const dir = coneDirection(base, a, r);

  fireBullet(world, state, p, eye, dir);
  checkLightHits(world, state, eye, dir, p);

  // Recoil walks the weapon's spray pattern. The count is per burst, not per
  // magazine: what matters is how long you have been holding the trigger.
  // Aiming down the sights and crouching brace the weapon, tightening the
  // whole path without changing its shape.
  p.burstShots = (p.burstShots ?? 0) + 1;
  const shot = p.burstShots - 1;
  let brace = 1 - p.aimAmount * 0.25;
  if (p.crouching) brace *= 0.85;

  const climb = def.recoilClimb;
  let stepYaw;
  let stepPitch;
  if (shot < climb.length) {
    [stepYaw, stepPitch] = climb[shot];
  } else {
    // Past the path: the muzzle has nowhere left to climb and only sways.
    const settle = def.recoilSettle;
    stepPitch = settle.pitch;
    stepYaw = Math.sin((shot - climb.length) * settle.sway) * settle.yaw;
  }

  // Just enough life that two sprays are never pixel-identical, not enough to
  // hide the pattern from someone who has learned it.
  p.recoil.pitch += stepPitch * brace * (0.92 + nextRandom(state) * 0.16);
  p.recoil.yaw += stepYaw * brace * (0.92 + nextRandom(state) * 0.16)
    + (nextRandom(state) - 0.5) * 0.0016;

  emit(state, { type: 'shot', by: p.id, pos: eye, dir, weapon: w.id });
  makeNoise(state, p.pos, def.loudness, 'shot', p.id);
}

// Rotate `base` off-axis by angle `r` in a random roll direction `a`.
function coneDirection(base, a, r) {
  // Build any two axes perpendicular to base.
  const up = Math.abs(base.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const rx = base.y * up.z - base.z * up.y;
  const ry = base.z * up.x - base.x * up.z;
  const rz = base.x * up.y - base.y * up.x;
  const rl = Math.hypot(rx, ry, rz) || 1;
  const right = { x: rx / rl, y: ry / rl, z: rz / rl };
  const u = {
    x: right.y * base.z - right.z * base.y,
    y: right.z * base.x - right.x * base.z,
    z: right.x * base.y - right.y * base.x,
  };
  const sr = Math.sin(r);
  const cr = Math.cos(r);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const d = {
    x: base.x * cr + (right.x * ca + u.x * sa) * sr,
    y: base.y * cr + (right.y * ca + u.y * sa) * sr,
    z: base.z * cr + (right.z * ca + u.z * sa) * sr,
  };
  const l = Math.hypot(d.x, d.y, d.z) || 1;
  return { x: d.x / l, y: d.y / l, z: d.z / l };
}

// ── Doors tick ────────────────────────────────────────────────────────────

function stepDoors(world, state, dt) {
  for (const door of world.doors) {
    const ds = state.doors[door.id];
    if (ds.open !== ds.target) {
      const before = ds.open;
      // `open` is a fraction, `speed` is radians per second — convert using
      // this door's own swing, so every door moves at the same real rate.
      const sweep = door.maxAngle || DOOR.openAngle;
      ds.open = approach(ds.open, ds.target, (ds.speed / sweep) * dt);
      if (before !== ds.open && ds.open === ds.target && ds.speed >= DOOR.kickSpeed) {
        emit(state, { type: 'doorSlam', doorId: door.id });
      }
    }
  }
}

// ── Round flow ────────────────────────────────────────────────────────────

function stepRound(state, dt) {
  state.phaseTime -= dt;
  if (state.phase === 'prep' && state.phaseTime <= 0) {
    state.phase = 'live';
    state.phaseTime = ROUND.duration;
    emit(state, { type: 'roundStart' });
    return;
  }
  if (state.phase !== 'live') return;

  const alive = { attackers: 0, defenders: 0 };
  for (const p of Object.values(state.players)) {
    if (p.alive) alive[p.team]++;
  }
  const teams = Object.values(state.players).reduce((acc, p) => {
    acc[p.team] = (acc[p.team] || 0) + 1;
    return acc;
  }, {});

  let winner = null;
  if (teams.attackers && alive.attackers === 0) winner = 'defenders';
  else if (teams.defenders && alive.defenders === 0) winner = 'attackers';
  else if (state.phaseTime <= 0) winner = 'defenders'; // time out favours the holders

  if (winner) {
    state.phase = 'over';
    state.phaseTime = 6;
    emit(state, { type: 'roundEnd', winner });
  }
}

// ── Entry point ───────────────────────────────────────────────────────────

export function stepSim(world, state, inputs, dt = DT) {
  state.events = [];
  state.tick++;
  state.time += dt;

  for (const p of Object.values(state.players)) {
    const input = inputs[p.id];
    if (input) stepPlayer(world, state, p, input, dt);
    else stepPlayer(world, state, p, createInput(), dt);
  }

  stepDoors(world, state, dt);
  stepRound(state, dt);

  return state;
}

// Restart everyone for a new round.
export function resetRound(world, state) {
  const counts = { attackers: 0, defenders: 0 };
  for (const p of Object.values(state.players)) {
    const spawns = world.map.spawns[p.team];
    const spawn = spawns[counts[p.team]++ % spawns.length];
    p.pos = { x: spawn.x, y: spawn.y ?? 0, z: spawn.z };
    p.vel = { x: 0, y: 0, z: 0 };
    p.look = { yaw: spawn.yaw ?? 0, pitch: 0 };
    p.recoil = { yaw: 0, pitch: 0 };
    // A new round starts a new spray: without this the first shot of the round
    // would carry on from wherever the last burst of the previous one ended.
    p.burstShots = 0;
    p.sinceShot = 99;
    p.health = PLAYER.maxHealth;
    p.alive = true;
    p.stance = 1;
    p.lean = 0;
    p.flashlight = false;
    const def = WEAPONS[p.weapon.id];
    p.weapon.ammo = def.magSize;
    p.weapon.mags = def.reserveMags;
    p.weapon.reloading = 0;
    p.weapon.cooldown = 0;
  }
  for (const d of world.doors) {
    const ds = state.doors[d.id];
    ds.open = 0;
    ds.target = 0;
    ds.speed = DOOR.openSpeed;
    ds.health = d.maxHealth;
    ds.forced = false;
    ds.broken = false;
    ds.locked = d.lockedByDefault;
  }
  for (const id of Object.keys(state.lights)) state.lights[id].broken = false;
  state.phase = 'prep';
  state.phaseTime = ROUND.prepTime;
  state.events = [];
}

// What is this player looking at within arm's reach? Drives the HUD prompt.
export function lookTarget(world, state, p, range = 1.9) {
  const found = doorInReach(world, state, p, range);
  if (!found) return null;
  return {
    kind: 'door',
    id: found.door.id,
    locked: found.state.locked,
    forced: found.state.forced,
    open: found.state.open,
    target: found.state.target,
    health: found.state.health,
    maxHealth: found.door.maxHealth,
    reinforced: found.door.reinforced,
    distance: found.t,
  };
}

// Hearing: what noises reach this player. Walls muffle but don't block sound.
export function audibleNoises(state, listener) {
  const out = [];
  for (const ev of state.events) {
    if (ev.type !== 'noise' || ev.by === listener.id) continue;
    const d = distXZ(ev.pos, listener.pos);
    if (d > ev.radius) continue;
    out.push({ ...ev, distance: d, strength: 1 - d / ev.radius });
  }
  return out;
}
