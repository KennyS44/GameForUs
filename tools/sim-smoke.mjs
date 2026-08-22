// Smoke test for the simulation, run under plain Node.
//
// This exists to prove the portability claim: if this file keeps passing, the
// simulation has no browser dependencies and can be lifted onto a dedicated
// server later by swapping the transport only.
//
//   node tools/sim-smoke.mjs

import { APARTMENT, MATERIALS } from '../src/maps/apartment.js';
import { buildWorld, hasLineOfSight, doorAngle, raycastGeometry } from '../src/sim/world.js';
import {
  createState, addPlayer, stepSim, createInput, eyePosition, resetRound, setLoadout,
  setGadget, rangeScale, hitDamage, litByFlare,
} from '../src/sim/sim.js';
import {
  TICK_RATE, PLAYER, ROUND, WEAPONS, DEFAULT_WEAPON, WEAPON_CLASSES, DAMAGE, GADGETS,
  FLARE,
} from '../src/sim/constants.js';
import { nearestNode, nodePos, findPath, smoothPath } from '../src/sim/nav.js';
import { turnBox, pointInBox } from '../src/sim/math.js';
import { createBotBrain } from '../src/sim/bot.js';
import { createHostSession, createLocalSession } from '../src/net/session.js';

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

// A round now opens at the loadout screen, where nobody may move at all. Every
// check below that says "staging" means the phase after it — the one where the
// defenders take the flat — so restart into that. The select phase gets checks
// of its own at the end of this file.
function restartRound() {
  resetRound(world, state);
  state.phase = 'prep';
  state.phaseTime = ROUND.prepTime;
}
state.phase = 'prep';
state.phaseTime = ROUND.prepTime;
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
  restartRound();
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
restartRound();
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
restartRound();
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
restartRound();
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
restartRound();
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
  restartRound();
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
  // Inside the landing, not out on the doorstep: the front door is steel, and
  // now that a 9 mm no longer punches through one, standing behind it would be
  // testing penetration rather than the lean.
  shooter.pos = { x: 0, y: 0, z: 6.6 };
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
  restartRound();
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

  // Every weapon walks the same shape, so the pattern is checked on one gun:
  // the piston carbine, the middle of the roster and the closest thing it has
  // to a reference. The class-to-class comparison comes after.
  const REFERENCE = 'ar-556-piston';

  // Hold the trigger down and record where the sights sit after every shot.
  function sprayPath(shots, weaponId = REFERENCE) {
    restartRound();
    setLoadout(state, 'a1', weaponId);
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
    restartRound();
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

  // The shape is shared; how hard it kicks is not. A 9 mm walks a gentler path
  // than a 5.56 carbine, and 5.45 walks the hardest of the three.
  const seven = (id) => sprayPath(7, id)[6].pitch;
  const smg = seven('smg-9-roller');
  const carbine = seven(REFERENCE);
  const heavyRifle = seven('ar-545-piston');
  check('a heavier round walks the sights further up the same path',
    smg < carbine && carbine < heavyRifle,
    `PP-9 ${smg.toFixed(1)}° < AR-556 ${carbine.toFixed(1)}° < AV-74 ${heavyRifle.toFixed(1)}°`);

  // Leave the shared player as the tests after this one expect to find them.
  restartRound();
  setLoadout(state, 'a1', DEFAULT_WEAPON);
}

