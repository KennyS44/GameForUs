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
  // Living room to kitchen, straight through the drywall spine at x = 1.
  const inLiving = { x: -2, y: 1.6, z: 1.5 };
  const inKitchen = { x: 4, y: 1.6, z: 1.5 };
  check('drywall blocks line of sight', !hasLineOfSight(world, state, inLiving, inKitchen));
  const a2 = { x: -2, y: 1.6, z: 1.5 };
  const b2 = { x: -5, y: 1.6, z: 1.5 };
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
