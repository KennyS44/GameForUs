// The authoritative simulation.
//
// Contract: inputs in, world state out, nothing else. No Three.js, no DOM, no
// Math.random, no Date.now. Today this runs inside the host's browser tab; to
// go online it runs unchanged inside a Node process and only the transport
// around it changes.

import {
  PLAYER, LOOK, DAMAGE, WEAPONS, DOOR, FLASHLIGHT, NOISE, ROUND, DT,
} from './constants.js';
import {
  clamp, approach, dirFromAngles, distXZ, makeRng, rayBox,
} from './math.js';
import {
  moveAndCollide, groundedAt, raycastGeometry, doorFrame, worldToLocal, dirToLocal,
} from './world.js';

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
    pos: { x: spawn.x, y: 0, z: spawn.z },
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

export function eyePosition(p) {
  const h = playerHeight(p);
  return { x: p.pos.x, y: p.pos.y + h - PLAYER.eyeOffset, z: p.pos.z };
}

function hitboxes(p) {
  const h = playerHeight(p);
  const { x, z } = p.pos;
  const y = p.pos.y;
  return [
    {
      zone: 'head',
      min: { x: x - 0.12, y: y + h - 0.26, z: z - 0.12 },
      max: { x: x + 0.12, y: y + h, z: z + 0.12 },
    },
    {
      zone: 'torso',
      min: { x: x - 0.22, y: y + h * 0.45, z: z - 0.19 },
      max: { x: x + 0.22, y: y + h - 0.26, z: z + 0.19 },
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
  if (!ds || ds.forced) return;
  ds.health -= amount;
  if (ds.health <= 0) {
    ds.forced = true;
    ds.locked = false;
    ds.target = 1;
    ds.speed = DOOR.kickSpeed;
    emit(state, { type: 'doorBreak', doorId, by: by?.id });
    const d = world.doors.find((x) => x.id === doorId);
    if (d) makeNoise(state, { x: d.pos.x, y: 1, z: d.pos.z }, DOOR.loudnessKick, 'doorBreak', by?.id);
  }
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
  makeNoise(state, { x: found.door.pos.x, y: 1, z: found.door.pos.z }, loudness, 'door', p.id);
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
  makeNoise(state, { x: found.door.pos.x, y: 1, z: found.door.pos.z }, DOOR.loudnessKick, 'kick', p.id);

  ds.health = Math.max(0, ds.health - DOOR.kickDamage);
  ds.locked = false;
  ds.forced = true;
  ds.target = 1;
  ds.speed = DOOR.kickSpeed;
  emit(state, { type: 'doorBreak', doorId: found.door.id, by: p.id });
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
  const recoverRate = weapon.recoilRecovery * dt;
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

  // Recoil kicks the aim up and wanders sideways.
  p.recoil.pitch += def.recoilVertical * (0.7 + nextRandom(state) * 0.6);
  p.recoil.yaw += (nextRandom(state) - 0.5) * 2 * def.recoilHorizontal;

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
      ds.open = approach(ds.open, ds.target, (ds.speed / (Math.PI / 2)) * dt);
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
    p.pos = { x: spawn.x, y: 0, z: spawn.z };
    p.vel = { x: 0, y: 0, z: 0 };
    p.look = { yaw: spawn.yaw ?? 0, pitch: 0 };
    p.recoil = { yaw: 0, pitch: 0 };
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