// ── The staging minute keeps the two sides apart ──────────────────────────
{
  restartRound();
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
    restartRound();
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
  restartRound();
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
console.log('\nA door never pushes anyone through a wall:');
// Stand in each doorway and swing the door onto the player, both ways. The
// panel may shove you aside; it may never put you inside geometry, and it may
// never move you further than a person could walk in a tick.
{
  const radius = PLAYER.radius;
  let worstJump = 0;
  let inside = null;
  let teleported = null;
  let farthest = null;
  for (const door of world.doors) {
    // Bodies in the doorway itself, and bodies standing in the arc the panel
    // sweeps through — the classic pinch is being caught behind an opening door.
    const spots = [];
    for (const off of [-0.35, -0.15, 0, 0.15, 0.35]) {
      spots.push({
        x: door.pos.x + (door.axis === 'x' ? off : 0),
        z: door.pos.z + (door.axis === 'x' ? 0 : off),
      });
    }
    for (const frac of [0.4, 0.7, 1.0]) {
      for (let k = 1; k <= 5; k++) {
        const th = doorAngle(door, (k / 6) * 1.0);
        spots.push({
          x: door.hinge.x + Math.cos(th) * door.width * frac,
          z: door.hinge.z + Math.sin(th) * door.width * frac,
        });
      }
    }
    for (const way of [1, -1]) for (const spot of spots) {
      const state = createState(world, 5);
      const p = addPlayer(world, state, 'p', 'attackers', 'P');
      state.phase = 'live';
      const ds = state.doors[door.id];
      // Middle of the doorway, on the door's own storey.
      // Spread the test bodies across the doorway: the pinch that matters is
      // the one against the jamb, not the one in the middle.
      p.pos = { x: spot.x, y: door.floorY + 0.05, z: spot.z };
      // The hall-gym doorway has an obstacle standing in it on purpose; you
      // cannot start a pinch test somewhere a body does not fit anyway.
      const start = {
        min: { x: p.pos.x - radius, y: p.pos.y + 0.05, z: p.pos.z - radius },
        max: { x: p.pos.x + radius, y: p.pos.y + 1.2, z: p.pos.z + radius },
      };
      if (world.boxes.some((b) =>
        start.min.x < b.max.x - 0.02 && start.max.x > b.min.x + 0.02 &&
        start.min.y < b.max.y - 0.02 && start.max.y > b.min.y + 0.02 &&
        start.min.z < b.max.z - 0.02 && start.max.z > b.min.z + 0.02)) continue;
      let last = { x: p.pos.x, z: p.pos.z };
      for (let i = 0; i <= 40; i++) {
        ds.open = way > 0 ? i / 40 : 1 - i / 40;
        ds.locked = false;
        stepSim(world, state, { p: createInput() });
        const jump = Math.hypot(p.pos.x - last.x, p.pos.z - last.z);
        if (jump > worstJump) { worstJump = jump; farthest = `${door.id} moved the player ${jump.toFixed(2)} m in one tick`; }
        const body = {
          min: { x: p.pos.x - radius, y: p.pos.y + 0.05, z: p.pos.z - radius },
          max: { x: p.pos.x + radius, y: p.pos.y + 1.2, z: p.pos.z + radius },
        };
        const hit = world.boxes.find((b) =>
          body.min.x < b.max.x - 0.02 && body.max.x > b.min.x + 0.02 &&
          body.min.y < b.max.y - 0.02 && body.max.y > b.min.y + 0.02 &&
          body.min.z < b.max.z - 0.02 && body.max.z > b.min.z + 0.02);
        // Did the player cross a wall to get here? A push that skips over
        // geometry is exactly the bug that put someone in the wrong room.
        for (let s = 1; s <= 20 && !teleported; s++) {
          const mx = last.x + (p.pos.x - last.x) * (s / 20);
          const mz = last.z + (p.pos.z - last.z) * (s / 20);
          const my = p.pos.y + 0.6;
          const through = world.boxes.find((b) =>
            mx > b.min.x && mx < b.max.x && my > b.min.y && my < b.max.y && mz > b.min.z && mz < b.max.z);
          if (through && jump > 0.02) teleported = `${door.id}: the panel pushed the player through ${through.material?.name ?? 'geometry'}`;
        }
        if (hit && !inside) inside = `${door.id}: player ended inside ${hit.material?.name ?? 'geometry'} at (${p.pos.x.toFixed(1)}, ${p.pos.z.toFixed(1)})`;
        last = { x: p.pos.x, z: p.pos.z };
      }
    }
  }
  console.log(`  (largest push seen: ${worstJump.toFixed(3)} m)`);
  check('a swinging door never buries anyone in geometry', !inside, inside ?? '');
  check('a swinging door never pushes anyone through a wall', !teleported, teleported ?? '');
  check('a swinging door never flings anyone across the map', worstJump < 0.6, farthest ?? '');
}

// ── Eleven weapons that behave like eleven weapons ────────────────────────
//
// The roster carries real figures now, so what matters is that the differences
// between entries reach the simulation: a self-loader is not an automatic, a
// shotgun is not a rifle with a big number, and a heavy round goes through a
// wall a 9 mm dies in.
{
  console.log('\nBallistics:');

  // Two players facing each other on the landing, nothing in between.
  function duel(weaponId, gap = 1.4) {
    restartRound();
    setLoadout(state, 'a1', weaponId);
    state.phase = 'live';
    state.phaseTime = 60;
    const a = state.players.a1;
    const d = state.players.d1;
    a.pos = { x: 0, y: 0, z: 8 };
    d.pos = { x: 0, y: 0, z: 8 - gap };
    a.look = { yaw: 0, pitch: 0 };
    return { a, d };
  }

  // Every entry has to be complete: a missing field is a weapon that behaves
  // like whatever `undefined` happens to do in arithmetic.
  const specOk = Object.entries(WEAPONS).every(([, w]) =>
    w.damage > 0 && w.rpm > 0 && w.magSize > 0 && w.reserve >= w.magSize
    && w.recoilClimb.length === 7 && w.recoilClimb.every(([y, p]) => Number.isFinite(y) && p > 0)
    && w.range.near > 0 && w.range.far > w.range.near && w.range.floor > 0 && w.range.floor <= 1
    && w.aimTime > 0 && w.moveScale > 0 && w.pellets >= 1);
  check('every entry carries a full set of numbers', specOk);
  // Where a figure came from is part of the figure: an entry nobody can trace
  // back to a real weapon is one nobody can argue with later.
  check('every entry says which real weapon its numbers came from',
    Object.values(WEAPONS).every((w) => /Siege|Zero Hour/.test(w.from ?? '')),
    Object.entries(WEAPONS).filter(([, w]) => !w.from).map(([id]) => id).join(' '));

  // Held down, a self-loader fires exactly once.
  {
    const { a } = duel('dmr-762');
    const held = { ...createInput(), yaw: 0, fire: true };
    for (let i = 0; i < TICK_RATE; i++) stepSim(world, state, { a1: held, d1: createInput() });
    check('the trigger held down fires a self-loader once',
      a.weapon.ammo === WEAPONS['dmr-762'].magSize - 1, `ammo=${a.weapon.ammo}`);

    // Let go, press again: the second round goes.
    for (let i = 0; i < 6; i++) stepSim(world, state, { a1: { ...createInput(), yaw: 0 }, d1: createInput() });
    for (let i = 0; i < 20; i++) stepSim(world, state, { a1: held, d1: createInput() });
    check('letting go and pressing again fires the next one',
      a.weapon.ammo === WEAPONS['dmr-762'].magSize - 2, `ammo=${a.weapon.ammo}`);
  }

  // The same second of held trigger empties an automatic instead.
  {
    const { a } = duel('smg-45-inline');
    const held = { ...createInput(), yaw: 0, fire: true };
    for (let i = 0; i < TICK_RATE; i++) stepSim(world, state, { a1: held, d1: createInput() });
    const fired = WEAPONS['smg-45-inline'].magSize - a.weapon.ammo;
    check('an automatic empties its magazine on one pull', fired >= 18, `${fired} rounds`);
  }

  // The rule the roster is built on, asked of every entry directly rather than
  // inferred from a firefight: no single projectile may kill a healthy player.
  // Point blank, no cover, worst zone.
  //
  // Two exceptions, and both are the point of the weapon rather than a hole in
  // the rule. The .50 kills with its one round on a clean line. And a shotgun
  // kills with a whole pattern at the muzzle — that is eight hits at once, not
  // a lucky one, and it is the only thing a shotgun has.
  {
    const offenders = [];
    for (const [id, w] of Object.entries(WEAPONS)) {
      if (w.oneShot) continue;
      for (const zone of ['head', 'torso', 'limb']) {
        const one = hitDamage(w, zone, 1);
        if (one >= PLAYER.maxHealth) offenders.push(`${id} ${zone} ${one.toFixed(0)}`);
      }
    }
    check('nothing but the .50 kills with one projectile', offenders.length === 0,
      offenders.join(', '));

    const single = Object.values(WEAPONS)
      .filter((w) => !w.oneShot && w.pellets === 1)
      .flatMap((w) => ['head', 'torso'].map((z) => hitDamage(w, z, 1)));
    check('and no rifle round comes close on its own',
      PLAYER.maxHealth - Math.max(...single) >= 10,
      `${(PLAYER.maxHealth - Math.max(...single)).toFixed(0)} health left`);
  }

  // Buckshot, on the other hand, has one job.
  {
    for (const id of ['sg-12-double', 'sg-12-pump', 'sg-12-mag']) {
      const w = WEAPONS[id];
      const atMuzzle = hitDamage(w, 'torso', 0.5) * w.pellets;
      const acrossRoom = hitDamage(w, 'torso', 6) * w.pellets;
      check(`${id}: the whole pattern at the muzzle kills`, atMuzzle >= PLAYER.maxHealth,
        `${atMuzzle.toFixed(0)} damage`);
      check(`${id}: six metres out, even a perfect pattern does not`,
        acrossRoom < PLAYER.maxHealth, `${acrossRoom.toFixed(0)} damage`);
      check(`${id}: and one pellet is still one pellet`,
        hitDamage(w, 'head', 0.5) < 25, `${hitDamage(w, 'head', 0.5).toFixed(0)} per pellet`);
    }
  }

  // The .50 is the exception, and only with nothing in the way.
  {
    const fifty = WEAPONS['amr-50'];
    check('a clean .50 hit kills outright', hitDamage(fifty, 'torso', 1) >= PLAYER.maxHealth,
      `${hitDamage(fifty, 'torso', 1).toFixed(0)}`);
    check('the same round through cover does not',
      hitDamage(fifty, 'torso', 1, { cover: 0.58 }) <= DAMAGE.maxPerHit,
      `${hitDamage(fifty, 'torso', 1, { cover: 0.58 }).toFixed(0)}`);
  }

  // One shell hurts badly and does not kill; the second one does.
  {
    const { a, d } = duel('sg-12-pump', 1.4);
    for (let i = 0; i < 20 && d.alive; i++) {
      stepSim(world, state, { a1: { ...createInput(), yaw: 0, fire: true }, d1: createInput() });
    }
    check('one shell in the doorway is the whole conversation',
      !d.alive && a.weapon.ammo === WEAPONS['sg-12-pump'].magSize - 1,
      `ammo=${a.weapon.ammo} hp=${d.health.toFixed(0)}`);
  }

  // Damage falls off with distance the way Siege's model says it does.
  {
    const pump = WEAPONS['sg-12-pump'];
    const dmr = WEAPONS['dmr-762'];
    check('a shell is worth its full damage at the door and its floor down a corridor',
      rangeScale(pump, 2) === 1 && rangeScale(pump, 20) === pump.range.floor
      && rangeScale(pump, 9) < 1 && rangeScale(pump, 9) > pump.range.floor,
      `${rangeScale(pump, 9).toFixed(2)} at 9 m`);
    check('a marksman rifle keeps its damage across the whole flat',
      rangeScale(dmr, 30) === 1 && rangeScale(dmr, 35) > 0.8,
      `${rangeScale(dmr, 35).toFixed(2)} at 35 m`);
  }

  // A shotgun has to reach across a room. The old cones threw a pattern two
  // metres wide at ten paces, which is a weapon that misses a standing man
  // with every pellet but one — so the cone is checked in centimetres, at the
  // range the flat is actually fought at.
  {
    const across = [];
    for (const id of ['sg-12-double', 'sg-12-pump', 'sg-12-mag']) {
      const w = WEAPONS[id];
      // Radius of the pattern at ten metres, down the sights.
      across.push([id, w.spreadAim * 10, rangeScale(w, 10)]);
    }
    check('buckshot still holds a pattern at ten metres',
      across.every(([, r]) => r <= 0.6), across.map(([id, r]) => `${id} ${(r * 100).toFixed(0)} cm`).join(', '));
    // Out there is where the three of them stop being the same weapon: the
    // pump still has something to say at ten metres, the sawn-off does not.
    const scaleOf = (id) => rangeScale(WEAPONS[id], 10);
    check('the pump gun still carries down a corridor', scaleOf('sg-12-pump') >= 0.6,
      `${(scaleOf('sg-12-pump') * 100).toFixed(0)}%`);
    check('and the sawn-off does not', scaleOf('sg-12-double') <= 0.5,
      `${(scaleOf('sg-12-double') * 100).toFixed(0)}%`);
  }

  // Shells go in one at a time, and the tube can be topped up part way.
  {
    const { a } = duel('sg-12-pump');
    const def = WEAPONS['sg-12-pump'];
    a.weapon.ammo = 2;
    const reserveBefore = a.weapon.reserve;
    for (let i = 0; i < TICK_RATE * 5; i++) {
      stepSim(world, state, { a1: { ...createInput(), yaw: 0, reload: i === 0 }, d1: createInput() });
    }
    check('the tube fills shell by shell', a.weapon.ammo === def.magSize,
      `ammo=${a.weapon.ammo}`);
    check('every shell came out of the pocket it was in',
      a.weapon.reserve === reserveBefore - (def.magSize - 2),
      `${reserveBefore} → ${a.weapon.reserve}`);
  }

  // A magazine, by contrast, is dropped with whatever was left in it.
  {
    const { a } = duel('ar-556-piston');
    const def = WEAPONS['ar-556-piston'];
    a.weapon.ammo = 21;
    const reserveBefore = a.weapon.reserve;
    for (let i = 0; i < TICK_RATE * 4 && a.weapon.ammo !== def.magSize; i++) {
      stepSim(world, state, { a1: { ...createInput(), yaw: 0, reload: i === 0 }, d1: createInput() });
    }
    check('an early reload costs a whole magazine, not the rounds used',
      a.weapon.ammo === def.magSize && a.weapon.reserve === reserveBefore - def.magSize,
      `${reserveBefore} → ${a.weapon.reserve}`);
  }

  // Recoil has to be a different animal on every class, or rate of fire is
  // free and the fastest gun simply wins. Two figures decide that: how far the
  // sights climb over a second of holding the trigger, and how quickly they
  // come back once it is released.
  {
    const climbPerSecond = (w) => {
      const shots = Math.min(w.magSize, w.rpm / 60);
      let climb = 0;
      for (let i = 0; i < shots; i++) {
        climb += i < w.recoilClimb.length ? w.recoilClimb[i][1] : w.recoilSettle.pitch;
      }
      return (climb * 180) / Math.PI;
    };
    const smg = Math.max(...['smg-9-roller', 'smg-57-pdw', 'smg-45-inline'].map((id) => climbPerSecond(WEAPONS[id])));
    const rifle = Math.min(...['ar-545-piston', 'ar-556-piston', 'ar-556-folder'].map((id) => climbPerSecond(WEAPONS[id])));
    check('a rifle climbs harder than any submachine gun', rifle > smg * 1.35,
      `rifle ${rifle.toFixed(1)}°/s vs smg ${smg.toFixed(1)}°/s`);

    const kick = (id) => (WEAPONS[id].peak * 180) / Math.PI;
    check('and the heavier the round, the bigger the jump',
      kick('smg-57-pdw') < kick('smg-9-roller') && kick('smg-9-roller') < kick('ar-556-piston')
      && kick('ar-556-piston') < kick('dmr-762') && kick('dmr-762') < kick('sg-12-pump')
      && kick('sg-12-pump') < kick('amr-50'),
      ['smg-57-pdw', 'smg-9-roller', 'ar-556-piston', 'dmr-762', 'sg-12-pump', 'amr-50']
        .map((id) => `${id} ${kick(id).toFixed(1)}°`).join(' < '));

    const recovery = (cls) => new Set(Object.values(WEAPONS).filter((w) => w.cls === cls).map((w) => w.recoilRecovery));
    const settles = ['smg', 'rifle', 'shotgun', 'heavy'].map((c) => [...recovery(c)][0]);
    check('and the sights settle at a different speed on every class',
      new Set(settles).size === 4 && settles[0] > settles[1] && settles[1] > settles[2] && settles[2] > settles[3],
      settles.join(' > '));
  }

  // One round in the gun, fifteen in the world: every shot is a decision.
  {
    const fifty = WEAPONS['amr-50'];
    check('the .50 is single-shot', fifty.magSize === 1, `${fifty.magSize} in the magazine`);
    check('and carries fifteen rounds in all', fifty.magSize + fifty.reserve === 15,
      `${fifty.magSize + fifty.reserve}`);

    const { a, d } = duel('amr-50');
    for (let i = 0; i < TICK_RATE; i++) {
      stepSim(world, state, { a1: { ...createInput(), yaw: 0, fire: i % 6 < 2 }, d1: createInput() });
    }
    check('a second of trigger gets exactly one round away', a.weapon.ammo === 0,
      `${a.weapon.ammo} left in the gun`);
    check('and it was worth having', !d.alive, `hp=${d.health.toFixed(0)}`);

    // Reloading it is three and a half seconds of standing there.
    let ticks = 0;
    for (let i = 0; i < TICK_RATE * 6 && a.weapon.ammo === 0; i++) {
      stepSim(world, state, { a1: { ...createInput(), yaw: 0, reload: i === 0 }, d1: createInput() });
      ticks++;
    }
    check('and feeding it takes the time the sheet says',
      Math.abs(ticks / TICK_RATE - fifty.reloadTime) < 0.25,
      `${(ticks / TICK_RATE).toFixed(1)} s of ${fifty.reloadTime}`);
  }

  // Through the drywall partition between the living room and the study.
  {
    function throughTheWall(weaponId, targetX = -2) {
      restartRound();
      setLoadout(state, 'a1', weaponId);
      state.phase = 'live';
      state.phaseTime = 60;
      const a = state.players.a1;
      const d = state.players.d1;
      a.pos = { x: -9, y: 0, z: -16 };
      d.pos = { x: targetX, y: 0, z: -16 };
      const yaw = -Math.PI / 2; // facing +x, across the partition at x = -5
      a.look = { yaw, pitch: 0 };
      const hp = d.health;
      for (let i = 0; i < TICK_RATE * 3; i++) {
        stepSim(world, state, {
          a1: { ...createInput(), yaw, fire: i % 4 < 2, aim: true }, d1: createInput(),
        });
      }
      return hp - d.health;
    }
    const buck = throughTheWall('sg-12-pump');
    check('buckshot does not cross a drywall partition', buck === 0, `${buck.toFixed(0)} damage`);

    // The .50 crosses one wall and one only. Through it the round arrives with
    // most of its damage gone and held to the per-hit ceiling — a wounded man,
    // not a dead one, and then three and a half seconds of reload to think
    // about it. Two walls and it never arrives at all.
    const oneWall = throughTheWall('amr-50');
    check('the .50 goes through a wall and hurts', oneWall > 40, `${oneWall.toFixed(0)} damage`);
    check('but a wall costs it the kill', oneWall < PLAYER.maxHealth,
      `${oneWall.toFixed(0)} damage`);
    const twoWalls = throughTheWall('amr-50', 9);
    check('and the second wall stops it dead', twoWalls === 0, `${twoWalls.toFixed(0)} damage`);
  }

  // Weight is a real cost: the same sprint carries you less far.
  {
    function runFor(weaponId) {
      restartRound();
      setLoadout(state, 'a1', weaponId);
      state.phase = 'live';
      state.phaseTime = 60;
      const p = state.players.a1;
      // Speed reached, not ground covered: a run measured across the flat
      // would be measuring the furniture in the way.
      p.pos = { x: 0, y: 0, z: 8 };
      let top = 0;
      for (let i = 0; i < TICK_RATE; i++) {
        stepSim(world, state, { a1: { ...createInput(), moveZ: -1, run: true, yaw: 0 }, d1: createInput() });
        top = Math.max(top, Math.hypot(p.vel.x, p.vel.z));
      }
      return top;
    }
    const light = runFor('sg-12-double');
    const heavy = runFor('amr-50');
    check('the .50 is carried at a walk, the sawn-off at a run', heavy < light * 0.85,
      `${light.toFixed(2)} m/s vs ${heavy.toFixed(2)} m/s`);
  }

  restartRound();
  setLoadout(state, 'a1', DEFAULT_WEAPON);
}

// ── Equipment ─────────────────────────────────────────────────────────────
//
// Six devices, two lists, and every one of them exists to change what a
// doorway costs. What matters here is that they belong to the right side, that
// they go off when they should and not when they should not, and that none of
// them breaks the rule the guns keep: no single hit kills.
{
  console.log('\nEquipment:');

  // The front door of the flat, with the attacker on the landing facing it.
  function atFrontDoor(gadgetId) {
    restartRound();
    const a = state.players.a1;
    const d = state.players.d1;
    // Kit is chosen during staging, so pick before the round goes live.
    if (gadgetId) setGadget(state, GADGETS[gadgetId].team === 'attackers' ? 'a1' : 'd1', gadgetId);
    state.phase = 'live';
    state.phaseTime = 120;
    // Whoever is holding the device stands at the door; the other one stands
    // clear of it.
    const holder = gadgetId && GADGETS[gadgetId].team === 'defenders' ? d : a;
    const other = holder === a ? d : a;
    holder.pos = { x: 0, y: 0, z: 6.9 };
    holder.look = { yaw: 0, pitch: 0 };
    other.pos = { x: 0, y: 0, z: 8.6 };
    other.look = { yaw: 0, pitch: 0 };
    return { a, d };
  }

  const press = (extra = {}) => ({ ...createInput(), yaw: 0, ...extra });

  check('a side only carries its own list',
    setGadget(state, 'a1', 'wedge') === false && setGadget(state, 'a1', 'flash') === true,
    `${state.players.a1.gadget}`);
  check('the defenders get the other one',
    setGadget(state, 'd1', 'flash') === false && setGadget(state, 'd1', 'trap') === true,
    `${state.players.d1.gadget}`);

  // ── The wedge: the door holds, the first boot takes the wedge, the second
  // takes the door.
  {
    const { a, d } = atFrontDoor('wedge');
    stepSim(world, state, { d1: press({ gadget: true }), a1: createInput() });
    check('a wedge goes onto the door in front of you',
      state.doors.front.device?.kind === 'wedge' && d.gadgetLeft === GADGETS.wedge.count - 1,
      JSON.stringify(state.doors.front.device));

    state.doors.front.locked = false; // the wedge, not the latch, is on trial
    for (let i = 0; i < 10; i++) stepSim(world, state, { a1: press({ use: i === 0 }), d1: createInput() });
    check('a wedged door will not open', state.doors.front.target === 0,
      `target=${state.doors.front.target}`);

    // The attacker steps up to the door the defender just wedged.
    a.pos = { x: 0, y: 0, z: 6.9 };
    d.pos = { x: 0, y: 0, z: 3.0 };
    let kicks = 0;
    for (let i = 0; i < TICK_RATE * 4 && !state.doors.front.forced; i++) {
      const kick = a.kickCooldown <= 0;
      if (kick) kicks++;
      stepSim(world, state, { a1: press({ kick }), d1: createInput() });
    }
    check('it takes two kicks: one for the wedge, one for the door', kicks === 2, `${kicks} kicks`);
  }

  // ── The tripwire: it waits for the other side and hurts without killing.
  {
    const { a, d } = atFrontDoor('trap');
    stepSim(world, state, { d1: press({ gadget: true }), a1: createInput() });
    check('a tripwire goes on the door', state.doors.front.device?.kind === 'trap');

    // Its owner walks through it unharmed.
    state.doors.front.locked = false;
    for (let i = 0; i < 6; i++) stepSim(world, state, { d1: press({ use: i === 0 }), a1: createInput() });
    check('a defender does not trip their own wire',
      state.doors.front.device?.kind === 'trap' && d.health === PLAYER.maxHealth,
      `hp=${d.health}`);

    // The attacker does.
    const hp = a.health;
    a.pos = { x: 0, y: 0, z: 6.9 };
    d.pos = { x: 0, y: 0, z: 3.0 };
    for (let i = 0; i < 6; i++) stepSim(world, state, { a1: press({ use: i === 0 }), d1: createInput() });
    const taken = hp - a.health;
    check('an attacker sets it off', taken > 20, `${taken.toFixed(0)} damage`);
    check('and survives it, like everything else in this game',
      a.alive && taken < PLAYER.maxHealth, `hp=${a.health.toFixed(0)}`);
    check('the wire is spent', state.doors.front.device === null);
  }

  // ── The wire is a target: cut it from down the landing and the grenade goes
  // off in the doorway instead of in your face.
  {
    const { a, d } = atFrontDoor('trap');
    stepSim(world, state, { d1: press({ gadget: true }), a1: createInput() });
    check('the wire knows which side it was strung on',
      state.doors.front.device?.side === 1, `side=${state.doors.front.device?.side}`);

    // The defender falls back into the hall behind his own door; the attacker
    // backs to the far end of the landing, outside the blast, and shoots the
    // thread. Down the sights: at three metres the wire is a centimetre of
    // target, which hip fire has no business hitting.
    d.pos = { x: 0, y: 0, z: 5 };
    a.pos = { x: 0, y: 0, z: 9 };
    // The thread hangs a metre up, a hand's width in front of the panel.
    const eye = eyePosition(a);
    const pitch = Math.atan2(1 - eye.y, a.pos.z - 5.9);
    const dHp = d.health;
    const aHp = a.health;
    for (let i = 0; i < 40 && state.doors.front.device; i++) {
      stepSim(world, state, {
        a1: press({ yaw: 0, pitch, aim: true, fire: i === 30 }),
        d1: createInput(),
      });
    }
    check('a round through the thread sets the trap off early',
      state.doors.front.device === null, JSON.stringify(state.doors.front.device));
    check('and the doorway it was on is still standing',
      !state.doors.front.broken && state.doors.front.open === 0);
    check('the man who cut it is too far away to be touched',
      a.health === aHp, `hp=${a.health.toFixed(0)}`);
    check('the defender behind his own door is not',
      dHp - d.health > 20, `${(dHp - d.health).toFixed(0)} damage`);
  }

  // ── A wall is a wall: the blast stops at it.
  {
    const { a, d } = atFrontDoor('trap');
    stepSim(world, state, { d1: press({ gadget: true }), a1: createInput() });
    // The defender flattens himself against the wall beside the doorway —
    // two and a half metres away, well inside the radius, with a wall in
    // between. The attacker opens the door and takes the whole thing.
    d.pos = { x: 2.5, y: 0, z: 6.5 };
    a.pos = { x: 0, y: 0, z: 6.9 };
    state.doors.front.locked = false;
    const dHp = d.health;
    const aHp = a.health;
    for (let i = 0; i < 6; i++) stepSim(world, state, { a1: press({ use: i === 0 }), d1: createInput() });
    check('the man who opened the door wears it', aHp - a.health > 20,
      `${(aHp - a.health).toFixed(0)} damage`);
    check('the man behind the wall does not', d.health === dHp,
      `${(dHp - d.health).toFixed(0)} damage`);
  }

  // ── The alarm: silent for its own side, loud for the other.
  {
    const { a, d } = atFrontDoor('alarm');
    stepSim(world, state, { d1: press({ gadget: true }), a1: createInput() });
    state.doors.front.locked = false;
    check('an alarm goes on the door', state.doors.front.device?.kind === 'alarm');

    // The defender opens it and shuts it again: their own alarm stays quiet.
    let heard = 0;
    const run = (who, ticks, extra = {}) => {
      for (let i = 0; i < ticks; i++) {
        const input = press({ ...extra, use: i === 0 && extra.use !== false });
        stepSim(world, state, who === 'a1'
          ? { a1: input, d1: createInput() }
          : { d1: input, a1: createInput() });
        heard += state.events.filter((e) => e.type === 'alarm').length;
      }
    };
    run('d1', 60);            // the defender goes through their own door
    check('its own side opens the door quietly', heard === 0, `${heard} alarms`);

    // Shut it again from the simulation's side: a door standing flat against
    // the wall is out of reach from the front, which is a property of doors
    // and not of alarms.
    state.doors.front.open = 0;
    state.doors.front.target = 0;

    // Now the attacker takes the same handle.
    state.players.a1.pos = { x: 0, y: 0, z: 6.9 };
    state.players.d1.pos = { x: 0, y: 0, z: 3.0 };
    run('a1', 30);
    check('the other side sets it screaming', heard === 1, `${heard} alarms`);
  }

  // ── The charge: four seconds, and the doorway is a hole.
  {
    const { a } = atFrontDoor('charge');
    stepSim(world, state, { a1: press({ gadget: true }), d1: createInput() });
    check('a charge goes on the door', state.doors.front.charge?.kind === 'charge');
    check('it does not go off at once', state.doors.front.broken === false);

    // Nobody plants a charge and stands in front of it: he steps behind the
    // wall beside the doorway while it counts down.
    a.pos = { x: 2.5, y: 0, z: 6.5 };
    for (let i = 0; i < TICK_RATE * 5 && !state.doors.front.broken; i++) {
      stepSim(world, state, { a1: press(), d1: createInput() });
    }
    check('four seconds later the door is gone',
      state.doors.front.broken && state.doors.front.charge === null,
      JSON.stringify(state.doors.front.broken));
  }

  // ── A wedge does not stop a charge: it goes on over the top of it, and the
  // breach takes the wedge with the door — plus anyone standing behind it.
  {
    restartRound();
    setGadget(state, 'd1', 'wedge');
    setGadget(state, 'a1', 'charge');
    state.phase = 'live';
    state.phaseTime = 120;
    const a = state.players.a1;
    const d = state.players.d1;

    // The defender wedges the front door from inside the hall.
    d.pos = { x: 0, y: 0, z: 4.9 };
    d.look = { yaw: Math.PI, pitch: 0 };
    stepSim(world, state, { d1: { ...press({ gadget: true }), yaw: Math.PI }, a1: createInput() });
    check('the door is wedged shut', state.doors.front.device?.kind === 'wedge');

    // He falls back into the hall — far enough to survive it, close enough to
    // feel it. The attacker fits a charge to the same door.
    d.pos = { x: 0, y: 0, z: 3.8 };
    a.pos = { x: 0, y: 0, z: 6.9 };
    a.look = { yaw: 0, pitch: 0 };
    stepSim(world, state, { a1: press({ gadget: true }), d1: createInput() });
    check('a charge goes on over the wedge',
      state.doors.front.charge?.kind === 'charge' && state.doors.front.device?.kind === 'wedge',
      JSON.stringify([state.doors.front.charge?.kind, state.doors.front.device?.kind]));

    // And he does what a breacher does: flattens himself against the wall
    // beside the doorway, where the blast cannot see him.
    a.pos = { x: 2.5, y: 0, z: 6.5 };
    const dHp = d.health;
    for (let i = 0; i < TICK_RATE * 5 && !state.doors.front.broken; i++) {
      stepSim(world, state, { a1: press(), d1: createInput() });
    }
    check('the breach takes the wedged door with it',
      state.doors.front.broken && state.doors.front.device === null,
      JSON.stringify([state.doors.front.broken, state.doors.front.device]));
    const taken = dHp - d.health;
    check('and hurts the defender who was holding the room behind it',
      taken > 15 && taken < PLAYER.maxHealth, `${taken.toFixed(0)} damage`);
    check('while the man stacked on the wall beside it is untouched',
      a.health === PLAYER.maxHealth, `hp=${a.health.toFixed(0)}`);
  }

  // ── The flash: line of sight is the whole rule.
  {
    const { a, d } = atFrontDoor('flash');
    // Both of them out in the open on the landing, facing each other.
    a.pos = { x: 0, y: 0, z: 8.4 };
    d.pos = { x: 0, y: 0, z: 7.0 };
    d.look = { yaw: Math.PI, pitch: 0 };
    for (let i = 0; i < TICK_RATE * 3 && d.blind === 0; i++) {
      stepSim(world, state, {
        a1: press({ gadget: i === 0, pitch: -0.15 }),
        d1: { ...createInput(), yaw: Math.PI },
      });
    }
    check('a flash blinds whoever was looking at it', d.blind > 0.3, `blind=${d.blind.toFixed(2)}`);

    // And it burns off on its own.
    for (let i = 0; i < TICK_RATE * 6; i++) stepSim(world, state, { a1: createInput(), d1: createInput() });
    check('and it wears off', d.blind === 0, `blind=${d.blind.toFixed(2)}`);
  }

  // ── And what it costs the man who catches it square.
  //
  // The throw above lands where the physics puts it, which is the right test
  // for line of sight and the wrong one for timing. This one pops a flash two
  // metres in front of a man looking straight at it, which is the worst case
  // and the one the kit advertises.
  {
    const { d } = atFrontDoor('flash');
    // Out on the landing with nothing between the two of them: two metres
    // closer to the door and the panel itself would take the flash.
    d.pos = { x: 0, y: 0, z: 8.6 };
    d.look = { yaw: 0, pitch: 0 };
    const eye = eyePosition(d);
    state.throwables.push({
      kind: 'flash', by: 'a1', team: 'attackers',
      pos: { x: eye.x, y: eye.y, z: eye.z - 1.5 },
      vel: { x: 0, y: 0, z: 0 },
      fuse: 0.001,
    });
    stepSim(world, state, { a1: createInput(), d1: createInput() });
    check('one square in the eyes whites the screen out', d.blind > 1,
      `blind=${d.blind.toFixed(2)}`);

    let white = 0;
    let ticks = 0;
    for (let i = 0; i < TICK_RATE * 12 && d.blind > 0; i++) {
      if (d.blind >= 1) white++;
      ticks++;
      stepSim(world, state, { a1: createInput(), d1: createInput() });
    }
    const seconds = ticks / TICK_RATE;
    check('and costs the seconds the kit says it costs',
      seconds > GADGETS.flash.blind - 0.4 && seconds < GADGETS.flash.blind + 0.4,
      `${seconds.toFixed(1)} s of ${GADGETS.flash.blind}`);
    check('the first of which are blind ones', white / TICK_RATE > 1.2,
      `${(white / TICK_RATE).toFixed(1)} s of white`);
  }

  // ── Smoke: a cloud nobody sees through, bots included.
  {
    restartRound();
    setGadget(state, 'a1', 'smoke');
    state.phase = 'live';
    state.phaseTime = 120;
    const a = state.players.a1;
    a.pos = { x: -9, y: 0, z: -7 };
    const yaw = -Math.PI / 2;
    a.look = { yaw, pitch: 0 };
    const from = { x: -9, y: 1.4, z: -7 };
    const to = { x: -3, y: 1.4, z: -7 };
    check('the line is clear to start with', hasLineOfSight(world, state, from, to));

    for (let i = 0; i < TICK_RATE * 4 && state.smokes.length === 0; i++) {
      stepSim(world, state, { a1: { ...createInput(), yaw, gadget: i === 0 }, d1: createInput() });
    }
    check('the can pops into a cloud', state.smokes.length === 1, `${state.smokes.length} clouds`);
    for (let i = 0; i < TICK_RATE * 3; i++) stepSim(world, state, { a1: createInput(), d1: createInput() });
    check('and nothing sees through it', !hasLineOfSight(world, state, from, to));

    for (let i = 0; i < TICK_RATE * 20; i++) stepSim(world, state, { a1: createInput(), d1: createInput() });
    check('it thins out and goes', state.smokes.length === 0 && hasLineOfSight(world, state, from, to));
  }

  // ── The mains, and the two answers to them.
  //
  // Everything here hangs together: the breaker is only worth throwing because
  // the attackers can see without it, the tube is only beatable because a
  // flare exists, and a flare is only worth spending because the flat is dark.
  // So the checks walk that whole chain in order.
  {
    console.log('\nThe lights, the tube and the flare:');
    restartRound();
    state.phase = 'live';
    state.phaseTime = 300;
    const a = state.players.a1;
    const d = state.players.d1;
    check('the flat starts with its lights on', state.power === true);

    // Standing on the terrace, in front of the cabinet, looking at it.
    const atPanel = () => {
      a.pos = { x: -14.55, y: 3.3, z: -8.4 };
      a.look = { yaw: Math.PI, pitch: 0 };
      a.useCooldown = 0;
    };
    // ...and standing in the same room with your back to it.
    atPanel();
    a.look = { yaw: 0, pitch: 0 };
    stepSim(world, state, { a1: { ...createInput(), use: true, yaw: 0 }, d1: createInput() });
    check('facing away from it does nothing', state.power === true);

    atPanel();
    stepSim(world, state, {
      a1: { ...createInput(), use: true, yaw: Math.PI }, d1: createInput(),
    });
    check('reaching it and pressing F kills the power', state.power === false);
    const bang = state.events.find((e) => e.type === 'power');
    check('and it is not a quiet thing to do', !!bang && bang.on === false,
      JSON.stringify(bang));

    d.pos = { x: 0, y: 0, z: 4 };
    d.useCooldown = 0;
    stepSim(world, state, { a1: createInput(), d1: { ...createInput(), use: true } });
    check('nobody works it from another floor', state.power === false);

    // ── The tube. It is a kit choice like any other, so it has to be picked
    // before it is in anyone's hands — and picking it costs the flashbangs.
    check('night vision is on the attackers\' kit list', GADGETS.nvg.team === 'attackers');
    check('a defender cannot take it', setGadget(state, 'd1', 'nvg') === false);
    state.phase = 'prep';
    check('an attacker can', setGadget(state, 'a1', 'nvg') === true);
    check('and it replaces what he was carrying', a.gadget === 'nvg', a.gadget);
    state.phase = 'live';

    a.gadgetCooldown = 0;
    a.gadgetDown = false;
    stepSim(world, state, { a1: { ...createInput(), gadget: true }, d1: createInput() });
    check('the tube goes down on the same key as everything else', a.nvg === true);
    check('and wearing it spends nothing', a.gadgetLeft === GADGETS.nvg.count,
      `${a.gadgetLeft}`);
    a.useCooldown = 0;
    stepSim(world, state, { a1: { ...createInput(), toggleLight: true }, d1: createInput() });
    check('the torch pushes it back up', a.nvg === false && a.flashlight === true);
    a.gadgetCooldown = 0;
    a.gadgetDown = false;
    stepSim(world, state, { a1: { ...createInput(), gadget: true }, d1: createInput() });
    check('pulling it down again puts the torch out', a.nvg === true && a.flashlight === false);

    // ── The flare, picked the same way.
    const flares = () => state.throwables.filter((t) => t.kind === 'flare');
    state.phase = 'prep';
    check('flares are on the defenders\' list', setGadget(state, 'd1', 'flare') === true);
    check('and an attacker cannot take them', setGadget(state, 'a1', 'flare') === false);
    state.phase = 'live';
    d.pos = { x: -9, y: 0, z: -7 };
    d.look = { yaw: -Math.PI / 2, pitch: 0 };
    d.gadgetCooldown = 0;
    d.gadgetDown = false;
    const had = d.gadgetLeft;
    stepSim(world, state, {
      a1: createInput(), d1: { ...createInput(), gadget: true, yaw: -Math.PI / 2 },
    });
    check('the defender lights a flare on the same key', flares().length === 1);
    check('and it comes out of a pocket that empties', d.gadgetLeft === had - 1,
      `${d.gadgetLeft} of ${had}`);

    for (let i = 0; i < TICK_RATE * 2; i++) {
      stepSim(world, state, { a1: createInput(), d1: createInput() });
    }
    const burning = flares()[0];
    check('it lands and lies there burning', !!burning && burning.fuse > GADGETS.flare.fuse - 3,
      burning ? `${burning.fuse.toFixed(1)} s left` : 'gone');
    check('the floor around it counts as lit', litByFlare(state, burning.pos));
    check('and the next room does not',
      !litByFlare(state, { x: burning.pos.x + FLARE.radius + 2, y: 1, z: burning.pos.z }));

    // ── And the one beats the other.
    a.pos = { x: burning.pos.x + 2, y: 0, z: burning.pos.z };
    a.blind = 0;
    stepSim(world, state, { a1: createInput(), d1: createInput() });
    check('a tube pointed at a burning flare washes out', a.blind > 0.2,
      a.blind.toFixed(2));
    a.pos = { x: 6, y: 0, z: 4 };
    a.blind = 0;
    stepSim(world, state, { a1: createInput(), d1: createInput() });
    check('and walking away from it clears', a.blind === 0, a.blind.toFixed(2));

    // ── A flare is spent, not stored.
    burning.fuse = 0.01;
    stepSim(world, state, { a1: createInput(), d1: createInput() });
    check('a flare that has burned through is gone', flares().length === 0);

    // ── And a new round turns the lights back on.
    resetRound(world, state);
    check('a new round restores the power', state.power === true);
    check('takes the tube off', state.players.a1.nvg === false);
    check('and hands the flares back',
      state.players.d1.gadgetLeft === GADGETS.flare.count,
      `${state.players.d1.gadgetLeft}`);
    check('the kit choice itself survives the round',
      state.players.a1.gadget === 'nvg' && state.players.d1.gadget === 'flare');
  }

  // ── Bots stage themselves, or the solo player never meets any of this.
  //
  // This runs on its own world: a session builds one, and the point of the
  // check is the whole loop — kit handed out, staging walked, doors fitted.
  {
    // Three of them, because the kit list is no longer all door fittings: one
    // wires, one carries flares for the dark, one wedges.
    const solo = createLocalSession({ map: APARTMENT, bots: 3 });
    const idle = createInput();
    for (let i = 0; i < TICK_RATE * (ROUND.selectTime + ROUND.prepTime) && solo.state.phase !== 'live'; i++) {
      solo.tick(idle);
    }
    const fitted = Object.values(solo.state.doors).filter((d) => d.device).map((d) => d.device.kind);
    check('the defenders fit their kit before the round starts', fitted.length >= 2,
      fitted.join(', '));
    check('and one of them wires a doorway', fitted.includes('trap'), fitted.join(', '));

    // And the one holding flares does nothing with them until the lights go —
    // then lights one, without being told where.
    const flareBot = Object.values(solo.state.players).find((p) => p.gadget === 'flare');
    check('one of them came with flares instead', !!flareBot, flareBot?.gadget);
    const lit = () => solo.state.throwables.filter((t) => t.kind === 'flare').length;
    for (let i = 0; i < TICK_RATE * 3; i++) solo.tick(idle);
    check('and holds on to them while the lights are on', lit() === 0);
    solo.state.power = false;
    for (let i = 0; i < TICK_RATE * 3 && lit() === 0; i++) solo.tick(idle);
    check('cutting the power is what makes it strike one', lit() >= 1, `${lit()} burning`);
  }

  // ── A new round clears the flat.
  {
    const { d } = atFrontDoor('wedge');
    stepSim(world, state, { d1: press({ gadget: true }), a1: createInput() });
    check('the device is really on the door before the round ends',
      state.doors.front.device?.kind === 'wedge');
    resetRound(world, state);
    const anyDevice = Object.values(state.doors).some((ds) => ds.device || ds.charge);
    check('a new round takes every device off every door', !anyDevice);
    check('and hands the kit back', d.gadgetLeft === GADGETS[d.gadget].count,
      `${d.gadgetLeft}/${GADGETS[d.gadget].count}`);
  }

  restartRound();
  setLoadout(state, 'a1', DEFAULT_WEAPON);
}

// ── What each weapon shoots through ───────────────────────────────────────
//
// Not arithmetic about the table — a man stood behind a slab, and a shot fired
// at him. Every weapon against every surface the flat is built from, on a
// range with one wall in the middle of it.
{
  console.log('\nThrough the wall:');

  // Every surface says both things, or it is quietly using a default for one
  // of them: what it costs to cross, and what it takes out of the round.
  {
    const bad = Object.values(MATERIALS)
      .filter((m) => m.resist > 0 && !(m.soak > 0))
      .map((m) => m.name);
    check('anything you can shoot through says what it takes out of the round',
      bad.length === 0, bad.join(', '));
  }

  function range(material, thickCm) {
    const t = thickCm / 100;
    return {
      geometry: [
        { min: { x: -6, y: -0.5, z: -4 }, max: { x: 6, y: 0, z: 4 }, material: MATERIALS.floor },
        { min: { x: -t / 2, y: 0, z: -3 }, max: { x: t / 2, y: 3, z: 3 }, material: MATERIALS[material] },
      ],
      doors: [], lights: [], switches: [],
      spawns: { attackers: [{ x: -3, z: 0 }], defenders: [{ x: 3, z: 0 }] },
      bounds: { min: { x: -6, y: 0, z: -4 }, max: { x: 6, y: 3, z: 4 } },
    };
  }

  // Fire a handful of rounds down the range and report what arrived at the far
  // side. A handful rather than one: every weapon has a cone, and a single
  // round that clips a head instead of a chest makes a ratio that means
  // nothing. Summed over six, the pattern averages out.
  function through(w, weaponId) {
    const s = createState(w, 7);
    addPlayer(w, s, 'a', 'attackers', 'A');
    addPlayer(w, s, 'd', 'defenders', 'D');
    setLoadout(s, 'a', weaponId);
    s.phase = 'live';
    s.phaseTime = 300;
    const a = s.players.a;
    const d = s.players.d;
    a.pos = { x: -2, y: 0, z: 0 };
    d.pos = { x: 2, y: 0, z: 0 };
    a.look = { yaw: -Math.PI / 2, pitch: 0 };
    let dmg = 0;
    for (let i = 0; i < 60; i++) {
      // Every weapon here fires as fast as the range lets it, pump gun
      // included, so the count is the same for all of them.
      const shoot = i % 8 === 3;
      if (shoot) a.weapon.cooldown = 0;
      a.recoil = { pitch: 0, yaw: 0 };
      stepSim(w, s, {
        a: { ...createInput(), fire: shoot, aim: true, yaw: -Math.PI / 2, pitch: 0 },
        d: createInput(),
      }, 1 / TICK_RATE);
      for (const ev of s.events) if (ev.type === 'hit' && ev.targetId === 'd') dmg += ev.damage;
      d.health = PLAYER.maxHealth;
      d.alive = true;
    }
    return dmg;
  }

  const ROSTER = Object.keys(WEAPONS);
  const SMGS = ROSTER.filter((id) => WEAPONS[id].cls === 'smg');
  const RIFLES = ROSTER.filter((id) => WEAPONS[id].cls === 'rifle');
  const SHOTGUNS = ROSTER.filter((id) => WEAPONS[id].cls === 'shotgun');
  // One bullet each, and no one-shot ceiling: the weapons whose arriving
  // damage can be compared with a clean hit without the pellet pattern or the
  // .50's own cap getting in the way.
  const PLAIN = ROSTER.filter((id) => WEAPONS[id].pellets === 1 && !WEAPONS[id].oneShot);

  const at = (material, cm) => {
    const w = buildWorld(range(material, cm));
    return Object.fromEntries(ROSTER.map((id) => [id, through(w, id)]));
  };

  {
    const concrete = at('concrete', 15);
    check('the building itself stops everything, the .50 included',
      ROSTER.every((id) => concrete[id] === 0),
      ROSTER.filter((id) => concrete[id] > 0).join(', '));
  }

  // The same shot down an empty range, for everything else to be measured
  // against.
  const bare = range('drywall', 12);
  const open = buildWorld({ ...bare, geometry: [bare.geometry[0]] });
  const clean = Object.fromEntries(ROSTER.map((id) => [id, through(open, id)]));

  {
    const glass = at('glass', 10);
    // A railing is not cover: everything goes through a pane, and hardly
    // anything is lost on the way.
    check('glass stops nothing — buckshot included',
      ROSTER.every((id) => glass[id] > 0),
      ROSTER.filter((id) => glass[id] === 0).join(', '));
    const worst = Math.min(...PLAIN.map((id) => glass[id] / clean[id]));
    check('and a pane barely weakens the round', worst > 0.85,
      `worst case keeps ${(worst * 100).toFixed(0)}%`);
  }

  {
    // A wall is cover. One weapon in the building disagrees.
    const wall = at('drywall', 12);
    check('an interior wall is only beaten by the .50',
      wall['amr-50'] > 0 && ROSTER.filter((id) => wall[id] > 0).length === 1,
      ROSTER.filter((id) => wall[id] > 0).join(', '));
    check('and even that arrives as a hard hit rather than a kill',
      wall['amr-50'] < clean['amr-50'],
      `${wall['amr-50'].toFixed(0)} of ${clean['amr-50'].toFixed(0)}`);
  }

  {
    // A door is not cover — it is a thing you shoot through and pay for.
    const door = at('wood', 6);
    check('everything on the roster shoots through a closed door',
      ROSTER.every((id) => door[id] > 0),
      ROSTER.filter((id) => door[id] === 0).join(', '));
    const kept = PLAIN.map((id) => door[id] / clean[id]);
    check('...and everything pays for it', Math.max(...kept) < 0.9,
      `best case keeps ${(Math.max(...kept) * 100).toFixed(0)}%`);
    // Compared weapon against itself, because the .50 and the heavier rifles
    // have their clean headshots clipped by the one-hit ceiling and a ratio
    // against those means nothing.
    const glassAgain = at('glass', 10);
    const worse = PLAIN.filter((id) => door[id] >= glassAgain[id]);
    check('and a door costs a round more than a pane does', worse.length === 0,
      worse.join(', '));
  }

  {
    const locker = at('metal', 16);
    check('a steel locker is only beaten by the .50',
      locker['amr-50'] > 0 && ROSTER.filter((id) => locker[id] > 0).length === 1,
      ROSTER.filter((id) => locker[id] > 0).join(', '));
    // Half a metre of wardrobe is not a door, even though it is the same wood.
    const wardrobe = at('wood', 30);
    check('a wardrobe stops every submachine gun but the PDW',
      SMGS.filter((id) => wardrobe[id] > 0).join(',') === 'smg-57-pdw',
      SMGS.filter((id) => wardrobe[id] > 0).join(', '));
    check('and what gets through it is nearly spent',
      wardrobe['ar-556-piston'] < clean['ar-556-piston'] * 0.35,
      `${wardrobe['ar-556-piston'].toFixed(0)} of ${clean['ar-556-piston'].toFixed(0)}`);
  }

  {
    // Upholstery is not cover: through the back of a sofa is nearly free.
    const cushion = at('fabric', 15);
    check('a sofa back hides you and stops nothing but buckshot',
      SMGS.every((id) => cushion[id] > 0) && RIFLES.every((id) => cushion[id] > 0)
        && SHOTGUNS.every((id) => cushion[id] === 0),
      `${SMGS.filter((id) => !cushion[id]).join(', ')} ${SHOTGUNS.filter((id) => cushion[id]).join(', ')}`);
  }
}

// ── Things that stand at an angle ─────────────────────────────────────────
//
// A box in this map used to be a pair of corners, and a pair of corners has no
// angle in it: every table, sofa and bed in the flat stood square to the
// building. Now a box may be turned about its own centre, and the claim worth
// testing is that the whole engine believes it — the bullet, the boot, and the
// graph the bots walk — rather than just the picture.
{
  console.log('\nTurned boxes:');

  // A room with one wall through the middle of it, at forty-five degrees.
  const room = (yaw) => {
    const wall = turnBox({
      min: { x: -2, y: 0, z: -0.1 }, max: { x: 2, y: 2.4, z: 0.1 },
      material: MATERIALS.concrete,
    }, yaw);
    return {
      geometry: [
        { min: { x: -6, y: -0.5, z: -6 }, max: { x: 6, y: 0, z: 6 }, material: MATERIALS.floor },
        wall,
      ],
      doors: [], lights: [], switches: [],
      spawns: { attackers: [{ x: -4, z: -4 }], defenders: [{ x: 4, z: 4 }] },
      bounds: { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 2.4, z: 6 } },
    };
  };
  const turnedWorld = buildWorld(room(Math.PI / 4));

  {
    // Straight across the middle: the wall is there, so the round stops.
    const across = raycastGeometry(turnedWorld, createState(turnedWorld, 1),
      { x: -3, y: 1, z: 3 }, { x: 0.7071, y: 0, z: -0.7071 }, 12);
    check('a round stops at a wall standing at an angle',
      across.some((h) => h.material.name === 'concrete'), `${across.length} hits`);

    // ...and through the corner of the square the wall's bounds occupy, where
    // there is nothing but air. This is the difference between understanding
    // the shape and understanding the box round it.
    const corner = raycastGeometry(turnedWorld, createState(turnedWorld, 1),
      { x: -2.6, y: 1, z: -2.2 }, { x: 1, y: 0, z: 0 }, 12);
    check('...and passes through the empty corner of its bounds',
      !corner.some((h) => h.material.name === 'concrete'), `${corner.length} hits`);
  }

  {
    // Walking into it at an angle. The old resolution could only give a man
    // back his x or his z, so on a wall at forty-five degrees he stopped dead;
    // the point of the circle is that he slides along it instead.
    const s = createState(turnedWorld, 3);
    addPlayer(turnedWorld, s, 'a', 'attackers', 'A');
    s.phase = 'live';
    s.phaseTime = 300;
    const a = s.players.a;
    // The wall runs from (-1.4, 1.4) to (1.4, -1.4), so its two sides are
    // where x + z is negative and where it is positive. He starts on the
    // negative side and walks straight at it.
    a.pos = { x: -1.5, y: 0, z: -1.5 };
    for (let i = 0; i < 90; i++) {
      stepSim(turnedWorld, s, { a: { ...createInput(), moveZ: 1, yaw: -Math.PI * 0.75 } }, 1 / TICK_RATE);
    }
    check('a man cannot walk through it', a.pos.x + a.pos.z < 0,
      `ended at (${a.pos.x.toFixed(2)}, ${a.pos.z.toFixed(2)})`);
    check('...and is left standing clear of it, not inside',
      !turnedWorld.boxes.some((b) => pointInBox(b, a.pos.x, a.pos.y + 1, a.pos.z)));

    // Now the same wall, taken at a glancing angle: he should travel along it.
    const s2 = createState(turnedWorld, 4);
    addPlayer(turnedWorld, s2, 'b', 'attackers', 'B');
    s2.phase = 'live';
    s2.phaseTime = 300;
    const b = s2.players.b;
    // Started where the wall is long, so what is measured is the slide and
    // not him strolling round the end of it.
    b.pos = { x: 0.6, y: 0, z: -2.5 };
    const from = { x: b.pos.x, z: b.pos.z };
    for (let i = 0; i < 120; i++) {
      stepSim(turnedWorld, s2, { a: createInput(), b: { ...createInput(), moveZ: 1, yaw: Math.PI } }, 1 / TICK_RATE);
    }
    // Pushed due north into a wall lying across his path at forty-five
    // degrees: what he gets is a slide along it, which shows up as movement in
    // x that he never asked for.
    const slid = Math.abs(b.pos.x - from.x);
    check('and slides along it rather than sticking to it', slid > 0.8,
      `slid ${slid.toFixed(2)} m sideways`);
  }

  {
    // The bots' graph has to know the difference too: the corners of the
    // square the wall's bounds occupy are floor, and a bot may stand on them.
    const nav = turnedWorld.nav;
    const corner = nearestNode(nav, { x: -1.7, y: 0, z: -1.7 }, 0.5);
    check('the walkable graph leaves the empty corners walkable', corner >= 0
      && Math.hypot(nodePos(nav, corner).x + 1.7, nodePos(nav, corner).z + 1.7) < 0.5,
      corner >= 0 ? JSON.stringify(nodePos(nav, corner)) : 'no node');
    // ...and not one standing place in the whole room is inside the wall.
    const wall = turnedWorld.boxes.find((x) => x.yaw);
    let inWall = 0;
    for (let n = 0; n < nav.count; n++) {
      if (pointInBox(wall, nav.x[n], nav.y[n] + 0.1, nav.z[n])) inWall++;
    }
    check('and not one standing place in it is inside the wall', inWall === 0, `${inWall} of ${nav.count}`);
  }
}

