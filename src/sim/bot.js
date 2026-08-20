// A simple opponent for solo training. Pure like the rest of the simulation,
// so if bots are ever wanted online they run on the server unchanged.
//
// The bot plays the way the map wants to be played: it holds an angle, reacts
// to sound, and pushes only when it has a reason to.

import { createInput, eyePosition, aimDirection } from './sim.js?v=45193364';
import { hasLineOfSight } from './world.js?v=45193364';
import { distXZ, clamp } from './math.js?v=45193364';
import { BLIND, GADGETS } from './constants.js?v=45193364';

// Indoors nobody picks a figure out of the gloom across the whole map.
const MAX_SIGHT = 24;

export function createBotBrain(seed = 7) {
  const memory = new Map(); // botId -> brain state

  function brainFor(id) {
    if (!memory.has(id)) {
      memory.set(id, {
        target: null,
        lastSeen: null,
        lastSeenAt: -99,
        heard: null,
        heardAt: -99,
        // Where the bot *thinks* a heard sound came from — deliberately off by
        // a couple of metres, so hearing you never doubles as seeing you.
        heardGuess: null,
        burst: 0,
        burstCooldown: 0,
        reactTimer: 0,
        aimError: { yaw: 0, pitch: 0 },
        errorTimer: 0,
        // The doorway this bot is on its way to fit something to, and how long
        // it has been trying. Cleared the moment the kit is on the door.
        errand: null,
        errandTime: 0,
        skip: new Set(),
        rnd: seed + id.length,
      });
    }
    return memory.get(id);
  }

  function rand(b) {
    b.rnd = (b.rnd * 1103515245 + 12345) & 0x7fffffff;
    return b.rnd / 0x7fffffff;
  }

  // Build the bot's input for this tick.
  function think(world, state, bot, dt) {
    const input = createInput();
    const b = brainFor(bot.id);
    input.yaw = bot.look.yaw;
    input.pitch = bot.look.pitch;
    if (!bot.alive) return input;

    // ── Staging: fit the kit ──
    //
    // Half of what a defender does happens before anyone is shot at, and a
    // flat where no door is ever wedged or wired is a flat with half its
    // defence missing. So: pick the nearest doorway that has nothing on it,
    // walk up to it, look at it, press the button — and then go back to
    // holding the room like any other tick.
    if (state.phase === 'prep' && bot.gadgetLeft > 0 && GADGETS[bot.gadget]?.kind === 'door') {
      const errand = fitKit(world, state, bot, b, input, dt);
      if (errand) return input;
    }

    // ── Perceive ──
    const eye = eyePosition(bot);
    let visible = null;
    let bestDist = Infinity;
    // A flashbang works on a bot exactly as it works on a player: while the
    // white is in its eyes it sees nothing and can only go by what it heard.
    const blinded = (bot.blind ?? 0) > BLIND.botThreshold;
    for (const p of Object.values(state.players)) {
      if (blinded) break;
      if (!p.alive || p.team === bot.team) continue;
      const theirEye = eyePosition(p);
      if (!hasLineOfSight(world, state, eye, theirEye)) continue;
      // Only within a believable cone — bots shouldn't see behind themselves.
      const dir = aimDirection(bot);
      const dx = theirEye.x - eye.x;
      const dy = theirEye.y - eye.y;
      const dz = theirEye.z - eye.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const facing = (dir.x * dx + dir.y * dy + dir.z * dz) / len;
      if (facing < 0.42) continue; // roughly a 130° field of view, like a person
      if (len > MAX_SIGHT) continue;
      if (len < bestDist) {
        bestDist = len;
        visible = { player: p, eye: theirEye, dist: len };
      }
    }

    // Hearing: noise events this tick.
    for (const ev of state.events) {
      if (ev.type !== 'noise' || ev.by === bot.id) continue;
      const src = state.players[ev.by];
      if (src && src.team === bot.team) continue;
      const d = distXZ(ev.pos, bot.pos);
      if (d > ev.radius) continue;
      b.heard = { ...ev.pos };
      b.heardAt = state.time;
      // A sound tells you roughly where, never exactly where. The further away
      // it was, the vaguer the guess.
      const vague = 1.2 + d * 0.25;
      b.heardGuess = {
        x: ev.pos.x + (rand(b) - 0.5) * 2 * vague,
        y: bot.pos.y + 1.2,
        z: ev.pos.z + (rand(b) - 0.5) * 2 * vague,
      };
    }

    if (visible) {
      b.lastSeen = { ...visible.eye };
      b.lastSeenAt = state.time;
      if (b.reactTimer <= 0 && b.target !== visible.player.id) {
        // Human reaction time: spotting a target, recognising it and pulling
        // the trigger is around half a second, not a single frame.
        b.reactTimer = 0.45 + rand(b) * 0.45;
      }
      b.target = visible.player.id;
    } else if (b.reactTimer > 0) {
      b.reactTimer = 0;
    }
    b.reactTimer = Math.max(0, b.reactTimer - dt);

    // ── Aim ──
    // What the bot aims at, in order of how much it actually knows:
    //   what it can see  >  where it last saw you  >  a guess from a sound.
    // The last two decay quickly, so a bot never tracks you through a wall.
    const aimAt = visible
      ? visible.eye
      : b.lastSeen && state.time - b.lastSeenAt < 1.2
        ? b.lastSeen
        : b.heardGuess && state.time - b.heardAt < 2.5
          ? b.heardGuess
          : null;

    if (aimAt) {
      // Wander the aim error so the bot isn't a laser.
      b.errorTimer -= dt;
      if (b.errorTimer <= 0) {
        b.errorTimer = 0.25 + rand(b) * 0.3;
        b.aimError.yaw = (rand(b) - 0.5) * 0.055;
        b.aimError.pitch = (rand(b) - 0.5) * 0.035;
      }

      const dx = aimAt.x - eye.x;
      const dy = aimAt.y - eye.y;
      const dz = aimAt.z - eye.z;
      const wantYaw = Math.atan2(-dx, -dz) + b.aimError.yaw;
      const wantPitch = Math.atan2(dy, Math.hypot(dx, dz)) + b.aimError.pitch;

      // Turning onto a target you can see is brisk; swinging toward a noise is
      // a slow, searching movement.
      const turnRate = visible ? 4.5 : 1.8;
      input.yaw = turnToward(bot.look.yaw, wantYaw, turnRate * dt);
      input.pitch = bot.look.pitch + clamp(wantPitch - bot.look.pitch, -turnRate * dt, turnRate * dt);
    }

    // ── Shoot ──
    b.burstCooldown = Math.max(0, b.burstCooldown - dt);
    if (visible && b.reactTimer <= 0 && b.burstCooldown <= 0) {
      // Only fire once roughly on target.
      const dir = aimDirection(bot);
      const dx = visible.eye.x - eye.x;
      const dy = visible.eye.y - eye.y;
      const dz = visible.eye.z - eye.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const onTarget = (dir.x * dx + dir.y * dy + dir.z * dz) / len;
      if (onTarget > 0.985) {
        // Held down, the trigger only ever fires a self-loader once. Pressing
        // it exactly when the weapon is ready works for both kinds of gun, and
        // keeps a bot with a pump gun from freezing on a single shell.
        input.fire = bot.weapon.cooldown <= 0;
        input.aim = visible.dist > 5;
        b.burst += dt;
        if (b.burst > 0.22 + rand(b) * 0.2) {
          b.burst = 0;
          b.burstCooldown = 0.28 + rand(b) * 0.35;
        }
      }
    } else {
      b.burst = 0;
    }

    if (bot.weapon.ammo === 0 && bot.weapon.reserve > 0) input.reload = true;

    // ── Move ──
    const investigate = !visible && b.heardGuess && state.time - b.heardAt < 6;
    if (visible) {
      // Hold the angle, strafe a little, crouch at range for accuracy.
      input.moveX = Math.sin(state.time * 1.7 + b.rnd * 0.001) > 0 ? 0.6 : -0.6;
      input.crouch = visible.dist > 7;
      input.sneak = true;
    } else if (investigate) {
      const d = distXZ(b.heardGuess ?? b.heard, bot.pos);
      if (d > 1.5) {
        input.moveZ = 1;
        input.sneak = true; // approach quietly
      }
      // Open a door if one is in the way.
      input.use = d > 1.5 && rand(b) < 0.02;
    }

    return input;
  }

  return { think, memory };
}

