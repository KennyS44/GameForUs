// The authoritative simulation.
//
// Contract: inputs in, world state out, nothing else. No Three.js, no DOM, no
// Math.random, no Date.now. Today this runs inside the host's browser tab; to
// go online it runs unchanged inside a Node process and only the transport
// around it changes.

import {
  PLAYER, LOOK, DAMAGE, WEAPONS, DEFAULT_WEAPON, DOOR, FLASHLIGHT, NOISE, ROUND, DT,
} from './constants.js?v=d547eb56';
import {
  clamp, approach, dirFromAngles, distXZ, makeRng, rayBox,
} from './math.js?v=d547eb56';
import {
  moveAndCollide, groundedAt, raycastGeometry, doorFrame, worldToLocal, dirToLocal,
} from './world.js?v=d547eb56';

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
  const w = WEAPONS[DEFAULT_WEAPON];
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
    // What they picked at the loadout screen. `weapon` is this round's gun and
    // is rebuilt every round; `loadout` is the choice and outlives it.
    loadout: DEFAULT_WEAPON,
    weapon: {
      id: DEFAULT_WEAPON,
      ammo: w.magSize,
      // Reserve is counted in rounds, not magazines: a shotgun is fed shell by
      // shell, so magazines are not a unit every weapon here even has.
      reserve: w.reserve,
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
      open: d.startsForced ? 1 : 0,
      target: d.startsForced ? 1 : 0,
      speed: DOOR.openSpeed,
      health: d.maxHealth,
      // `forced` means the latch is destroyed: the door swings free and can no
      // longer be shut. The panel itself stays on its hinges and still stops
      // bullets — a kicked door is cover you can no longer close.
      forced: !!d.startsForced,
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
    phase: ROUND.selectTime > 0 ? 'select' : 'prep',
    phaseTime: ROUND.selectTime > 0 ? ROUND.selectTime : ROUND.prepTime,
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

// Picking a weapon. The only way one ever changes hands, so the host can trust
// a client's request by passing it straight through here: an unknown id or a
// request made after the shooting starts is simply refused.
export function setLoadout(state, id, weaponId) {
  const p = state.players[id];
  const def = WEAPONS[weaponId];
  if (!p || !def) return false;
  if (state.phase !== 'select' && state.phase !== 'prep') return false;

  p.loadout = weaponId;
  p.weapon = {
    id: weaponId,
    ammo: def.magSize,
    reserve: def.reserve,
    cooldown: 0,
    reloading: 0,
    reloadTotal: 0,
  };
  // A swapped weapon is a fresh weapon: the old gun's spray does not carry
  // over, and neither does a finger left on the trigger of the last one.
  p.triggerDown = false;
  p.burstShots = 0;
  p.sinceShot = 99;
  p.recoil = { yaw: 0, pitch: 0 };
  return true;
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
      applyDamage(state, shooter, best.player, best.zone, damageScale, start + best.t);
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
      // A hole in a door has to travel with the door, so say which one.
      doorId: firstGeo.kind === 'door' ? firstGeo.doorId : undefined,
    });

    // Can the round punch through?
    const thicknessCm = Math.max(1, (firstGeo.exit - firstGeo.t) * 100);
    const mat = firstGeo.material;
    if (mat.penetration <= 0 || thicknessCm > penetrationLeft) {
      if (firstGeo.kind === 'door') damageDoor(world, state, firstGeo.doorId, weapon.doorDamage, shooter);
      return; // stopped
    }
    if (firstGeo.kind === 'door') damageDoor(world, state, firstGeo.doorId, weapon.doorDamage, shooter);

    penetrationLeft -= thicknessCm;
    damageScale *= Math.max(0.25, 1 - (thicknessCm * DAMAGE.penetrationLossPerCm) / 100);
    start += firstGeo.exit + 0.02;
    if (start >= MAX_RANGE) return;
  }
}

function addScaled(o, d, s) {
  return { x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s };
}

// How much of its damage a round still has at this distance. Straight from
// Rainbow Six Siege's published model: full damage out to `near`, a straight
// line down to `far`, then a floor it never drops below.
export function rangeScale(def, metres) {
  const { near, far, floor } = def.range;
  if (metres <= near) return 1;
  if (metres >= far) return floor;
  return 1 - (1 - floor) * ((metres - near) / (far - near));
}

