// The authoritative simulation.
//
// Contract: inputs in, world state out, nothing else. No Three.js, no DOM, no
// Math.random, no Date.now. Today this runs inside the host's browser tab; to
// go online it runs unchanged inside a Node process and only the transport
// around it changes.

import {
  PLAYER, LOOK, DAMAGE, WEAPONS, DEFAULT_WEAPON, DOOR, FLASHLIGHT, NOISE, ROUND, DT,
  GADGETS, DEFAULT_GADGET, BLIND, NVG, FLARE, POWER,
} from './constants.js?v=0e7e12c6';
import {
  clamp, approach, dirFromAngles, distXZ, makeRng, rayBox,
} from './math.js?v=0e7e12c6';
import {
  moveAndCollide, groundedAt, raycastGeometry, doorFrame, worldToLocal, dirToLocal,
  hasLineOfSight, trapWireBox,
} from './world.js?v=0e7e12c6';

const GRAVITY = 18;

export function createInput() {
  return {
    moveX: 0, moveZ: 0,
    yaw: 0, pitch: 0,
    run: false, sneak: false, crouch: false, jump: false,
    lean: 0,
    fire: false, aim: false, reload: false,
    use: false, kick: false, toggleLight: false, gadget: false,
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
    // What they carry besides the gun. Each side has its own list, so the
    // default depends on which door you came in through.
    gadget: DEFAULT_GADGET[team],
    gadgetLeft: GADGETS[DEFAULT_GADGET[team]].count,
    gadgetCooldown: 0,
    // Night vision: only if it was the device they picked, and only while
    // they have it down over their eyes. A torch and a tube are never worn at
    // the same time.
    nvg: false,
    // 0 is seeing normally, 1 is a white screen. Only a flash sets it.
    blind: 0,
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
      // The defenders' fitting on this door: a wedge holding it, a tripwire or
      // an alarm waiting for it to move.
      device: null,
      // The attackers' charge, counting down. It gets a slot of its own for
      // the obvious reason: a doorway is wedged precisely so that nobody comes
      // through it, and the answer to that is to tape a charge over the wedge.
      charge: null,
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
    // The mains, as one switch for the whole building. Every lamp reads it,
    // so throwing the breaker on the terrace is felt in every room at once.
    power: true,
    // Things in the air, and clouds that have already landed. A burning flare
    // lives here too: it is thrown like a grenade and simply never goes off.
    throwables: [],
    smokes: [],
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

// What is under this player's boots. A short ray down from the ankles: the
// answer is a material name, and it costs one raycast per footfall, which is
// twice a second at a run.
function surfaceUnder(world, state, p) {
  const from = { x: p.pos.x, y: p.pos.y + 0.12, z: p.pos.z };
  const hit = raycastGeometry(world, state, from, { x: 0, y: -1, z: 0 }, 0.4)[0];
  return hit ? hit.material.name : 'floor';
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
  // A budget of points, spent against each surface's `resist`. Two for
  // buckshot, thirteen for a rifle, sixty for the .50.
  let penetrationLeft = weapon.penetration;
  // How many solid surfaces this round is allowed to cross. Centimetres alone
  // would let the .50 walk the length of the flat through six partitions; a
  // rifle that goes through one wall is a threat, one that goes through every
  // wall is a room nobody can hold.
  let wallsLeft = weapon.maxWalls ?? Infinity;
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

    // Nearest tripwire along the same stretch of ray. A wire is a target like
    // any other: hit it and the grenade behind it goes off there and then,
    // which is how an attacker clears a wired doorway without standing in it.
    const wire = nearestWire(world, state, addScaled(origin, dir, start), dir);
    if (wire && (!best || wire.t < best.t) && (!firstGeo || wire.t < firstGeo.t)) {
      const at = addScaled(origin, dir, start + wire.t);
      emit(state, { type: 'impact', pos: at, normal: { x: 0, y: 1, z: 0 }, material: 'metal' });
      detonateTrap(world, state, wire.door, shooter.id);
      return;
    }

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
    //
    // Two separate questions, and they used to be one. What it costs to get
    // through a surface is `resist` — points of a weapon's penetration per
    // centimetre — and what it takes out of the round on the way is `soak`.
    // A door is the case that needs them apart: everything on the roster goes
    // through one, and everything that does arrives weaker for it.
    const thicknessCm = Math.max(1, (firstGeo.exit - firstGeo.t) * 100);
    const mat = firstGeo.material;
    const cost = mat.resist > 0 ? thicknessCm * mat.resist : Infinity;
    // Glass is not a wall you punched through, it is a window that broke, so
    // it never counts against the allowance.
    const solid = !mat.seeThrough;
    if (cost > penetrationLeft || (solid && wallsLeft <= 0)) {
      if (firstGeo.kind === 'door') damageDoor(world, state, firstGeo.doorId, weapon.doorDamage, shooter);
      return; // stopped
    }
    if (firstGeo.kind === 'door') damageDoor(world, state, firstGeo.doorId, weapon.doorDamage, shooter);

    penetrationLeft -= cost;
    if (solid) wallsLeft--;
    const loss = thicknessCm * (mat.soak ?? DAMAGE.penetrationLossPerCm);
    damageScale *= Math.max(0.25, 1 - loss / 100);
    start += firstGeo.exit + 0.02;
    if (start >= MAX_RANGE) return;
  }
}

function addScaled(o, d, s) {
  return { x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s };
}

// The closest tripwire this ray runs into. Traced in each door's own frame,
// like the panel itself, so a wire swings with the door it is strung on.
function nearestWire(world, state, from, dir) {
  let best = null;
  for (const door of world.doors) {
    const ds = state.doors[door.id];
    if (ds.broken || ds.device?.kind !== 'trap') continue;
    const frame = doorFrame(door, ds.open);
    const r = rayBox(
      worldToLocal(frame, from),
      dirToLocal(frame, dir),
      trapWireBox(door, ds.device.side ?? 1),
    );
    if (!r.hit || r.tNear < 0) continue;
    if (!best || r.tNear < best.t) best = { t: r.tNear, door };
  }
  return best;
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

// What one projectile takes off, before it is subtracted from anyone.
//
// Pure and exported so the roster can be checked entry by entry: the promise
// that no weapon kills in a single hit is only worth as much as the test that
// proves it, and the test needs to ask this question directly rather than by
// shooting a bot in the dark and hoping the right hitbox was in the way.
//
//   zone      'head' | 'torso' | 'limb'
//   distance  metres travelled, for falloff
//   armour    is the target wearing a vest
//   cover     what the round has left after punching through walls, 1 = clean
export function hitDamage(def, zone, distance, { armour = true, cover = 1 } = {}) {
  const head = def.pellets > 1 ? DAMAGE.pelletHead : DAMAGE.head;
  const zoneScale = zone === 'head' ? head : zone === 'limb' ? DAMAGE.limb : 1;
  let dmg = def.damage * zoneScale * rangeScale(def, distance) * cover;

  if (zone === 'torso' && armour) {
    // A vest soaks a fixed amount per hit, so a shot split into eight pellets
    // must not be charged eight times over — each pellet meets its share of
    // the plate. Armour-piercing rounds go through nearly all of it.
    const soak = (DAMAGE.armourReduction / def.pellets) * def.armourPierce;
    dmg = Math.max(dmg * 0.15, dmg - soak);
  }

  // The ceiling. A .50 on a clean line is the one round in the game allowed
  // through it — that is the whole point of carrying something that slow and
  // that heavy. Shoot the same round through a wall and it comes out the far
  // side as just another very hard hit: the shot that kills outright has to be
  // one you actually had the angle for.
  const uncapped = def.oneShot && cover >= 1;
  return uncapped ? dmg : Math.min(dmg, DAMAGE.maxPerHit);
}

function applyDamage(state, shooter, target, zone, scale, distance) {
  // Nobody dies before the round starts. Rounds are one life each, so being
  // shot while choosing a weapon or taking position is not a fair way to lose it.
  if (state.phase === 'select' || state.phase === 'prep') return;

  const def = WEAPONS[shooter.weapon.id];
  const dmg = hitDamage(def, zone, distance, { armour: target.armour, cover: scale });

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
  // A wedge holds the handle, and rattling it is not quiet: the defender who
  // fitted it hears exactly which door someone just tried.
  if (ds.device?.kind === 'wedge') {
    emit(state, { type: 'doorWedged', doorId: found.door.id, by: p.id });
    makeNoise(state, doorNoisePos(found.door), DOOR.loudnessOpen * 2, 'wedge', p.id);
    return true;
  }
  triggerDoorDevice(world, state, found.door, p);
  ds.target = target;
  ds.speed = speed;
  makeNoise(state, doorNoisePos(found.door), loudness, 'door', p.id);
  emit(state, { type: 'doorMove', doorId: found.door.id, target });
  return true;
}

function doorNoisePos(door) {
  return { x: door.pos.x, y: (door.pos.y ?? 0) + 1, z: door.pos.z };
}

// One kick takes any door, locked or not. It flies open on its hinges — loudly,
// which is the real cost of doing it.
function kickDoor(world, state, p) {
  const found = doorInReach(world, state, p, DOOR.kickRange);
  if (!found) return false;
  const ds = found.state;

  emit(state, { type: 'doorKick', doorId: found.door.id, by: p.id });
  makeNoise(state, doorNoisePos(found.door), DOOR.loudnessKick, 'kick', p.id);

  // A boot finds whatever the defenders left on the door. A wedge eats the
  // kick whole — that is the trade it makes: the door survives this one, and
  // the man in the doorway has to wind up and do it again, loudly, twice.
  if (ds.device?.kind === 'wedge') {
    ds.device = null;
    emit(state, { type: 'deviceBroken', doorId: found.door.id, kind: 'wedge' });
    return true;
  }
  triggerDoorDevice(world, state, found.door, p);

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

// ── Equipment ─────────────────────────────────────────────────────────────
//
// Two ways to deliver a device and one place that decides which: a grenade is
// lobbed and left to bounce, everything else is fitted to the door you are
// looking at. Both spend the same allowance, so a player is always choosing
// between a doorway they can shape and one they can only rush.

// Picking a device, on the same terms as picking a gun: only during staging,
// only something your own side carries.
export function setGadget(state, id, gadgetId) {
  const p = state.players[id];
  const def = GADGETS[gadgetId];
  if (!p || !def || def.team !== p.team) return false;
  if (state.phase !== 'select' && state.phase !== 'prep') return false;

  p.gadget = gadgetId;
  p.gadgetLeft = def.count;
  return true;
}

// Which face of the panel the man fitting a wire is standing on.
function wireSide(found, p) {
  const frame = doorFrame(found.door, found.state.open);
  return worldToLocal(frame, eyePosition(p)).z < 0 ? -1 : 1;
}

const THROW_SPEED = 11;
const THROW_LIFT = 2.2; // underarm, so it arcs rather than flying flat
const BOUNCE = 0.36;
const THROW_RADIUS = 0.09;

function useGadget(world, state, p) {
  const def = GADGETS[p.gadget];
  if (!def || p.gadgetLeft <= 0 || p.gadgetCooldown > 0) return false;

  // Worn, not spent: the tube goes up and down as often as you like, and it
  // sits in the same slot everything else does, so wearing it is what you
  // gave your flashbangs up for.
  if (def.kind === 'toggle') {
    p.nvg = !p.nvg;
    // A torch and a tube are never worn together: one of them exists to make
    // the other pointless.
    if (p.nvg) p.flashlight = false;
    p.gadgetCooldown = NVG.toggleTime;
    emit(state, { type: 'nvg', on: p.nvg, by: p.id });
    return true;
  }

  if (def.kind === 'door') {
    const found = doorInReach(world, state, p, 1.9);
    if (!found) return false;
    // One fitting each per doorway: the defenders' wedge, wire or alarm in one
    // slot, the attackers' charge in the other. Neither side gets to stack two
    // of its own on the same door, and neither is kept out by the other's.
    const slot = p.gadget === 'charge' ? 'charge' : 'device';
    if (found.state[slot]) return false;
    const device = { kind: p.gadget, by: p.id, team: p.team, fuse: def.fuse ?? 0 };
    // A wire is strung on the side you fitted it from — your own side of the
    // door, which is what makes it something the other man has to spot.
    if (p.gadget === 'trap') device.side = wireSide(found, p);
    found.state[slot] = device;
    p.gadgetLeft--;
    p.gadgetCooldown = 0.8;
    makeNoise(state, doorNoisePos(found.door), 4, 'device', p.id);
    emit(state, { type: 'devicePlaced', doorId: found.door.id, kind: p.gadget, by: p.id });
    return true;
  }

  const eye = eyePosition(p);
  const dir = aimDirection(p);
  // A grenade is lobbed underarm and a flare is rolled along the floor, so
  // both the speed and the lift belong to the kit entry rather than to this
  // function. Everything unstated throws like a grenade.
  const speed = def.throwSpeed ?? THROW_SPEED;
  const lift = def.lift ?? THROW_LIFT;
  const drop = def.lift == null ? 0.1 : 0.3; // rolled from lower down
  state.throwables.push({
    kind: p.gadget,
    by: p.id,
    team: p.team,
    pos: { x: eye.x + dir.x * 0.4, y: eye.y - drop + dir.y * 0.4, z: eye.z + dir.z * 0.4 },
    vel: {
      x: dir.x * speed + p.vel.x,
      y: dir.y * speed + lift,
      z: dir.z * speed + p.vel.z,
    },
    fuse: def.fuse,
  });
  p.gadgetLeft--;
  p.gadgetCooldown = 0.7;
  // A grenade makes its noise when it goes off; a flare makes its only noise
  // when it is struck, because it never goes off at all.
  if (p.gadget === 'flare') {
    makeNoise(state, eye, def.loudness ?? 6, 'flare', p.id);
    emit(state, { type: 'flare', pos: { ...eye }, by: p.id });
  } else {
    emit(state, { type: 'throw', kind: p.gadget, by: p.id });
  }
  return true;
}

// ── The mains ─────────────────────────────────────────────────────────────
//
// The consumer unit is not a door, so it does not go through `doorInReach`:
// it is a flat panel on a wall, and reaching it means standing in front of it
// and looking at it. Both tests matter — without the facing test a man on the
// far side of the terrace wall could reach through and put the flat out.

export function switchInReach(world, state, p, range = POWER.reach) {
  const eye = eyePosition(p);
  const dir = aimDirection(p);
  for (const sw of world.switches ?? []) {
    const dx = sw.pos.x - eye.x;
    const dy = sw.pos.y - eye.y;
    const dz = sw.pos.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > range) continue;
    // In front of the cabinet, not behind the wall it is bolted to.
    if ((eye.x - sw.pos.x) * sw.face.x + (eye.z - sw.pos.z) * sw.face.z <= 0) continue;
    if ((dir.x * dx + dir.y * dy + dir.z * dz) / (d || 1) < 0.7) continue;
    return { sw, distance: d };
  }
  return null;
}

function throwBreaker(world, state, p) {
  const found = switchInReach(world, state, p);
  if (!found) return false;
  state.power = !state.power;
  // A breaker that size goes over with a bang, and it is the loudest decision
  // either side makes: everyone now knows both that the lights went and who
  // was standing on the terrace when they did.
  makeNoise(state, found.sw.pos, POWER.loudness, 'power', p.id);
  emit(state, { type: 'power', on: state.power, pos: { ...found.sw.pos }, by: p.id });
  return true;
}

// Everything currently burning on the floor. The renderer hangs a light on
// each of these, the bots treat them as the only reason they can see anything
// with the power off, and a tube pointed at one is a tube full of white.
export function burningFlares(state) {
  return state.throwables.filter((t) => t.kind === 'flare');
}

// Is this point inside a flare's pool of light? Used where a lamp would
// otherwise be the answer: what a bot can make out once the mains are off.
export function litByFlare(state, pos) {
  for (const t of burningFlares(state)) {
    const d = Math.hypot(pos.x - t.pos.x, pos.y - t.pos.y, pos.z - t.pos.z);
    if (d <= FLARE.radius) return true;
  }
  return false;
}

// A tube that multiplies what little light there is multiplies a road flare
// by the same amount. Standing in one's light with night vision down is the
// counter to night vision — it costs nothing to walk out of, and everything
// to stand in.
function stepNightVision(world, state, p) {
  if (!p.nvg || !p.alive) return;
  const eye = eyePosition(p);
  for (const t of burningFlares(state)) {
    const d = Math.hypot(eye.x - t.pos.x, eye.y - t.pos.y, eye.z - t.pos.z);
    if (d > NVG.flareRange) continue;
    if (!hasLineOfSight(world, state, eye, t.pos)) continue;
    p.blind = Math.max(p.blind, NVG.flareBlind * (1 - d / NVG.flareRange));
    return;
  }
}

// Grenades in flight. A thrown object is a point with a radius: step it, and
// if the step would take it through something, put it on the surface and
// bounce what is left of its speed off the normal.
function stepThrowables(world, state, dt) {
  for (let i = state.throwables.length - 1; i >= 0; i--) {
    const t = state.throwables[i];
    t.vel.y -= GRAVITY * dt;

    let move = { x: t.vel.x * dt, y: t.vel.y * dt, z: t.vel.z * dt };
    let dist = Math.hypot(move.x, move.y, move.z);
    for (let bounce = 0; bounce < 3 && dist > 1e-5; bounce++) {
      const dir = { x: move.x / dist, y: move.y / dist, z: move.z / dist };
      const hit = raycastGeometry(world, state, t.pos, dir, dist + THROW_RADIUS)[0];
      if (!hit) break;

      const travel = Math.max(0, hit.t - THROW_RADIUS);
      t.pos = addScaled(t.pos, dir, travel);
      const n = hit.normal;
      const along = t.vel.x * n.x + t.vel.y * n.y + t.vel.z * n.z;
      t.vel = {
        x: (t.vel.x - 2 * along * n.x) * BOUNCE,
        y: (t.vel.y - 2 * along * n.y) * BOUNCE,
        z: (t.vel.z - 2 * along * n.z) * BOUNCE,
      };
      if (bounce === 0) {
        makeNoise(state, t.pos, 8, 'bounce', t.by);
        emit(state, { type: 'bounce', pos: { ...t.pos }, kind: t.kind });
      }
      dist = Math.max(0, dist - travel) * BOUNCE;
      move = { x: dir.x * dist, y: dir.y * dist, z: dir.z * dist };
    }
    t.pos = { x: t.pos.x + move.x, y: t.pos.y + move.y, z: t.pos.z + move.z };

    t.fuse -= dt;
    if (t.fuse > 0) continue;

    state.throwables.splice(i, 1);
    if (t.kind === 'smoke') popSmoke(state, t);
    // A flare does not go off at the end of its fuse — it simply finishes
    // burning, and the room it was lighting goes back to whatever it was.
    else if (t.kind === 'flare') emit(state, { type: 'flareOut', pos: { ...t.pos }, by: t.by });
    else popFlash(world, state, t);
  }
}

function popSmoke(state, t) {
  const def = GADGETS.smoke;
  state.smokes.push({
    pos: { ...t.pos },
    radius: def.radius,
    grown: 0,
    growTime: def.growTime,
    left: def.duration,
  });
  makeNoise(state, t.pos, def.loudness, 'smoke', t.by);
  emit(state, { type: 'smoke', pos: { ...t.pos }, by: t.by });
}

// A flash does not care how far the blast reaches, it cares who was looking.
// Line of sight is the whole rule — which is also why a cloud of your own
// smoke will save you from your own grenade.
function popFlash(world, state, t) {
  const def = GADGETS.flash;
  makeNoise(state, t.pos, def.loudness, 'flash', t.by);
  emit(state, { type: 'flash', pos: { ...t.pos }, by: t.by });

  for (const p of Object.values(state.players)) {
    if (!p.alive) continue;
    const eye = eyePosition(p);
    const dist = Math.hypot(eye.x - t.pos.x, eye.y - t.pos.y, eye.z - t.pos.z);
    if (dist > def.radius) continue;
    if (!hasLineOfSight(world, state, eye, t.pos)) continue;

    // Facing it costs everything; catching it at the edge of vision costs
    // about a third. Distance does the rest.
    const to = {
      x: (t.pos.x - eye.x) / (dist || 1),
      y: (t.pos.y - eye.y) / (dist || 1),
      z: (t.pos.z - eye.z) / (dist || 1),
    };
    const look = aimDirection(p);
    const facing = Math.max(0, to.x * look.x + to.y * look.y + to.z * look.z);
    const near = 1 - Math.min(1, dist / def.radius);
    // A flash into an image intensifier is a flash multiplied by whatever the
    // tube was multiplying: the one thing night vision cannot do is refuse
    // light. Wearing it through a doorway is a real risk, not a free upgrade.
    const gain = p.nvg ? NVG.flashScale : 1;
    const amount = Math.min(1, (0.35 + 0.65 * facing) * (0.35 + 0.75 * near) * gain);
    // Blindness is counted in seconds, not in screen-white: the gadget says
    // five, so a man who took it square is out of the fight for five, the
    // first of them with nothing on the screen but white. Anything less and
    // a flash is a flicker nobody bothers to throw.
    p.blind = Math.max(p.blind, amount * def.blind * BLIND.fade);
    emit(state, { type: 'blinded', id: p.id, amount });
  }
}

// A blast. Whose device it was does not enter into it: a doorway full of smoke
// and shouting is exactly where your own trap catches your own man, so this
// asks two questions of everyone standing in it and nothing about their colour.
//
//   How far?  Full damage inside `core`, then straight down to nothing at
//             `radius` — see GADGETS for why the curve has that shape.
//   Can they see it?  If not, they are behind something, and something is
//             enough. `throughDoorId` is the one panel that does not count,
//             because it is the panel the device is taped to.
//
// Held to the same ceiling as a bullet, so no device ever kills outright.
function blast(world, state, { pos, damage, radius, core = 0, by, throughDoorId = null }) {
  if (state.phase === 'select' || state.phase === 'prep') return;
  for (const p of Object.values(state.players)) {
    if (!p.alive) continue;
    const chest = { x: p.pos.x, y: p.pos.y + playerHeight(p) * 0.6, z: p.pos.z };
    const dist = Math.hypot(chest.x - pos.x, chest.y - pos.y, chest.z - pos.z);
    if (dist >= radius) continue;
    if (!hasLineOfSight(world, state, chest, pos, throughDoorId)) continue;

    const reach = Math.max(1e-3, radius - Math.min(core, radius));
    const falloff = 1 - Math.max(0, dist - core) / reach;
    const dmg = Math.min(DAMAGE.maxPerHit, damage * falloff);
    if (dmg <= 0) continue;
    p.health -= dmg;
    const shooter = state.players[by];
    emit(state, { type: 'hit', targetId: p.id, by, zone: 'torso', damage: dmg });
    if (p.health <= 0 && p.alive) {
      p.alive = false;
      p.health = 0;
      p.deaths++;
      if (shooter && shooter !== p) shooter.kills++;
      emit(state, { type: 'death', id: p.id, by, zone: 'blast' });
    }
  }
}

// A tripwire going off, however it was set off: by the door moving, or by a
// round through the wire. `by` is whoever caused it — the man who cut the wire
// owns what the grenade behind it does, the same as if he had thrown it.
function detonateTrap(world, state, door, by) {
  const ds = state.doors[door.id];
  const def = GADGETS.trap;
  ds.device = null;
  const at = doorNoisePos(door);
  makeNoise(state, at, def.loudness, 'blast', by);
  emit(state, { type: 'deviceBlast', pos: at, kind: 'trap', doorId: door.id });
  blast(world, state, {
    pos: at, damage: def.damage, radius: def.blastRadius, core: def.blastCore,
    by, throughDoorId: door.id,
  });
}

// Something moved the door: a tripwire goes off, an alarm starts screaming,
// and anything else on the door carries on waiting.
function triggerDoorDevice(world, state, door, p) {
  const ds = state.doors[door.id];
  const device = ds.device;
  if (!device) return;
  // Your own side's devices know you: a defender does not walk into their own
  // tripwire, and does not set off their own alarm. Once one goes off, though,
  // it is a grenade in a doorway and it does not care whose it was.
  if (p && device.team === p.team) return;

  if (device.kind === 'trap') {
    detonateTrap(world, state, door, device.by);
  } else if (device.kind === 'alarm') {
    const def = GADGETS.alarm;
    makeNoise(state, doorNoisePos(door), def.loudness, 'alarm', device.by);
    emit(state, { type: 'alarm', doorId: door.id, by: device.by });
  }
}

// Charges count down on their doors; everything else on a door just waits.
function stepDoorDevices(world, state, dt) {
  for (const door of world.doors) {
    const ds = state.doors[door.id];
    const device = ds.charge;
    if (!device) continue;

    device.fuse -= dt;
    if (device.fuse > 0) continue;

    const def = GADGETS.charge;
    ds.charge = null;
    // The door does not swing, it stops existing: a breached doorway is a
    // hole, and no amount of kicking puts it back on its hinges. Whatever the
    // defenders had on it goes with it — a wedge holds a door shut, and there
    // is no door left to hold.
    const held = ds.device;
    ds.device = null;
    ds.broken = true;
    ds.forced = true;
    ds.locked = false;
    ds.open = 1;
    ds.target = 1;
    const at = doorNoisePos(door);
    makeNoise(state, at, def.loudness, 'blast', device.by);
    emit(state, { type: 'deviceBlast', pos: at, kind: 'charge', doorId: door.id });
    if (held) emit(state, { type: 'deviceBroken', doorId: door.id, kind: held.kind });
    emit(state, { type: 'doorBroken', doorId: door.id, by: device.by });
    // The panel is already gone by the time this is measured, so there is no
    // door left to ignore — anyone in the doorway is simply in the open.
    blast(world, state, {
      pos: at, damage: def.damage, radius: def.blastRadius, core: def.blastCore,
      by: device.by,
    });
  }
}

function stepSmokes(state, dt) {
  for (let i = state.smokes.length - 1; i >= 0; i--) {
    const c = state.smokes[i];
    c.grown = Math.min(1, c.grown + dt / c.growTime);
    c.left -= dt;
    // The last couple of seconds thin out rather than vanishing on a frame.
    if (c.left < 2) c.grown = Math.max(0, c.left / 2);
    if (c.left <= 0) state.smokes.splice(i, 1);
  }
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

  // A flash burns off on its own clock, and being dead does not make it
  // last longer: the next round starts with clear eyes either way.
  if (p.blind > 0) p.blind = Math.max(0, p.blind - BLIND.fade * dt);

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
      emit(state, {
        type: 'land', pos: { ...p.pos }, by: p.id, loud: NOISE.land,
        surface: surfaceUnder(world, state, p),
      });
    }
  }

  // ── Noise ──
  // Feet make noise when they are on something. In the air there is nothing to
  // step on, and a man sailing over a railing used to leave a trail of
  // footsteps behind him — audible to the room and to the bots, from a body
  // whose boots were nowhere near the floor. The landing has its own thud.
  const movedSpeed = Math.hypot(p.pos.x - before.x, p.pos.z - before.z) / dt;
  if (movedSpeed > 0.25 && p.grounded) {
    const stride = input.run ? 0.34 : input.sneak ? 0.75 : 0.5;
    p.lastNoise += dt;
    if (p.lastNoise >= stride) {
      p.lastNoise = 0;
      const loud = input.sneak ? NOISE.sneak : input.crouch ? NOISE.crouch : input.run ? NOISE.run : NOISE.walk;
      makeNoise(state, p.pos, loud, 'step', p.id);
      // Which floor it was: parquet, tile and bare concrete do not sound
      // alike, and in a game where you fight by ear the floor is information.
      emit(state, {
        type: 'step', pos: { ...p.pos }, by: p.id, loud,
        surface: surfaceUnder(world, state, p),
      });
    }
  }

  // ── Flashlight ──
  if (input.toggleLight && p.useCooldown <= 0) {
    p.flashlight = !p.flashlight;
    // Same rule from the other side: raising the torch pushes the tube up.
    if (p.flashlight) p.nvg = false;
    p.useCooldown = 0.25;
  }

  // A tube that is down is a tube anything bright can fill with white.
  stepNightVision(world, state, p);

  // ── Doors ──
  p.useCooldown = Math.max(0, p.useCooldown - dt);
  p.kickCooldown = Math.max(0, p.kickCooldown - dt);

  if (input.use && p.useCooldown <= 0) {
    // The breaker first: it is the only other thing on the map you can reach
    // out and work, and no doorway is ever within arm's reach of it.
    const thrown = throwBreaker(world, state, p);
    if (thrown) p.useCooldown = POWER.cooldown;
    const found = thrown ? null : doorInReach(world, state, p, 1.9);
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

  // Equipment. Held down it throws once, like a self-loader: a grenade is a
  // decision, not something you lean on.
  p.gadgetCooldown = Math.max(0, p.gadgetCooldown - dt);
  const wantsGadget = input.gadget && !p.gadgetDown;
  p.gadgetDown = !!input.gadget;
  if (wantsGadget) useGadget(world, state, p);

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
  stepThrowables(world, state, dt);
  stepDoorDevices(world, state, dt);
  stepSmokes(state, dt);
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
    // Same rule for the device: the pick survives the round, the kit does not.
    const gadgetId = GADGETS[p.gadget]?.team === p.team ? p.gadget : DEFAULT_GADGET[p.team];
    p.gadget = gadgetId;
    p.gadgetLeft = GADGETS[gadgetId].count;
    p.gadgetCooldown = 0;
    p.gadgetDown = false;
    p.nvg = false;
    p.blind = 0;
  }
  // Someone always leaves the flat dark. The next round starts with the lights
  // on, or the decision to cut them would only ever be made once.
  state.power = true;
  state.throwables.length = 0;
  state.smokes.length = 0;
  for (const d of world.doors) {
    const ds = state.doors[d.id];
    ds.device = null;
    ds.charge = null;
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
  const sw = switchInReach(world, state, p);
  if (sw) {
    return {
      kind: 'switch',
      id: sw.sw.id,
      name: sw.sw.name,
      on: state.power !== false,
      distance: sw.distance,
    };
  }
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