// Walk to a doorway and fit whatever is being carried to it. Returns false
// once there is nothing to do — no door worth walking to, or the errand has
// run long enough that the bot is plainly stuck on the furniture.
const ERRAND_RANGE = 14; // metres worth walking during staging
const ERRAND_GIVEUP = 9; // seconds before a bot admits it cannot get there

function fitKit(world, state, bot, b, input, dt) {
  if (b.errand && state.doors[b.errand.id].device) b.errand = null;
  if (b.errand && b.errandTime > ERRAND_GIVEUP) {
    // Whatever is between it and that doorway, it is not going to solve it by
    // walking into it for another nine seconds. Try a different door.
    b.skip.add(b.errand.id);
    b.errand = null;
  }
  if (!b.errand) {
    b.errandTime = 0;
    let best = null;
    for (const door of world.doors) {
      const ds = state.doors[door.id];
      if (ds.device || ds.broken || b.skip.has(door.id)) continue;
      // Its own storey only: a bot has no stairs in its head.
      if (Math.abs((door.pos.y ?? 0) - bot.pos.y) > 1) continue;
      const d = distXZ(door.pos, bot.pos);
      if (d > ERRAND_RANGE) continue;
      if (!best || d < best.d) best = { door, d };
    }
    if (!best) return false;
    b.errand = best.door;
  }

  const door = b.errand;
  b.errandTime += dt;
  // Face it. The panel is two metres of door, so eye level always finds it.
  const want = Math.atan2(-(door.pos.x - bot.pos.x), -(door.pos.z - bot.pos.z));
  input.yaw = turnToward(bot.look.yaw, want, dt * 3.2);
  input.pitch = 0;

  if (distXZ(door.pos, bot.pos) > 1.25) {
    input.moveZ = 1;
    input.sneak = true; // staging is quiet work
    return true;
  }
  // Close enough, and pointed at it: press. The latch in the simulation means
  // holding it down still only fits one.
  input.gadget = true;
  return true;
}

function turnToward(current, want, maxStep) {
  let diff = want - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + clamp(diff, -maxStep, maxStep);
}
