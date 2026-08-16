// Smoke test for the simulation, run under plain Node.
//
// This exists to prove the portability claim: if this file keeps passing, the
// simulation has no browser dependencies and can be lifted onto a dedicated
// server later by swapping the transport only.
//
//   node tools/sim-smoke.mjs

import { APARTMENT } from '../src/maps/apartment.js';
import { buildWorld, hasLineOfSight } from '../src/sim/world.js';
import {
  createState, addPlayer, stepSim, createInput, eyePosition, resetRound,
} from '../src/sim/sim.js';
import { TICK_RATE } from '../src/sim/constants.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const world = buildWorld(APARTMENT);
const state = createState(world, 1234);
const attacker = addPlayer(world, state, 'a1', 'attackers', 'Alpha');
const defender = addPlayer(world, state, 'd1', 'defenders', 'Bravo');

console.log('world:', world.boxes.length, 'boxes,', world.doors.length, 'doors');

// ── Gravity settles the player on the floor ───────────────────────────────
const idle = { a1: createInput(), d1: createInput() };
for (let i = 0; i < TICK_RATE; i++) stepSim(world, state, idle);
check('player rests on the floor', Math.abs(attacker.pos.y) < 0.01, `y=${attacker.pos.y}`);

// ── Jumping leaves the ground and comes back down ─────────────────────────
{
  let peak = 0;
  for (let i = 0; i < TICK_RATE; i++) {
    stepSim(world, state, {
      a1: { ...createInput(), jump: i === 0 },
      d1: createInput(),
    });
    peak = Math.max(peak, attacker.pos.y);
  }
  check('jump lifts the player off the floor', peak > 0.3, `peak=${peak.toFixed(2)}`);
  check('the player lands again', Math.abs(attacker.pos.y) < 0.01, `y=${attacker.pos.y.toFixed(3)}`);
}

// Crouching cancels the jump: you cannot bunny-hop out of a peek.
{
  let peak = 0;
  for (let i = 0; i < TICK_RATE / 2; i++) {
    stepSim(world, state, {
      a1: { ...createInput(), jump: true, crouch: true },
      d1: createInput(),
    });
    peak = Math.max(peak, attacker.pos.y);
  }
  check('cannot jump while crouched', peak < 0.01, `peak=${peak.toFixed(3)}`);
}

// ── Walking into a wall does not pass through it ──────────────────────────
const start = { ...attacker.pos };
// moveZ = +1 is "forward"; at yaw 0 that walks toward -Z, into the flat.
const forward = { ...createInput(), moveZ: 1, run: true, yaw: 0 };
for (let i = 0; i < TICK_RATE * 3; i++) {
  stepSim(world, state, { a1: forward, d1: createInput() });
}
check(
  'front door blocks the attacker on the landing',
  attacker.pos.z > 6,
  `z=${attacker.pos.z.toFixed(2)} (started ${start.z})`,
);

// ── One kick takes the locked front door ──────────────────────────────────
attacker.pos = { x: 0, y: 0, z: 6.9 };
attacker.look = { yaw: 0, pitch: 0 };
let kicks = 0;
for (let i = 0; i < TICK_RATE * 3 && !state.doors.front.forced; i++) {
  const input = { ...createInput(), yaw: 0, kick: attacker.kickCooldown <= 0 };
  if (input.kick) kicks++;
  stepSim(world, state, { a1: input, d1: createInput() });
}
check('one kick opens the locked front door', state.doors.front.forced && kicks === 1, `kicks=${kicks}`);
check('kicked door is no longer locked', state.doors.front.locked === false);

// It swings open on its hinges rather than disappearing, so it still stops
// bullets — a kicked door is cover you can no longer close.
for (let i = 0; i < TICK_RATE; i++) stepSim(world, state, idle);
check('kicked door swings fully open', state.doors.front.open > 0.99, `open=${state.doors.front.open.toFixed(2)}`);

// ── With the door open, the attacker can enter the flat ───────────────────
for (let i = 0; i < TICK_RATE * 4; i++) {
  stepSim(world, state, { a1: forward, d1: createInput() });
}
check('attacker gets inside once the door is open', attacker.pos.z < 5.5, `z=${attacker.pos.z.toFixed(2)}`);

// ── A new round puts every door back on its latch ─────────────────────────
resetRound(world, state);
check(
  'kicked door resets for the next round',
  state.doors.front.forced === false &&
    state.doors.front.open === 0 &&
    state.doors.front.locked === true,
  JSON.stringify(state.doors.front),
);

// ── Walls block sight, even ones you can shoot through ────────────────────
{
  // Living room to study, straight through the drywall partition at x = -5.
  const inLiving = { x: -10, y: 1.6, z: -14 };
  const inStudy = { x: -2, y: 1.6, z: -14 };
  check('drywall blocks line of sight', !hasLineOfSight(world, state, inLiving, inStudy));
  // Both ends inside the living room, nothing in between.
  const a2 = { x: -10, y: 1.6, z: -14 };
  const b2 = { x: -12, y: 1.6, z: -10 };
  check('open room does not block line of sight', hasLineOfSight(world, state, a2, b2));
}