// ── Bots that walk the flat ───────────────────────────────────────────────
//
// The three claims worth holding onto: there is a route between any two places
// a man can stand, a bot uses it, and what a bot knows it could actually have
// found out. Everything here runs the simulation and looks at what came out —
// there is no way to assert "feels alive", but "left the room it spawned in"
// and "did not spend the round leaning on a wall" are checkable.
{
  console.log('\nBots:');

  const nav = world.nav;
  check('the building has a map of where a man can stand', nav && nav.liveCount > 2000,
    `${nav?.liveCount} standing places`);

  // Both storeys, and the stairs between them, or half the flat is unreachable.
  let ground = 0;
  let upper = 0;
  for (let n = 0; n < nav.count; n++) {
    if (!nav.live[n]) continue;
    if (nav.y[n] < 0.5) ground++;
    else if (nav.y[n] > 3.0) upper++;
  }
  check('both storeys are in it', ground > 800 && upper > 800, `${ground} down, ${upper} up`);

  {
    const from = nearestNode(nav, { ...APARTMENT.spawns.attackers[0], y: 0 });
    const d = APARTMENT.spawns.defenders[0];
    const to = nearestNode(nav, { x: d.x, y: d.y, z: d.z });
    const path = findPath(nav, from, to);
    check('there is a way from the front door to the defenders\' room', !!path,
      `${path?.length} steps`);
    const climbs = path?.some((n) => nav.y[n] > 1 && nav.y[n] < 3);
    check('and it goes up the stairs rather than through the ceiling', !!climbs);

    // Every step of the raw route is one cell of walking, and straightening it
    // keeps both ends where they were.
    let worst = 0;
    for (let i = 1; i < path.length; i++) {
      worst = Math.max(worst, Math.hypot(nav.x[path[i]] - nav.x[path[i - 1]],
        nav.z[path[i]] - nav.z[path[i - 1]]));
    }
    check('no step of it is a leap', worst < nav.cell * 1.5, `${worst.toFixed(2)} m`);
    const smooth = smoothPath(nav, path);
    check('straightening it keeps both ends', smooth[0] === path[0]
      && smooth[smooth.length - 1] === path[path.length - 1]);
    check('and makes it far fewer corners', smooth.length < path.length / 3,
      `${smooth.length} of ${path.length}`);
  }

  // ── A round with nobody to shoot at ──
  //
  // Four bots, one man who never moves and never makes a sound. That is the
  // case bots used to fail completely: nothing to react to, so nothing done.
  function runRound(seconds, noisy) {
    const w = buildWorld(APARTMENT);
    const s = createState(w, 909);
    addPlayer(w, s, 'man', 'attackers', 'Man');
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const id = `b${i}`;
      addPlayer(w, s, id, 'defenders', id);
      setGadget(s, id, ['trap', 'flare', 'wedge', 'alarm'][i]);
      ids.push(id);
    }
    const brain = createBotBrain(77);
    const man = s.players.man;
    const seen = new Map(ids.map((id) => [id, new Set()]));
    const still = new Map(ids.map((id) => [id, 0]));
    // The closest anybody got to the man all round, which is the question
    // "did somebody come and look" — where they happen to be standing on the
    // last frame is not.
    let closest = Infinity;
    // How restless they ever got. Asking at the final frame is asking whether
    // they happened to be restless at one arbitrary moment — and a side that
    // has just seen somebody is not restless, which is the point.
    let restless = 0;
    const was = new Map();
    const input = createInput();
    for (let i = 0; i < seconds * TICK_RATE; i++) {
      input.moveZ = noisy ? (Math.sin(s.time * 0.4) > 0 ? 1 : -1) : 0;
      input.run = noisy;
      const inputs = { man: input };
      for (const id of ids) inputs[id] = brain.think(w, s, s.players[id], 1 / TICK_RATE);
      stepSim(w, s, inputs, 1 / TICK_RATE);
      // The man is a training dummy: he never dies, so the round never ends.
      man.health = PLAYER.maxHealth;
      man.alive = true;
      if (s.phase === 'live' && s.phaseTime < 30) s.phaseTime = 400;
      restless = Math.max(restless, brain.squads.get('defenders')?.pressure ?? 0);
      for (const id of ids) {
        const p = s.players[id];
        p.alive = true;
        p.health = PLAYER.maxHealth;
        closest = Math.min(closest, Math.hypot(p.pos.x - man.pos.x, p.pos.z - man.pos.z));
        seen.get(id).add(`${Math.round(p.pos.x / 3)}:${Math.round(p.pos.y / 3)}:${Math.round(p.pos.z / 3)}`);
        const prev = was.get(id);
        const moved = prev ? Math.hypot(p.pos.x - prev.x, p.pos.z - prev.z) : 9;
        // Walking on the spot for a solid stretch is the failure this is here
        // to catch: rocking between two waypoints covers ground and arrives
        // nowhere, so what is counted is progress, not distance.
        if (i % 30 === 0) {
          still.set(id, moved < 0.25 ? still.get(id) + 0.5 : 0);
          was.set(id, { x: p.pos.x, z: p.pos.z });
        }
      }
    }
    return { world: w, state: s, ids, brain, seen, still, man, closest, restless };
  }

  {
    const quiet = runRound(110, false);
    const rooms = quiet.ids.map((id) => quiet.seen.get(id).size);
    check('with nothing to react to, every bot still leaves the room it woke in',
      Math.min(...rooms) > 6, `rooms visited: ${rooms.join(', ')}`);
    check('and between them they walk most of the building',
      new Set(quiet.ids.flatMap((id) => [...quiet.seen.get(id)])).size > 30,
      `${new Set(quiet.ids.flatMap((id) => [...quiet.seen.get(id)])).size} parts`);
    const worst = Math.max(...quiet.ids.map((id) => quiet.still.get(id)));
    check('none of them spends the round leaning on a wall', worst < 30,
      `${worst.toFixed(0)} s without progress`);

    // A quiet enemy is the thing that makes a side restless.
    check('a silent enemy makes the side go looking', quiet.restless > 0.5,
      quiet.restless.toFixed(2));
  }

  {
    // ...and a loud one makes them stop looking and start watching.
    const loud = runRound(110, true);
    const squad = loud.brain.squads.get('defenders');
    check('a noisy one gives them something to hold instead', squad.pressure < 0.4,
      squad.pressure.toFixed(2));
    check('and they have him placed roughly right', squad.contacts.length > 0
      && Math.hypot(squad.contacts[squad.contacts.length - 1].pos.x - loud.man.pos.x,
        squad.contacts[squad.contacts.length - 1].pos.z - loud.man.pos.z) < 12,
      `${squad.contacts.length} contacts`);
    check('somebody has come to find out what the noise was', loud.closest < 12,
      `closest anybody got: ${loud.closest.toFixed(0)} m`);
  }

  // ── Shooting the cloud ──
  //
  // A man who walks behind smoke in front of a bot that was already looking at
  // him gets shot at. A cloud nobody was seen going into does not.
  function duel(withContact) {
    const w = buildWorld(APARTMENT);
    const s = createState(w, 31);
    addPlayer(w, s, 'man', 'attackers', 'Man');
    addPlayer(w, s, 'bot', 'defenders', 'Bot');
    s.phase = 'live';
    s.phaseTime = 300;
    const man = s.players.man;
    const bot = s.players.bot;
    // Facing each other across the defenders' room, four metres apart.
    man.pos = { x: 0.2, y: 3.3, z: -13.6 };
    bot.pos = { x: 0.2, y: 3.3, z: -16.6 };
    bot.look = { yaw: Math.PI, pitch: 0 };
    const brain = createBotBrain(5);
    const input = createInput();
    let before = 0;
    let after = 0;
    let popped = false;
    for (let i = 0; i < 8 * TICK_RATE; i++) {
      // Hide the man from the start when the point is that nobody saw him.
      if (!withContact) man.alive = i < 1;
      const bi = brain.think(w, s, bot, 1 / TICK_RATE);
      if (bi.fire) { if (popped) after++; else before++; }
      stepSim(w, s, { man: input, bot: bi }, 1 / TICK_RATE);
      man.health = PLAYER.maxHealth;
      if (withContact) man.alive = true;
      if (!popped && s.time > 2) {
        s.smokes.push({
          pos: { x: 0.2, y: 4.3, z: -15.1 }, radius: 3.5, grown: 1, growTime: 2.5, left: 16,
        });
        popped = true;
      }
    }
    return { before, after, ammo: bot.weapon.ammo };
  }

  {
    const saw = duel(true);
    check('a bot shoots a man it can see', saw.before > 4, `${saw.before} shots`);
    check('and keeps shooting when he steps behind smoke', saw.after > 4,
      `${saw.after} shots into the cloud`);
    check('but gives up on the guess before it empties itself', saw.ammo > 6,
      `${saw.ammo} rounds left`);

    const blind = duel(false);
    check('a cloud nobody was seen going into is not worth a round',
      blind.after === 0, `${blind.after} shots`);
  }

  // ── Ears that are only ears ──
  //
  // The same faint noise, over and over, from the same place. Some of them are
  // missed, and the ones that land are placed in the wrong part of the room —
  // otherwise hearing would just be seeing with extra steps.
  {
    const w = buildWorld(APARTMENT);
    const s = createState(w, 5);
    addPlayer(w, s, 'man', 'attackers', 'Man');
    addPlayer(w, s, 'bot', 'defenders', 'Bot');
    s.phase = 'live';
    s.phaseTime = 300;
    const man = s.players.man;
    const bot = s.players.bot;
    man.pos = { x: 0.2, y: 3.3, z: -13.6 };
    bot.pos = { x: 0.2, y: 3.3, z: -16.6 };
    man.alive = false; // heard, never seen
    const brain = createBotBrain(3);
    let heard = 0;
    let missed = 0;
    let worstError = 0;
    let totalError = 0;
    const b = () => brain.memory.get('bot');
    for (let i = 0; i < 200; i++) {
      const known = b()?.sound?.at ?? -1;
      // A footstep at the far edge of what carries.
      s.events.push({ type: 'noise', pos: { ...man.pos }, radius: 9, kind: 'step', by: 'man' });
      brain.think(w, s, bot, 1 / TICK_RATE);
      s.events.length = 0;
      s.time += 1.5; // well apart, so each is judged on its own
      const now = b().sound;
      if (now && now.at !== known) {
        heard++;
        const err = Math.hypot(now.pos.x - man.pos.x, now.pos.z - man.pos.z);
        worstError = Math.max(worstError, err);
        totalError += err;
      } else {
        missed++;
      }
    }
    check('a faint footstep is sometimes missed altogether', missed > 10 && heard > 40,
      `${heard} heard, ${missed} missed`);
    const mean = totalError / Math.max(1, heard);
    check('and the ones that land are placed by the room, not by the metre',
      mean > 0.8 && mean < 4, `${mean.toFixed(1)} m out on average`);
    check('never so far out that it points at another flat', worstError < 8,
      `worst ${worstError.toFixed(1)} m`);
  }
}