function applyDamage(state, shooter, target, zone, scale, distance) {
  // Nobody dies before the round starts. Rounds are one life each, so being
  // shot while choosing a weapon or taking position is not a fair way to lose it.
  if (state.phase === 'select' || state.phase === 'prep') return;

  const def = WEAPONS[shooter.weapon.id];
  const head = def.pellets > 1 ? DAMAGE.pelletHead : DAMAGE.head;
  const zoneScale = zone === 'head' ? head : zone === 'limb' ? DAMAGE.limb : 1;
  let dmg = def.damage * zoneScale * rangeScale(def, distance) * scale;
  if (zone === 'torso' && target.armour) {
    // A vest soaks a fixed amount per hit, so a shot split into eight pellets
    // must not be charged eight times over — each pellet meets its share of
    // the plate. Armour-piercing rounds go through nearly all of it.
    const soak = (DAMAGE.armourReduction / def.pellets) * def.armourPierce;
    dmg = Math.max(dmg * 0.15, dmg - soak);
  }

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
    ds.open = d.startsForced ? 1 : 0;
    ds.target = d.startsForced ? 1 : 0;
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
  const startedAt = { x: p.pos.x, z: p.pos.z };

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
  p.sneaking = !!input.sneak;
  let speed;
  if (input.crouch) speed = PLAYER.speedCrouch;
  else if (input.sneak) speed = PLAYER.speedSneak;
  else if (input.run && !input.aim) speed = PLAYER.speedRun;
  else speed = PLAYER.speedWalk;
  if (p.aimAmount > 0.5) speed *= 0.7;
  // What you carry is what you walk at. A sawn-off weighs nothing and a .50
  // anti-materiel rifle is a fifth of your speed — that, not damage, is what
  // makes the big gun a decision.
  speed *= weapon.moveScale;

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

  // ── Staging phase ──
  holdInZone(world, state, p, startedAt);

  // ── Weapon ──
  stepWeapon(world, state, p, input, dt);
}

// During the staging minute the two sides are not free to go anywhere: the
// attackers wait at the door while the defenders take the flat, and the rooms
// the defenders would have to cross the attackers to reach are closed to them.
//
// The rule is enforced by refusing the step rather than by shoving anyone
// back: a player who tries to cross the line simply does not move, which reads
// as an invisible wall and cannot wedge someone between two closed rooms the
// way pushing them out of one and into the next would.
function holdInZone(world, state, p, wasAt) {
  const rules = world.map.prep;
  const staging = state.phase === 'select' || state.phase === 'prep';
  if (!staging || !rules) {
    p.zoneFrom = null;
    return;
  }
  const rooms = world.map.rooms ?? [];
  const m = PLAYER.radius + 0.05;
  const inRoom = (r, pos) =>
    pos.x > r.min.x - m && pos.x < r.max.x + m && pos.z > r.min.z - m && pos.z < r.max.z + m;
  const byId = (id) => rooms.find((r) => r.id === id);

  let allowed = true;
  if (p.team === 'attackers' && rules.attackersHeld?.length) {
    const zones = rules.attackersHeld.map(byId).filter(Boolean);
    allowed = zones.some((r) =>
      p.pos.x > r.min.x + m && p.pos.x < r.max.x - m &&
      p.pos.z > r.min.z + m && p.pos.z < r.max.z - m);
  } else if (p.team === 'defenders' && rules.defendersBarred?.length) {
    allowed = !rules.defendersBarred.map(byId).filter(Boolean).some((r) => inRoom(r, p.pos));
  }

  if (allowed) {
    p.zoneFrom = { ...p.pos };
    return;
  }
  // Not allowed here: stay where the last legal step left us.
  const back = p.zoneFrom ?? wasAt;
  p.pos.x = back.x;
  p.pos.z = back.z;
  p.vel.x = 0;
  p.vel.z = 0;
}

// Start a reload — a whole magazine, or the next shell into the tube.
function startReload(state, p, def) {
  const w = p.weapon;
  w.reloadTotal = w.ammo > 0 ? def.reloadTime : def.reloadTimeEmpty;
  w.reloading = w.reloadTotal;
  makeNoise(state, p.pos, NOISE.reload, 'reload', p.id);
  emit(state, { type: 'reload', by: p.id, empty: w.ammo === 0, shell: def.reloadStyle === 'shell' });
}