// ── Shooting a bulb kills the light ───────────────────────────────────────
resetRound(world, state);
const shooter = state.players.a1;
shooter.pos = { x: 0, y: 0, z: 8 };
const bulb = world.lights.find((l) => l.id === 'landing');
const eye = eyePosition(shooter);
const toBulb = {
  x: bulb.pos.x - eye.x,
  y: bulb.pos.y - eye.y,
  z: bulb.pos.z - eye.z,
};
shooter.look.yaw = Math.atan2(-toBulb.x, -toBulb.z);
shooter.look.pitch = Math.atan2(toBulb.y, Math.hypot(toBulb.x, toBulb.z));
for (let i = 0; i < TICK_RATE * 2 && !state.lights.landing.broken; i++) {
  stepSim(world, state, {
    a1: { ...createInput(), yaw: shooter.look.yaw, pitch: shooter.look.pitch, fire: true, aim: true },
    d1: createInput(),
  });
}
check('a bullet breaks the ceiling light', state.lights.landing.broken);

// ── Hardcore lethality: a few torso rounds kill ───────────────────────────
resetRound(world, state);
const a = state.players.a1;
const d = state.players.d1;
// The staging phase is deliberately non-lethal, so go live before testing this.
state.phase = 'live';
state.phaseTime = 60;
// Both on the landing, close range, clear line of sight.
a.pos = { x: 0, y: 0, z: 8 };
d.pos = { x: 0, y: 0, z: 6.8 };
a.look = { yaw: 0, pitch: 0 }; // yaw 0 looks down -Z, toward the defender
let shots = 0;
for (let i = 0; i < TICK_RATE * 4 && d.alive; i++) {
  const input = { ...createInput(), yaw: 0, pitch: 0, fire: true, aim: true };
  const before = state.players.a1.weapon.ammo;
  stepSim(world, state, { a1: input, d1: createInput() });
  if (state.players.a1.weapon.ammo < before) shots++;
}
check('defender dies to a short burst', !d.alive, `shots fired=${shots}, hp=${d.health.toFixed(0)}`);
check('kill is credited', a.kills === 1, `kills=${a.kills}`);

// ── Nobody can be killed during the staging phase ─────────────────────────
resetRound(world, state);
const pa = state.players.a1;
const pd = state.players.d1;
pa.pos = { x: 0, y: 0, z: 8 };
pd.pos = { x: 0, y: 0, z: 6.8 };
pa.look = { yaw: 0, pitch: 0 };
for (let i = 0; i < TICK_RATE * 2; i++) {
  stepSim(world, state, {
    a1: { ...createInput(), yaw: 0, fire: true, aim: true },
    d1: createInput(),
  });
}
check(
  'staging phase is non-lethal',
  state.phase === 'prep' && pd.health === 100,
  `phase=${state.phase} hp=${pd.health}`,
);

// ── Leaning moves where you shoot from, not just where the camera is ──────
{
  resetRound(world, state);
  const p = state.players.a1;
  p.pos = { x: 0, y: 0, z: 8 };
  p.look = { yaw: 0, pitch: 0 };
  p.lean = 0;
  const centred = eyePosition(p);
  p.lean = 1; // lean right
  const leaned = eyePosition(p);
  check(
    'leaning shifts the eye sideways',
    Math.abs(leaned.x - centred.x) > 0.3 && Math.abs(leaned.z - centred.z) < 0.01,
    `dx=${(leaned.x - centred.x).toFixed(2)}`,
  );

  // Facing north, leaning right must move the eye toward +X.
  check('lean goes to the correct side', leaned.x > centred.x, `x=${leaned.x.toFixed(2)}`);

  // And a leaning player is hittable where they are exposed: shoot at the
  // leaned-out head position and it must connect.
  state.phase = 'live';
  state.phaseTime = 60;
  const shooter = state.players.d1;
  const victim = state.players.a1;
  victim.pos = { x: 0, y: 0, z: 8 };
  victim.look = { yaw: 0, pitch: 0 };
  victim.lean = 1;
  shooter.pos = { x: 0, y: 0, z: 5.5 };
  const target = eyePosition(victim);
  const from = eyePosition(shooter);
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  shooter.look = {
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(target.y - from.y, Math.hypot(dx, dz)),
  };
  const hpBefore = victim.health;
  for (let i = 0; i < TICK_RATE && victim.health === hpBefore; i++) {
    stepSim(world, state, {
      d1: { ...createInput(), yaw: shooter.look.yaw, pitch: shooter.look.pitch, fire: true, aim: true },
      a1: { ...createInput(), lean: 1, yaw: 0 },
    });
  }
  check('a leaning player can be hit where they lean out', victim.health < hpBefore,
    `hp=${victim.health.toFixed(0)}`);
}