// ── Choosing a weapon ─────────────────────────────────────────────────────
//
// Beyond the numbers: that the choice is refused when it should be, that it
// really lands in the player's hands, and that it survives into the next round.
{
  console.log('\nWeapon selection:');

  const ids = Object.keys(WEAPONS);
  check('the roster is the eleven blueprint sheets, three-three-three-two',
    ids.length === 11 && WEAPON_CLASSES.length === 4 &&
    [3, 3, 3, 2].every((n, i) =>
      ids.filter((id) => WEAPONS[id].cls === WEAPON_CLASSES[i].id).length === n),
    ids.map((id) => `${id}:${WEAPONS[id].cls}`).join(' '));
  check('no entry carries a manufacturer name or model number',
    !ids.some((id) => /mp5|ak|m4|glock|colt|hk|scar|vector|remington|barrett|saiga/i.test(id + WEAPONS[id].name)),
    ids.join(' '));

  resetRound(world, state);
  check('a round opens at the loadout screen',
    state.phase === 'select' && Math.abs(state.phaseTime - ROUND.selectTime) < 1e-9,
    `phase=${state.phase} t=${state.phaseTime}`);
  check('everyone starts with the default weapon',
    attacker.weapon.id === DEFAULT_WEAPON && attacker.loadout === DEFAULT_WEAPON,
    `${attacker.loadout}/${attacker.weapon.id}`);

  // Nobody moves while the screen is up: full-ahead input, half a second of it.
  const before = { x: attacker.pos.x, z: attacker.pos.z };
  for (let i = 0; i < 30; i++) {
    stepSim(world, state, {
      a1: { ...createInput(), moveZ: -1, run: true, fire: true, jump: true },
      d1: { ...createInput(), moveX: 1 },
    });
  }
  const drift = Math.hypot(attacker.pos.x - before.x, attacker.pos.z - before.z);
  check('nobody walks away from the loadout screen', drift < 1e-6, `moved ${drift.toFixed(3)} m`);
  check('the trigger is dead while choosing',
    attacker.weapon.ammo === WEAPONS[attacker.weapon.id].magSize, `ammo=${attacker.weapon.ammo}`);
  stepSim(world, state, { a1: { ...createInput(), yaw: 1.2, pitch: 0.3 } });
  check('looking around is still allowed', Math.abs(attacker.look.yaw - 1.2) < 1e-6,
    `yaw=${attacker.look.yaw}`);

  check('an unknown weapon is refused', setLoadout(state, 'a1', 'railgun') === false);
  check('the refusal left the old weapon alone', attacker.weapon.id === DEFAULT_WEAPON);

  check('a listed weapon is accepted', setLoadout(state, 'a1', 'amr-50') === true);
  check('the new weapon is in their hands', attacker.weapon.id === 'amr-50', attacker.weapon.id);
  check('it comes with a full magazine',
    attacker.weapon.ammo === WEAPONS['amr-50'].magSize &&
    attacker.weapon.reserve === WEAPONS['amr-50'].reserve,
    `${attacker.weapon.ammo}/${attacker.weapon.reserve}`);

  // Run the select phase out: it must hand over to staging, not to the round.
  for (let i = 0; i < Math.ceil(ROUND.selectTime * TICK_RATE) + 2; i++) stepSim(world, state, {});
  check('the loadout screen gives way to staging',
    state.phase === 'prep' && state.phaseTime > ROUND.prepTime - 1,
    `phase=${state.phase} t=${state.phaseTime.toFixed(2)}`);
  check('a late change of mind is still allowed while staging',
    setLoadout(state, 'a1', 'sg-12-pump') === true && attacker.weapon.id === 'sg-12-pump');

  for (let i = 0; i < Math.ceil(ROUND.prepTime * TICK_RATE) + 2; i++) stepSim(world, state, {});
  check('staging gives way to the round', state.phase === 'live', `phase=${state.phase}`);
  check('the attackers wait half a minute, not a whole one',
    ROUND.prepTime === 30, `prepTime=${ROUND.prepTime}`);
  check('no swapping weapons once the shooting starts',
    setLoadout(state, 'a1', 'smg-45-inline') === false && attacker.weapon.id === 'sg-12-pump',
    attacker.weapon.id);

  // Half a magazine gone, then a new round: the choice stays, the gun is new.
  attacker.weapon.ammo = 3;
  resetRound(world, state);
  check('the choice survives into the next round',
    attacker.loadout === 'sg-12-pump' && attacker.weapon.id === 'sg-12-pump',
    `${attacker.loadout}/${attacker.weapon.id}`);
  check('but the magazine is full again',
    attacker.weapon.ammo === WEAPONS['sg-12-pump'].magSize, `ammo=${attacker.weapon.ammo}`);
}