function stepWeapon(world, state, p, input, dt) {
  const w = p.weapon;
  const def = WEAPONS[w.id];

  // Carry the remainder rather than clamping it away: an interval of 55 ms on
  // a 17 ms tick would otherwise round up to 67 ms and quietly cost a 1100
  // rounds-a-minute weapon a fifth of its rate.
  w.cooldown = Math.max(-0.034, w.cooldown - dt);

  // Let go of the trigger for a moment and the muzzle climb starts over.
  p.sinceShot = (p.sinceShot ?? 0) + dt;
  if (p.sinceShot > def.burstResetTime) p.burstShots = 0;

  // A self-loader fires once per pull. Held down, the trigger does nothing
  // after the first round: this is what separates the pump gun and the .50
  // from the automatics, and it has to be decided here rather than by how fast
  // the player can click.
  const pulled = input.fire && !p.triggerDown;
  p.triggerDown = !!input.fire;
  const wantsShot = def.fireMode === 'semi' ? pulled : !!input.fire;

  if (w.reloading > 0) {
    // Shells go in one at a time, and a shotgun can be fired mid-reload: what
    // is already in the tube stays there. Every other gun is committed.
    if (def.reloadStyle === 'shell' && wantsShot && w.ammo > 0) {
      w.reloading = 0;
      w.cooldown = Math.max(w.cooldown, 0.25); // still has to close the action
      // The pull that cancelled the reload is the pull that fires: hold the
      // trigger through it and the shot goes as soon as the action is closed,
      // instead of asking for a second press.
      p.triggerDown = false;
      return;
    }
    w.reloading -= dt;
    if (w.reloading <= 0) {
      if (def.reloadStyle === 'shell') {
        w.ammo++;
        w.reserve--;
        emit(state, { type: 'reloadDone', by: p.id });
        // Keep feeding until the tube is full or the pockets are empty.
        if (w.ammo < def.magSize && w.reserve > 0) startReload(state, p, def);
      } else {
        // Hardcore: the partial magazine is dropped, not merged. What was left
        // in it goes with it, so the cost of an early reload is a full mag.
        const take = Math.min(def.magSize, w.reserve);
        w.reserve -= take;
        w.ammo = take;
        w.reloading = 0;
        emit(state, { type: 'reloadDone', by: p.id });
      }
    }
    return;
  }

  if (input.reload && w.ammo < def.magSize && w.reserve > 0) {
    startReload(state, p, def);
    return;
  }

  if (!wantsShot || w.cooldown > 0) return;

  if (w.ammo <= 0) {
    if (input.fire) emit(state, { type: 'dryFire', by: p.id });
    w.cooldown = 0.25;
    return;
  }

  w.ammo--;
  w.cooldown += 60 / def.rpm;
  p.sinceShot = 0;

  const eye = eyePosition(p);
  const moving = Math.hypot(p.vel.x, p.vel.z) > 1.2;
  let spread = def.spreadHip * (1 - p.aimAmount) + def.spreadAim * p.aimAmount;
  if (moving) spread += def.spreadMoving * (1 - p.aimAmount * 0.7);
  if (p.crouching) spread *= 0.7;

  const base = aimDirection(p);
  // Buckshot is the same shot fired several times over: every pellet gets its
  // own point in the cone, its own path through the walls and its own damage.
  // That is what makes a shotgun lethal at the door and useless down a
  // corridor without a single special case in the damage code.
  let dir = base;
  for (let pellet = 0; pellet < def.pellets; pellet++) {
    const a = nextRandom(state) * Math.PI * 2;
    const r = Math.sqrt(nextRandom(state)) * spread;
    dir = coneDirection(base, a, r);
    fireBullet(world, state, p, eye, dir);
    checkLightHits(world, state, eye, dir, p);
  }

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
    // Past the path: a slower climb, a wider sway, and a tremble on top.
    const settle = def.recoilSettle;
    const shake = settle.shake ?? 0;
    stepPitch = settle.pitch + (nextRandom(state) - 0.5) * shake;
    stepYaw = Math.sin((shot - climb.length) * settle.sway) * settle.yaw
      + (nextRandom(state) - 0.5) * 2 * shake;
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
  if (state.phase === 'select' && state.phaseTime <= 0) {
    state.phase = 'prep';
    state.phaseTime = ROUND.prepTime;
    emit(state, { type: 'prepStart' });
    return;
  }
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

  // At the loadout screen everyone stands still. Only the head turns: looking
  // around the room you spawned in costs nobody anything, walking out of it
  // would. Held here rather than inside stepPlayer so there is one place to
  // read, and so a client predicting itself freezes on exactly the same tick.
  const frozen = state.phase === 'select';

  for (const p of Object.values(state.players)) {
    let input = inputs[p.id] ?? createInput();
    if (frozen) input = { ...createInput(), yaw: input.yaw, pitch: input.pitch };
    stepPlayer(world, state, p, input, dt);
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
    // Rearm from the choice, not from what happened to be in their hands: the
    // pick survives the round, the gun does not.
    const weaponId = WEAPONS[p.loadout] ? p.loadout : DEFAULT_WEAPON;
    const def = WEAPONS[weaponId];
    p.loadout = weaponId;
    p.weapon.id = weaponId;
    p.weapon.ammo = def.magSize;
    p.weapon.reserve = def.reserve;
    p.weapon.reloading = 0;
    p.weapon.cooldown = 0;
    p.triggerDown = false;
  }
  for (const d of world.doors) {
    const ds = state.doors[d.id];
    ds.open = d.startsForced ? 1 : 0;
    ds.target = d.startsForced ? 1 : 0;
    ds.speed = DOOR.openSpeed;
    ds.health = d.maxHealth;
    ds.forced = !!d.startsForced;
    ds.broken = false;
    ds.locked = d.lockedByDefault;
  }
  for (const id of Object.keys(state.lights)) state.lights[id].broken = false;
  state.phase = ROUND.selectTime > 0 ? 'select' : 'prep';
  state.phaseTime = ROUND.selectTime > 0 ? ROUND.selectTime : ROUND.prepTime;
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
