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

// ── The quiet step is a mode the player carries ───────────────────────────
{
  // The HUD reads this off the player to show "ТИХО", and the door uses it to
  // decide whether F eases the handle or turns it, so it has to survive the
  // trip through the simulation rather than living only in the keyboard.
  resetRound(world, state);
  const p = state.players.a1;
  const walk = { ...createInput(), moveZ: 1, yaw: 0 };
  const quiet = { ...walk, sneak: true };

  const travelled = (input) => {
    p.pos = { x: 0, y: 0, z: 8.6 };
    p.vel = { x: 0, y: 0, z: 0 };
    const from = p.pos.z;
    for (let i = 0; i < TICK_RATE; i++) stepSim(world, state, { a1: input, d1: createInput() });
    return from - p.pos.z;
  };

  const quietRun = travelled(quiet);
  check('the quiet step is recorded on the player', p.sneaking === true);
  const walkRun = travelled(walk);
  check('walking clears it again', p.sneaking === false);
  check('the quiet step really is slower', quietRun < walkRun * 0.6,
    `${quietRun.toFixed(2)} m vs ${walkRun.toFixed(2)} m in a second`);
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
// Live, not staging: during staging the attackers are held on the landing.
state.phase = 'live';
state.phaseTime = 60;
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
  // Both ends inside the cinema, nothing in between.
  const a2 = { x: -9, y: 1.6, z: -1.6 };
  const b2 = { x: -5, y: 1.6, z: -1.6 };
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

// ── Recoil walks a fixed pattern, then settles into a cluster ─────────────
{
  const deg = (r) => (r * 180) / Math.PI;

  // Hold the trigger down and record where the sights sit after every shot.
  function sprayPath(shots) {
    resetRound(world, state);
    state.phase = 'live';
    state.phaseTime = 60;
    const p = state.players.a1;
    p.pos = { x: 0, y: 0, z: 8 };
    p.look = { yaw: 0, pitch: 0 };
    const fire = { ...createInput(), yaw: 0, pitch: 0, fire: true };
    const path = [];
    let ammo = p.weapon.ammo;
    for (let i = 0; i < TICK_RATE * 4 && path.length < shots; i++) {
      stepSim(world, state, { a1: fire, d1: createInput() });
      if (p.weapon.ammo < ammo) {
        ammo = p.weapon.ammo;
        path.push({ pitch: deg(p.recoil.pitch), yaw: deg(p.recoil.yaw) });
      }
    }
    return path;
  }

  const path = sprayPath(26);
  check('the spray gets all 26 shots off', path.length === 26, `${path.length} shots`);
  check('a single shot kicks the sights up', path[0].pitch > 0.3, `${path[0].pitch.toFixed(2)}°`);

  // The first seven walk the muzzle up a path worth learning.
  const climb = path[6].pitch;
  check('the first seven shots climb a long way', climb > 6, `${climb.toFixed(2)}°`);
  const rising = path.slice(0, 7).every((s, i, all) => i === 0 || s.pitch > all[i - 1].pitch);
  check('the climb never doubles back on itself', rising,
    path.slice(0, 7).map((s) => s.pitch.toFixed(1)).join(' → '));
  // ...and it bends sideways rather than rising in a dead straight line.
  const bend = Math.min(...path.slice(0, 7).map((s) => s.yaw));
  check('the climb bends to one side', bend < -0.5, `${bend.toFixed(2)}°`);

  // After that the muzzle has nowhere left to go: the tail is a cluster.
  const tail = path.slice(7);
  const tailPitch = tail.map((s) => s.pitch);
  const tailSpan = Math.max(...tailPitch) - Math.min(...tailPitch);
  const tailYaw = Math.max(...tail.map((s) => Math.abs(s.yaw)));
  // The tail is not dead — the muzzle keeps creeping up and wandering — but
  // the opening seven are still where most of the climb happens.
  check('the tail keeps climbing, slowly', tailSpan > 1.5 && tailSpan < climb * 0.6,
    `${tailSpan.toFixed(2)}° across shots 8-26 vs ${climb.toFixed(2)}° of climb`);
  check('the tail stays above the top of the path', Math.min(...tailPitch) > climb * 0.8,
    `lowest ${Math.min(...tailPitch).toFixed(2)}°`);
  check('the tail wanders sideways without running away', tailYaw > 0.8 && tailYaw < 3.5,
    `${tailYaw.toFixed(2)}°`);

  // The pattern is the pattern: two sprays follow the same path.
  const again = sprayPath(7);
  const drift = Math.max(...again.map((s, i) => Math.abs(s.pitch - path[i].pitch)));
  check('the same pattern comes back every time', drift < 0.6, `worst shot differs by ${drift.toFixed(2)}°`);

  // The count starts when you open fire, not when you reload: seven shots,
  // let go, and the next shot kicks like a first shot again.
  {
    resetRound(world, state);
    state.phase = 'live';
    state.phaseTime = 60;
    const p = state.players.a1;
    p.pos = { x: 0, y: 0, z: 8 };
    p.look = { yaw: 0, pitch: 0 };
    const fire = { ...createInput(), yaw: 0, pitch: 0, fire: true };
    let ammo = p.weapon.ammo;
    let fired = 0;
    for (let i = 0; i < TICK_RATE * 2 && fired < 7; i++) {
      stepSim(world, state, { a1: fire, d1: createInput() });
      if (p.weapon.ammo < ammo) { ammo = p.weapon.ammo; fired++; }
    }
    // Trigger off for longer than the reset time, but no reload.
    for (let i = 0; i < TICK_RATE; i++) {
      stepSim(world, state, { a1: { ...createInput(), yaw: 0 }, d1: createInput() });
    }
    check('half a magazine gone, but the burst counter is clear', p.burstShots === 0,
      `burstShots=${p.burstShots}, ammo=${p.weapon.ammo}`);
    const before = p.recoil.pitch;
    for (let i = 0; i < TICK_RATE && p.weapon.ammo === ammo; i++) {
      stepSim(world, state, { a1: fire, d1: createInput() });
    }
    const firstAgain = deg(p.recoil.pitch - before);
    check('the eighth round of the magazine kicks like a first shot',
      Math.abs(firstAgain - path[0].pitch) < 0.4,
      `${firstAgain.toFixed(2)}° vs ${path[0].pitch.toFixed(2)}°`);
  }

  // Let go and the sights fall back to where you were aiming.
  const peak = state.players.a1.recoil.pitch;
  for (let i = 0; i < TICK_RATE * 2; i++) {
    stepSim(world, state, { a1: { ...createInput(), yaw: 0 }, d1: createInput() });
  }
  check('the sights settle after the burst', state.players.a1.recoil.pitch < peak * 0.2,
    `peak=${deg(peak).toFixed(2)}° now=${deg(state.players.a1.recoil.pitch).toFixed(2)}°`);
}

// ── The staging minute keeps the two sides apart ──────────────────────────
{
  resetRound(world, state);
  const a = state.players.a1;
  const d = state.players.d1;
  check('a door that was kicked in before the round starts open',
    state.doors['hall-gym'].forced && state.doors['hall-gym'].open === 1);

  // An attacker who runs at the flat during staging gets no further than the
  // landing he spawned on.
  const forward = { ...createInput(), moveZ: 1, yaw: 0, run: true };
  for (let i = 0; i < TICK_RATE * 3; i++) {
    stepSim(world, state, { a1: forward, d1: createInput() });
  }
  const landing = APARTMENT.rooms.find((r) => r.id === 'landing');
  check('attackers are held on the landing while the round is staging',
    state.phase === 'prep' && a.pos.z > landing.min.z, `z=${a.pos.z.toFixed(2)}`);

  // A defender who tries to take the entrance hall is put back out of it.
  const foyer = APARTMENT.rooms.find((r) => r.id === 'foyer');
  d.pos = { x: 0, y: 0, z: 3.5 };
  for (let i = 0; i < TICK_RATE; i++) {
    stepSim(world, state, { a1: createInput(), d1: { ...createInput(), yaw: 0 } });
  }
  const stillInside = d.pos.x > foyer.min.x && d.pos.x < foyer.max.x &&
    d.pos.z > foyer.min.z && d.pos.z < foyer.max.z;
  check('defenders are kept out of the rooms the map closes to them', !stillInside,
    `(${d.pos.x.toFixed(1)}, ${d.pos.z.toFixed(1)})`);

  // Once the round goes live, nobody is held anywhere: put the attacker inside
  // the flat and he stays there.
  state.phase = 'live';
  state.phaseTime = 60;
  a.pos = { x: 0, y: 0, z: 3.5 };
  for (let i = 0; i < TICK_RATE; i++) {
    stepSim(world, state, { a1: createInput(), d1: createInput() });
  }
  check('the hold lifts when the round goes live', a.pos.z < 5,
    `z=${a.pos.z.toFixed(1)}`);
}

// ── Glass: you see through it, you do not shoot through it ────────────────
{
  const F2 = 3.3;
  const GLASS = 'terrace-wardrobe'; // the terrace door, upstairs at x = -5, z = -10

  // Standing in the dressing room, facing west at the pane.
  function atTheGlass() {
    resetRound(world, state);
    state.phase = 'live';
    state.phaseTime = 60;
    const p = state.players.a1;
    p.pos = { x: -3.6, y: F2, z: -10 };
    p.look = { yaw: Math.PI / 2, pitch: 0 }; // toward -X
    state.players.d1.pos = { x: 8, y: F2, z: -16 }; // out of the way
    return p;
  }

  // Sight passes through a closed pane...
  {
    atTheGlass();
    const inside = { x: -3.6, y: F2 + 1.6, z: -10 };
    const onTerrace = { x: -6.5, y: F2 + 1.6, z: -10 };
    check('you can see through a closed glass door',
      hasLineOfSight(world, state, inside, onTerrace));
  }

  // ...but a bullet does not: it takes the pane down in two.
  {
    const p = atTheGlass();
    let shots = 0;
    let ammo = p.weapon.ammo;
    for (let i = 0; i < TICK_RATE * 2 && !state.doors[GLASS].broken; i++) {
      stepSim(world, state, {
        a1: { ...createInput(), yaw: Math.PI / 2, pitch: 0, fire: true, aim: true },
        d1: createInput(),
      });
      if (p.weapon.ammo < ammo) { ammo = p.weapon.ammo; shots++; }
    }
    check('two rounds shatter the glass door', state.doors[GLASS].broken && shots === 2,
      `shots=${shots}, broken=${state.doors[GLASS].broken}`);
    check('a shattered pane does not swing open, it is gone',
      state.doors[GLASS].open === 0 && state.doors[GLASS].forced === false);
  }

  // Gone means gone: the doorway is walkable and nothing stops a bullet.
  {
    const p = state.players.a1;
    p.pos = { x: -3.6, y: F2, z: -10 };
    for (let i = 0; i < TICK_RATE * 2; i++) {
      stepSim(world, state, {
        a1: { ...createInput(), moveZ: 1, yaw: Math.PI / 2 },
        d1: createInput(),
      });
    }
    check('you can walk out through the empty frame', p.pos.x < -5.4, `x=${p.pos.x.toFixed(2)}`);
  }

  // One boot does the same job as two rounds.
  {
    atTheGlass();
    let kicks = 0;
    for (let i = 0; i < TICK_RATE * 2 && !state.doors[GLASS].broken; i++) {
      const kick = state.players.a1.kickCooldown <= 0;
      if (kick) kicks++;
      stepSim(world, state, {
        a1: { ...createInput(), yaw: Math.PI / 2, kick },
        d1: createInput(),
      });
    }
    check('one kick takes the whole pane out', state.doors[GLASS].broken && kicks === 1,
      `kicks=${kicks}`);
  }

  // And a new round puts the glass back.
  resetRound(world, state);
  check('the pane is back next round', state.doors[GLASS].broken === false);
}

// ── Doors swing wide, and never into a wall ───────────────────────────────
{
  const anglesOk = world.doors.every((d) => d.maxAngle >= Math.PI / 2 - 1e-6);
  check('every door opens at least 90°', anglesOk);
  const wide = world.doors.filter((d) => d.maxAngle > (175 * Math.PI) / 180).length;
  check('every door lies flat against its wall when open', wide === world.doors.length,
    `${wide} of ${world.doors.length} past 175°`);
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