// ── A client's pick reaches the host ──────────────────────────────────────
//
// The host is the only authority on who carries what, so the round trip is
// worth a check of its own: drive a host session through the same seam the
// real transport plugs into and watch a guest's choice land.
{
  console.log('\nWeapon selection over the wire:');
  const handlers = {};
  const sent = [];
  const transport = {
    onPeerJoin: (f) => { handlers.join = f; },
    onPeerLeave: () => {},
    onMessage: (f) => { handlers.msg = f; },
    sendTo: (id, m) => sent.push([id, m]),
    broadcast: (m) => sent.push(['*', m]),
    close: () => {},
  };

  const host = createHostSession({ map: APARTMENT, name: 'Host', transport, seed: 7 });
  handlers.join('guest', { name: 'Guest' });
  const guest = host.state.players.guest;

  handlers.msg('guest', { t: 'loadout', id: 'sg-12-double' });
  check('a guest\'s pick lands on the host',
    guest.loadout === 'sg-12-double' && guest.weapon.id === 'sg-12-double', guest.weapon.id);

  handlers.msg('guest', { t: 'loadout', id: 'railgun' });
  check('the host refuses a weapon that does not exist', guest.weapon.id === 'sg-12-double');

  host.chooseWeapon('amr-50');
  check('the host can pick for itself', host.me.weapon.id === 'amr-50', host.me.weapon.id);

  sent.length = 0;
  for (let i = 0; i < 6; i++) host.tick(createInput(), 1 / 60);
  const snap = sent.map(([, m]) => m).find((m) => m.t === 'snap');
  check('the snapshot carries who is holding what',
    snap?.players?.guest?.loadout === 'sg-12-double'
      && snap.players.guest.weapon.id === 'sg-12-double',
    JSON.stringify(snap?.players?.guest?.loadout));
}

restartRound();
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