// ── Leaning stops at cover instead of passing through it ──────────────────
{
  resetRound(world, state);
  const p = state.players.a1;
  // Stand just clear of the landing's east wall (inner face at x = 2.875) and
  // lean into it. Unclamped, the eye would reach 2.55 + 0.42 = 2.97.
  p.pos = { x: 2.55, y: 0, z: 8 };
  p.look = { yaw: 0, pitch: 0 };
  for (let i = 0; i < TICK_RATE; i++) {
    stepSim(world, state, { a1: { ...createInput(), lean: 1, yaw: 0 }, d1: createInput() });
  }
  const eye = eyePosition(p);
  check('lean is blocked by the wall beside you', eye.x < 2.8, `eye.x=${eye.x.toFixed(2)}`);
  check('the player did not get lifted onto the wall', Math.abs(p.pos.y) < 0.01, `y=${p.pos.y.toFixed(2)}`);
}

// ── Recoil climbs, and climbs harder the longer you hold the trigger ──────
{
  resetRound(world, state);
  state.phase = 'live';
  state.phaseTime = 60;
  const p = state.players.a1;
  p.pos = { x: 0, y: 0, z: 8 };
  p.look = { yaw: 0, pitch: 0 };

  const fire = { ...createInput(), yaw: 0, pitch: 0, fire: true };
  stepSim(world, state, { a1: fire, d1: createInput() });
  const afterFirst = p.recoil.pitch;
  check('a single shot kicks the sights up', afterFirst > 0.01, `pitch=${afterFirst.toFixed(4)}`);

  let prevStep = afterFirst;
  let lastStep = afterFirst;
  for (let i = 0; i < 40; i++) {
    const before = p.recoil.pitch;
    const ammo = p.weapon.ammo;
    stepSim(world, state, { a1: fire, d1: createInput() });
    if (p.weapon.ammo < ammo) {
      prevStep = lastStep;
      lastStep = p.recoil.pitch - before;
    }
  }
  check('sustained fire kicks harder than the first shot', lastStep > afterFirst,
    `first=${afterFirst.toFixed(4)} late=${lastStep.toFixed(4)}`);

  // Let go and the climb settles back down.
  const peak = p.recoil.pitch;
  for (let i = 0; i < TICK_RATE * 2; i++) {
    stepSim(world, state, { a1: { ...createInput(), yaw: 0 }, d1: createInput() });
  }
  check('the sights settle after the burst', p.recoil.pitch < peak * 0.2,
    `peak=${peak.toFixed(3)} now=${p.recoil.pitch.toFixed(3)}`);
}

// ── Doors swing wide, and never into a wall ───────────────────────────────
{
  const anglesOk = world.doors.every((d) => d.maxAngle >= Math.PI / 2 - 1e-6);
  check('every door opens at least 90°', anglesOk);
  const wide = world.doors.filter((d) => d.maxAngle > (140 * Math.PI) / 180).length;
  check('most doors swing wide open', wide >= 5, `${wide} of ${world.doors.length} past 140°`);
  console.log('       swing limits: ' +
    world.doors.map((d) => `${d.id} ${Math.round((d.maxAngle * 180) / Math.PI)}°`).join(', '));
}

// ── Determinism: same seed + same inputs => identical outcome ─────────────
function run(seed) {
  const w = buildWorld(APARTMENT);
  const s = createState(w, seed);
  const p = addPlayer(w, s, 'x', 'attackers', 'X');
  addPlayer(w, s, 'y', 'defenders', 'Y');
  s.phase = 'live';
  s.phaseTime = 60;
  s.players.y.pos = { x: 0, y: 0, z: 6.8 };
  p.pos = { x: 0, y: 0, z: 8 };
  // Sample mid-burst: recoil and hits are still seed-driven here. Sampling
  // after the magazine runs dry would compare two zeroed-out recoil values.
  for (let i = 0; i < 100; i++) {
    stepSim(w, s, {
      x: { ...createInput(), yaw: 0, fire: true },
      y: { ...createInput(), moveX: 1 },
    });
  }
  return JSON.stringify([s.players.x.recoil, s.players.y.pos, s.players.y.health]);
}
check('simulation is deterministic', run(777) === run(777));
check('different seeds diverge', run(777) !== run(778));

// ── Performance headroom ──────────────────────────────────────────────────
resetRound(world, state);
const t0 = process.hrtime.bigint();
const N = 3000;
for (let i = 0; i < N; i++) {
  stepSim(world, state, {
    a1: { ...createInput(), moveZ: -1, fire: i % 5 === 0, yaw: 0 },
    d1: { ...createInput(), moveX: 1 },
  });
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const perTick = ms / N;
console.log(`  perf: ${perTick.toFixed(3)} ms/tick (budget ${(1000 / TICK_RATE).toFixed(2)} ms)`);
check('tick fits comfortably in the frame budget', perTick < 1000 / TICK_RATE / 4);

console.log(failures === 0 ? '\nAll simulation checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
