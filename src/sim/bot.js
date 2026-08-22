// An opponent for solo training. Pure like the rest of the simulation, so if
// bots are ever wanted online they run on the server unchanged.
//
// A bot plays the flat the way the flat wants to be played: it holds an angle
// that is worth holding, it moves when standing still stops paying, and it
// only knows what it could actually have seen or heard. Everything it does is
// something a player could do with the same keys — it has no map knowledge a
// player lacks, no hearing through walls, no aim that does not have to travel.
//
// The three things that make it a man rather than a turret:
//   · it walks. There is a graph of standing places in `nav.js`, so "get to
//     the far side of the flat" is a route rather than a wish. Bots used to
//     hold whatever room they spawned in for the simple reason that their
//     only movement order was "walk the way you are looking";
//   · it is wrong. Faint sounds are missed, the rest are placed badly, and a
//     man who walks into smoke keeps walking in the bot's head whether or not
//     he really did;
//   · it changes its mind about you. A quiet enemy makes it restless and it
//     comes looking; a loud one makes it sit down and watch the noise.

import { createInput, eyePosition, aimDirection, litByFlare, burningFlares } from './sim.js?v=09f108eb';
import { raycastGeometry, smokeBlocks } from './world.js?v=09f108eb';
import { nearestNode, nodePos, findPath, smoothPath } from './nav.js?v=09f108eb';
import { distXZ, clamp } from './math.js?v=09f108eb';
import { BLIND, GADGETS } from './constants.js?v=09f108eb';

// Indoors nobody picks a figure out of the gloom across the whole map.
const MAX_SIGHT = 24;
// And with the mains off, nobody picks one out at all past a few metres —
// unless they are wearing a tube, or the man is standing in a flare's light.
const DARK_SIGHT = 5;
const NVG_SIGHT = 15;

// How long a bot will hold one spot before it starts to feel like a bad spot.
// The impatient end of the range is what a side that has given up waiting
// uses, and the choice between them is what `pressure` decides.
const POST_MIN = 9;
const POST_MAX = 26;

// A man you have lost is worth chasing for this long, and worth shooting at
// through a cloud for rather less.
const CONTACT_MEMORY = 2.5;
const GHOST_MEMORY = 3.2;
// How long the bot believes a man behind smoke kept walking the way he was.
const GHOST_DRIFT = 1.1;

// However badly a round is going, some of the side is always holding ground.
const PRESSURE_CAP = 0.8;
// How coarsely a bot remembers where it has already looked: a room, near
// enough, on the storey it is on.
const PATCH = 3;

export function createBotBrain(seed = 7) {
  const memory = new Map(); // botId -> what this bot believes
  const squads = new Map(); // team -> what the side as a whole believes

  function brainFor(id) {
    if (!memory.has(id)) {
      const b = {
        target: null,
        lastSeen: null,
        lastSeenAt: -99,
        // Where a man behind a cloud probably is, if he kept doing what he was
        // doing. This is what gets shot at, and it is often wrong.
        ghost: null,
        ghostVel: null,
        ghostAt: -99,
        // The last sound this bot placed, when, and how sure of it it is.
        // `ready` is when it finishes working out what it heard.
        sound: null,
        actedOn: -99,
        burst: 0,
        burstCooldown: 0,
        reactTimer: 0,
        aimError: { yaw: 0, pitch: 0 },
        errorTimer: 0,
        // Where it is going and why, as a node in the walkable graph.
        goal: -1,
        goalKind: 'post',
        path: null,
        pathAt: 0,
        repathIn: 0,
        // The spot it is holding and how long it has held it.
        post: null,
        lastPost: null,
        postTime: 0,
        // Idle scanning. A bot that stares at one point is a camera on a
        // bracket, not a man with a neck. Until it has looked at something,
        // the angle it is holding is the one it woke up on.
        faceYaw: null,
        scan: 0,
        scanIn: 0,
        // Rough parts of the building and when this bot was last in them.
        // Searching a flat means going where you have not just been, not
        // walking at the front door until somebody uses it.
        visited: new Map(),
        // Walking into the furniture, and noticing that you are.
        wasAt: null,
        checkIn: 0.5,
        stuck: 0,
        shove: 0,
        // The doorway this bot is on its way to fit something to, and how long
        // it has been trying. Cleared the moment the kit is on the door.
        errand: null,
        errandTime: 0,
        skip: new Set(),
        doorTry: 0,
        rnd: (seed + hash(id)) >>> 0,
        phase: 0,
      };
      memory.set(id, b);
      b.phase = rand(b) * Math.PI * 2;
    }
    return memory.get(id);
  }

  function squadFor(team) {
    if (!squads.has(team)) {
      squads.set(team, {
        at: -1,
        // Everything the side has seen or half-heard lately, newest last.
        contacts: [],
        lastContactAt: -99,
        // A man who sees something says so. Teammates get it a moment later,
        // which is how long it takes to say it.
        call: null,
        // Where one of ours died: a place the enemy could see, recently.
        loss: null,
        lossAt: -99,
        // How hard the side is playing. Rises with boredom and with being
        // outnumbered, drops the moment anybody actually sees anything.
        pressure: 0.15,
        posts: new Map(),
      });
    }
    return squads.get(team);
  }

  function rand(b) {
    b.rnd = (b.rnd * 1103515245 + 12345) & 0x7fffffff;
    return b.rnd / 0x7fffffff;
  }

  // ── The tick ───────────────────────────────────────────────────────────

  function think(world, state, bot, dt) {
    const input = createInput();
    const b = brainFor(bot.id);
    const squad = squadFor(bot.team);
    input.yaw = bot.look.yaw;
    input.pitch = bot.look.pitch;
    if (!bot.alive) {
      squad.posts.delete(bot.id);
      return input;
    }

    updateSquad(state, squad, bot.team, dt);

    // ── Staging: fit the kit ──
    //
    // Half of what a defender does happens before anyone is shot at, and a
    // flat where no door is ever wedged or wired is a flat with half its
    // defence missing. So: pick a doorway with nothing on it, walk there —
    // properly, through the rooms in between — look at it, press the button.
    if (state.phase === 'prep' && bot.gadgetLeft > 0 && GADGETS[bot.gadget]?.kind === 'door') {
      if (fitKit(world, state, bot, b, input, dt)) return input;
    }

    // ── The dark ──
    //
    // With the power cut a bot does exactly what a player does: an attacker
    // pulls the tube down, and a defender who cannot see puts a flare on the
    // floor rather than standing in the black hoping.
    handleDarkness(state, bot, b, input);

    const eye = eyePosition(bot);
    const sense = perceive(world, state, bot, eye);
    remember(state, bot, b, squad, sense, dt);
    listen(world, state, bot, b, eye, squad);

    const fighting = !!sense.visible
      || (!!sense.veiled && state.time - b.ghostAt < GHOST_MEMORY)
      || state.time - b.lastSeenAt < CONTACT_MEMORY;

    if (!fighting) plan(world, state, bot, b, squad, dt);

    aim(state, bot, b, sense, input, dt);
    shoot(state, bot, b, sense, input, dt);
    move(world, state, bot, b, squad, sense, input, fighting, dt);

    if (bot.weapon.ammo === 0 && bot.weapon.reserve > 0) input.reload = true;
    return input;
  }

  // ── What the side believes ─────────────────────────────────────────────

  function updateSquad(state, squad, team, dt) {
    // Four bots share one of these; it must only be wound on once a tick.
    if (squad.at === state.time) return;
    squad.at = state.time;

    for (const ev of state.events) {
      if (ev.type !== 'death') continue;
      const victim = state.players[ev.id];
      if (!victim || victim.team !== team) continue;
      // Where he fell is somewhere the enemy could see a moment ago. Worth
      // knowing whether you go and look or decide never to stand there.
      squad.loss = { ...victim.pos };
      squad.lossAt = state.time;
      squad.pressure = clamp(squad.pressure + 0.3, 0, 1);
    }

    let ours = 0;
    let theirs = 0;
    for (const id in state.players) {
      const p = state.players[id];
      if (!p.alive) continue;
      if (p.team === team) ours++; else theirs++;
    }

    // Two things make a side stop waiting: a long silence, and being down on
    // numbers. Both mean whatever you are doing is not working. For the
    // attackers there is a third — the clock, which is not on their side.
    // It never reaches one: a side that has entirely stopped holding ground
    // is a side jogging around the flat, which is not a plan either.
    const quiet = state.time - squad.lastContactAt;
    // The other way round as well: a man you can hear is a man you have
    // roughly placed, and there is nothing to go looking for. This is why a
    // loud player gets watched and a quiet one gets hunted.
    if (quiet < 5) squad.pressure = clamp(squad.pressure - dt * 0.2, 0, PRESSURE_CAP);
    if (quiet > 20) squad.pressure = clamp(squad.pressure + dt * 0.03, 0, PRESSURE_CAP);
    if (ours < theirs) squad.pressure = clamp(squad.pressure + dt * 0.04, 0, PRESSURE_CAP);
    if (state.phase === 'live' && state.phaseTime < 45 && team === 'attackers') {
      squad.pressure = clamp(squad.pressure + dt * 0.05, 0, PRESSURE_CAP);
    }

    if (squad.contacts.length && state.time - squad.contacts[0].at > 60) {
      squad.contacts = squad.contacts.filter((c) => state.time - c.at < 60);
    }
  }

  function noteContact(state, squad, pos, sure) {
    squad.contacts.push({ pos: { ...pos }, at: state.time, sure });
    if (squad.contacts.length > 6) squad.contacts.shift();
    squad.lastContactAt = state.time;
    // Knowing roughly where they are is what you were pushing to find out.
    // Having found out, stop pushing and start playing the angle.
    if (sure) squad.pressure = clamp(squad.pressure * 0.45, 0, 1);
  }

  // ── Eyes ───────────────────────────────────────────────────────────────

  function perceive(world, state, bot, eye) {
    // A flashbang works on a bot exactly as it works on a player: while the
    // white is in its eyes it sees nothing and can only go by what it heard.
    if ((bot.blind ?? 0) > BLIND.botThreshold) return { visible: null, veiled: null, blind: true };

    const dir = aimDirection(bot);
    let visible = null;
    let veiled = null;
    let bestSeen = Infinity;
    let bestVeil = Infinity;
    for (const id in state.players) {
      const p = state.players[id];
      if (!p.alive || p.team === bot.team) continue;
      const theirEye = eyePosition(p);
      const dx = theirEye.x - eye.x;
      const dy = theirEye.y - eye.y;
      const dz = theirEye.z - eye.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      // Only within a believable cone — bots shouldn't see behind themselves.
      if ((dir.x * dx + dir.y * dy + dir.z * dz) / len < 0.42) continue;
      if (len > sightRange(state, bot, theirEye)) continue;

      const line = look(world, state, eye, theirEye);
      if (line === 'blocked') continue;
      if (line === 'smoke') {
        // Not seen — but seen going in there, which is a different thing from
        // never having been there at all.
        if (len < bestVeil) { bestVeil = len; veiled = { player: p, eye: theirEye, dist: len }; }
        continue;
      }
      if (len < bestSeen) { bestSeen = len; visible = { player: p, eye: theirEye, dist: len }; }
    }
    return { visible, veiled, blind: false };
  }

  function remember(state, bot, b, squad, sense, dt) {
    b.reactTimer = Math.max(0, b.reactTimer - dt);

    if (sense.visible) {
      const p = sense.visible.player;
      b.lastSeen = { ...sense.visible.eye };
      b.lastSeenAt = state.time;
      b.ghost = { ...sense.visible.eye };
      b.ghostVel = { x: p.vel?.x ?? 0, z: p.vel?.z ?? 0 };
      b.ghostAt = state.time;
      if (b.target !== p.id && b.reactTimer <= 0) {
        // Human reaction time: spotting a target, recognising it and pulling
        // the trigger is around half a second, not a single frame.
        b.reactTimer = 0.45 + rand(b) * 0.45;
      }
      b.target = p.id;
      noteContact(state, squad, sense.visible.eye, true);
      // And he says so, because that is what the other three are for. It
      // reaches them a moment later, at the speed of a sentence.
      squad.call = { pos: { ...sense.visible.eye }, at: state.time + 0.4, from: bot.id };
      return;
    }

    // Behind a cloud: keep the man walking the way he was, but only for as
    // long as anybody would believe it. After that the ghost stands still, and
    // shooting at it is a waste of a magazine.
    if (sense.veiled && b.ghost) {
      if (state.time - b.ghostAt < GHOST_DRIFT && b.ghostVel) {
        b.ghost.x += b.ghostVel.x * dt;
        b.ghost.z += b.ghostVel.z * dt;
      }
      b.lastSeen = { ...b.ghost };
    }
  }

  // ── Ears ───────────────────────────────────────────────────────────────

  function listen(world, state, bot, b, eye, squad) {
    // What a teammate shouted counts as a sound: you did not hear it, but you
    // know it, and it is exactly as vague as a shouted direction.
    const call = squad.call;
    if (call && call.from !== bot.id && state.time >= call.at
      && (!b.sound || b.sound.at < call.at)) {
      b.sound = { pos: { ...call.pos }, at: state.time, ready: state.time, weight: 0.9 };
    }

    for (const ev of state.events) {
      if (ev.type !== 'noise' || ev.by === bot.id) continue;
      const src = state.players[ev.by];
      if (src && src.team === bot.team) continue;
      const d = distXZ(ev.pos, bot.pos);
      if (d > ev.radius) continue;

      // Right at the edge of what a sound carries it is something you might
      // half notice and might not. Close and loud, you always do.
      const clarity = 1 - d / ev.radius;
      if (rand(b) > 0.18 + clarity * 0.95) continue;

      // Walls take the edge off a sound and take the direction with it, which
      // is why a footstep two rooms away gets placed in the wrong room.
      const through = wallsBetween(world, state, eye, ev.pos);
      const vague = 0.7 + d * 0.2 + through * 1.2;
      const guess = {
        x: ev.pos.x + (rand(b) - 0.5) * 2 * vague,
        y: ev.pos.y + 1.2,
        z: ev.pos.z + (rand(b) - 0.5) * 2 * vague,
      };
      // A clearer sound overwrites a muddier one; a muddier one does not
      // overwrite something you only just placed properly.
      const weight = clarity * (through > 0 ? 0.55 : 1);
      if (b.sound && state.time - b.sound.at < 1.2 && b.sound.weight > weight) continue;
      b.sound = {
        pos: guess,
        at: state.time,
        // Hearing a thing and working out what it was are not one moment.
        ready: state.time + 0.15 + rand(b) * 0.3,
        weight,
      };
      noteContact(state, squad, guess, false);
    }
  }

  // ── Deciding where to be ───────────────────────────────────────────────

  function plan(world, state, bot, b, squad, dt) {
    const nav = world.nav;
    if (!nav) return;
    b.postTime += dt;

    const sound = b.sound && state.time >= b.sound.ready && state.time - b.sound.at < 8
      ? b.sound : null;

    // Something loud and close is worth walking to. Something faint and far
    // off is worth watching for, which is a different job: nobody crosses a
    // building toward a noise he could barely place.
    if (sound && sound.at > b.actedOn) {
      b.actedOn = sound.at;
      const d = distXZ(sound.pos, bot.pos);
      if (sound.weight > 0.55 && (d < 14 || squad.pressure > 0.5)) {
        const n = nearestNode(nav, sound.pos, 3);
        if (n >= 0) { setGoal(world, state, bot, b, n, 'check'); return; }
      } else if (d > 4) {
        // Sit down and cover it instead of walking into it.
        const n = choosePost(world, state, bot, b, squad, sound.pos, bot.pos, 6);
        if (n >= 0) { setGoal(world, state, bot, b, n, 'post'); return; }
      }
    }

    // Already on the way somewhere with a reason: keep going.
    if (b.goal >= 0) return;

    // A post is worth holding for a while and no longer. Under pressure, less.
    const patience = POST_MIN + (POST_MAX - POST_MIN) * (1 - squad.pressure);
    if (b.postTime < patience) return;

    b.postTime = 0;
    b.lastPost = b.post ? { ...b.post } : null;

    const threat = threatPoint(world, state, squad, bot);
    // Restless: go and look somewhere else entirely. Content: shuffle to a
    // better corner of the ground you are already holding. Nobody goes
    // wandering during staging — there is a minute to get ready in, and it is
    // not spent walking the length of the flat.
    if (state.phase === 'live' && rand(b) < squad.pressure * 0.7) {
      const n = chooseHunt(world, state, bot, b, squad);
      if (n >= 0) { setGoal(world, state, bot, b, n, 'hunt'); return; }
    }
    const radius = state.phase === 'live' ? 5 + squad.pressure * 9 : 5;
    const n = choosePost(world, state, bot, b, squad, threat, bot.pos, radius);
    if (n >= 0) setGoal(world, state, bot, b, n, 'post');
  }

  function setGoal(world, state, bot, b, node, kind) {
    if (b.goal !== node) {
      b.goal = node;
      b.path = null;
      b.repathIn = 0;
      b.stuck = 0;
      // Anything can turn out to be unreachable — a doorway somebody wedged, a
      // corner the grid says fits and a shoulder says does not. Give every
      // errand a generous clock and abandon it when it runs out, or a bot can
      // spend a whole round leaning on one wall.
      const far = node >= 0 && world.nav ? distXZ(nodePos(world.nav, node), bot.pos) : 0;
      b.goalUntil = state.time + 10 + far * 2;
    }
    b.goalKind = kind;
  }

  // Where the trouble is expected to come from: what the side actually knows,
  // and failing that, the door they came in by.
  function threatPoint(world, state, squad, bot) {
    for (let i = squad.contacts.length - 1; i >= 0; i--) {
      const c = squad.contacts[i];
      if (state.time - c.at < 45) return c.pos;
    }
    if (squad.loss && state.time - squad.lossAt < 60) return squad.loss;
    const spawns = world.map.spawns?.[bot.team === 'attackers' ? 'defenders' : 'attackers'] ?? [];
    if (!spawns.length) return null;
    let x = 0; let y = 0; let z = 0;
    for (const s of spawns) { x += s.x; y += s.y ?? 0; z += s.z; }
    return { x: x / spawns.length, y: y / spawns.length + 1.5, z: z / spawns.length };
  }

  // A spot is worth standing in when it has something at your back, a view of
  // the way they are coming, no doorway under your feet, and nobody from your
  // own side already in it.
  const POST_TRIES = 16;

  function choosePost(world, state, bot, b, squad, threat, anchor, radius) {
    const nav = world.nav;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < POST_TRIES; i++) {
      const a = rand(b) * Math.PI * 2;
      const r = radius * Math.sqrt(rand(b));
      const n = nearestNode(nav, {
        x: anchor.x + Math.cos(a) * r,
        y: anchor.y,
        z: anchor.z + Math.sin(a) * r,
      }, 1.2);
      if (n < 0) continue;
      const pos = nodePos(nav, n);
      if (Math.abs(pos.y - anchor.y) > 2.5) continue;

      // Two bots doing the same arithmetic should not arrive in the same
      // corner, so every score starts with a coin toss.
      let score = rand(b) * 1.5;
      const cover = nav.cover[n];
      score += cover >= 2 && cover <= 6 ? 2.2 : 0;
      if (nav.doorway[n]) score -= 2.5;

      // The whole point of a post is that it watches something. Measure how
      // far you can see toward the trouble — not whether the man happens to
      // be standing there this second.
      if (threat) {
        const eye = { x: pos.x, y: pos.y + 1.5, z: pos.z };
        score += Math.min(sightlineToward(world, state, eye, threat, 14), 12) * 0.25;
      }
      // Spread out. Two men in one corner is one man with a spare rifle.
      for (const [id, other] of squad.posts) {
        if (id === bot.id) continue;
        const d = distXZ(other, pos);
        if (d < 4) score -= (4 - d) * 0.8;
      }
      // Not the corner we just left, and not so far away that we spend the
      // round walking to it.
      if (b.lastPost && distXZ(b.lastPost, pos) < 2.5) score -= 3;
      score -= distXZ(pos, bot.pos) * 0.05;

      if (score > bestScore) { bestScore = score; best = n; }
    }
    if (best >= 0) squad.posts.set(bot.id, nodePos(nav, best));
    return best;
  }

  // Restless: somewhere else in the building. Searching a flat is going where
  // you have not just been — a bot that walks toward where the enemy started
  // walks to the front door and stays there, and four of them do it together.
  // A live contact overrides that, because then there is somewhere to be.
  function chooseHunt(world, state, bot, b, squad) {
    const nav = world.nav;
    if (!nav.liveList?.length) return -1;
    const known = squad.contacts.length ? squad.contacts[squad.contacts.length - 1] : null;
    const lead = known && state.time - known.at < 25 ? known.pos : null;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < 14; i++) {
      const n = nav.liveList[Math.floor(rand(b) * nav.liveList.length)];
      const pos = nodePos(nav, n);
      let score = rand(b) * 2;
      // Worth the walk, but not the whole building away.
      const d = distXZ(pos, bot.pos);
      score += Math.min(d, 18) * 0.1 - Math.max(0, d - 22) * 0.2;
      const stale = state.time - (b.visited.get(patchKey(pos)) ?? -300);
      score += Math.min(stale, 120) * 0.03;
      if (lead) score += 5 - Math.min(5, distXZ(pos, lead) * 0.25);
      if (nav.doorway[n]) score -= 1.5;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  // ── Aiming ─────────────────────────────────────────────────────────────

  function aim(state, bot, b, sense, input, dt) {
    const eye = eyePosition(bot);
    const sound = b.sound && state.time >= b.sound.ready && state.time - b.sound.at < 3
      ? b.sound : null;

    // In order of how much the bot actually knows: what it can see, where the
    // ghost in the cloud ought to be, where it last saw you, then a guess from
    // a sound. The last two decay quickly, so a bot never tracks you through
    // a wall.
    const at = sense.visible
      ? sense.visible.eye
      : sense.veiled && b.ghost && state.time - b.ghostAt < GHOST_MEMORY
        ? b.ghost
        : b.lastSeen && state.time - b.lastSeenAt < CONTACT_MEMORY
          ? b.lastSeen
          : sound ? sound.pos : null;

    if (!at) {
      // Nothing to look at: check an angle now and then rather than staring.
      b.scanIn -= dt;
      if (b.scanIn <= 0) {
        b.scanIn = 1.6 + rand(b) * 2.4;
        b.scan = (rand(b) - 0.5) * 1.1;
      }
      input.yaw = turnToward(bot.look.yaw, (b.faceYaw ?? bot.look.yaw) + b.scan, 1.1 * dt);
      input.pitch = bot.look.pitch + clamp(-bot.look.pitch, -dt, dt);
      return;
    }

    // Wander the aim error so the bot isn't a laser. Shooting at a ghost in a
    // cloud is guesswork on top of guesswork, so the error there is wider.
    b.errorTimer -= dt;
    if (b.errorTimer <= 0) {
      b.errorTimer = 0.25 + rand(b) * 0.3;
      const spread = sense.visible ? 1 : 2.2;
      b.aimError.yaw = (rand(b) - 0.5) * 0.055 * spread;
      b.aimError.pitch = (rand(b) - 0.5) * 0.035 * spread;
    }

    const dx = at.x - eye.x;
    const dy = at.y - eye.y;
    const dz = at.z - eye.z;
    const wantYaw = Math.atan2(-dx, -dz) + b.aimError.yaw;
    const wantPitch = Math.atan2(dy, Math.hypot(dx, dz)) + b.aimError.pitch;

    // Turning onto a target you can see is brisk; swinging toward a noise is a
    // slow, searching movement.
    const rate = sense.visible ? 4.5 : sense.veiled ? 3.0 : 1.8;
    input.yaw = turnToward(bot.look.yaw, wantYaw, rate * dt);
    input.pitch = bot.look.pitch + clamp(wantPitch - bot.look.pitch, -rate * dt, rate * dt);
    b.faceYaw = input.yaw;
  }

  // ── Shooting ───────────────────────────────────────────────────────────

  function shoot(state, bot, b, sense, input, dt) {
    b.burstCooldown = Math.max(0, b.burstCooldown - dt);
    if (b.reactTimer > 0 || b.burstCooldown > 0) { b.burst = 0; return; }

    const eye = eyePosition(bot);
    const dir = aimDirection(bot);

    let at = null;
    let through = false;
    if (sense.visible) {
      at = sense.visible.eye;
    } else if (sense.veiled && b.ghost && state.time - b.ghostAt < GHOST_MEMORY) {
      // He walked into the cloud in front of you. A cloud is not a wall, and
      // the man inside it does not know exactly where he is either — so put a
      // burst where he ought to be and make him pay for the shortcut. Only
      // with rounds to spare: a bot that empties itself into smoke is a bot
      // you kill afterwards for free.
      if (bot.weapon.ammo <= 6) { b.burst = 0; return; }
      at = b.ghost;
      through = true;
    } else {
      b.burst = 0;
      return;
    }

    const dx = at.x - eye.x;
    const dy = at.y - eye.y;
    const dz = at.z - eye.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const onTarget = (dir.x * dx + dir.y * dy + dir.z * dz) / len;
    // Firing blind into a cloud does not need the sights to be perfect,
    // because there is nothing to be perfect about.
    if (onTarget < (through ? 0.97 : 0.985)) { b.burst = 0; return; }

    // Held down, the trigger only ever fires a self-loader once. Pressing it
    // exactly when the weapon is ready works for both kinds of gun, and keeps
    // a bot with a pump gun from freezing on a single shell.
    input.fire = bot.weapon.cooldown <= 0;
    input.aim = len > 5 && !through;
    b.burst += dt;
    const cap = through ? 0.18 + rand(b) * 0.14 : 0.22 + rand(b) * 0.2;
    if (b.burst > cap) {
      b.burst = 0;
      b.burstCooldown = through ? 0.7 + rand(b) * 0.8 : 0.28 + rand(b) * 0.35;
    }
  }

  // ── Moving ─────────────────────────────────────────────────────────────

  function move(world, state, bot, b, squad, sense, input, fighting, dt) {
    watchForStuck(state, bot, b, dt);

    if (fighting) {
      // Hold the angle, strafe a little, crouch at range for accuracy. This is
      // not the moment to be walking somewhere else.
      b.path = null;
      b.goal = -1;
      const seen = sense.visible;
      input.moveX = Math.sin(state.time * 1.7 + b.phase) > 0 ? 0.6 : -0.6;
      input.crouch = !!seen && seen.dist > 7;
      input.sneak = true;
      return;
    }

    if (b.goal < 0 || !world.nav) {
      input.sneak = true;
      return;
    }

    // Long past the time this should have taken: whatever is in the way, it is
    // not moving. Go and be somewhere else instead.
    if (state.time > (b.goalUntil ?? Infinity)) {
      giveUp(b);
      return;
    }

    const step = followPath(world, bot, b, dt);
    if (!step) {
      // Arrived, or there is no way there. Either way this is the post now.
      b.post = { x: bot.pos.x, y: bot.pos.y, z: bot.pos.z };
      b.postTime = 0;
      b.goal = -1;
      b.path = null;
      input.sneak = true;
      return;
    }

    // A shut door in the way is a door you open, which means looking at it —
    // exactly the cost a player pays for the same thing.
    if (openDoorAhead(world, state, bot, b, input, step, dt)) return;

    // Look where you are going, unless there is something better to look at.
    // Done before the feet, because which way you are facing is what turns
    // "walk north" into which two keys are held.
    if (!sense.visible && !sense.veiled && state.time - b.lastSeenAt > CONTACT_MEMORY) {
      b.scanIn -= dt;
      if (b.scanIn <= 0) {
        b.scanIn = 1.2 + rand(b) * 1.8;
        b.scan = (rand(b) - 0.5) * 0.8;
      }
      const travel = Math.atan2(-step.x, -step.z);
      input.yaw = turnToward(bot.look.yaw, travel + b.scan, 2.4 * dt);
      b.faceYaw = travel;
    }

    steer(input, input.yaw, step.x, step.z, b.shove);
    b.shove = Math.max(0, b.shove - dt);

    // How loudly to do it. Walking is the default; a side that has given up
    // waiting runs, and one that thinks it knows where you are creeps.
    const near = squad.contacts.length
      ? distXZ(squad.contacts[squad.contacts.length - 1].pos, bot.pos) : 99;
    if (b.goalKind === 'check' && near < 10) input.sneak = true;
    else if (b.goalKind === 'hunt' && squad.pressure > 0.7 && near > 12) input.run = true;
    else input.sneak = state.phase !== 'live' || near < 16;
  }

  // Twice a second: note where we are, and notice if we have been standing
  // against the same chair for a while.
  function watchForStuck(state, bot, b, dt) {
    b.checkIn -= dt;
    if (b.checkIn > 0) return;
    b.visited.set(patchKey(bot.pos), state.time);
    const moved = b.wasAt ? distXZ(bot.pos, b.wasAt) : 9;
    b.wasAt = { x: bot.pos.x, y: bot.pos.y, z: bot.pos.z };
    b.checkIn = 0.5;
    // Half a metre a second is a slow creep; less than that, while trying to
    // walk somewhere, is not walking. Rocking on the spot between two waypoints
    // covers ground without getting anywhere, so this counts distance made
    // rather than distance travelled.
    if (moved > 0.35 || (b.goal < 0 && !b.errand)) { b.stuck = 0; return; }
    b.stuck++;
    // First a fresh route, then a shove sideways, then give up on the errand
    // entirely: whatever is in the way, another second of leaning on it will
    // not move it.
    if (b.stuck === 2) b.path = null;
    if (b.stuck >= 4) {
      b.shove = 0.7;
      giveUp(b);
    }
  }

  // Stop trying to get where we were going, and let the next tick's planning
  // pick something else. The post clock is run out on purpose so that "next
  // tick" means next tick and not twenty seconds from now.
  function giveUp(b) {
    b.stuck = 0;
    b.goal = -1;
    b.path = null;
    b.postTime = POST_MAX * 2;
  }

  // Advance along the route, rebuilding it when it runs out or goes stale.
  // Returns the direction to walk in, or null when there is nowhere left.
  function followPath(world, bot, b, dt) {
    const nav = world.nav;
    b.repathIn -= dt;
    if (!b.path || b.repathIn <= 0) {
      const from = nearestNode(nav, bot.pos, 3);
      const path = from >= 0 && b.goal >= 0 ? findPath(nav, from, b.goal) : null;
      b.path = path ? smoothPath(nav, path) : null;
      b.pathAt = 0;
      // Doors open and people get in the way, but a route through a building
      // does not change every second.
      b.repathIn = 1.5;
      if (!b.path) return null;
    }

    while (b.pathAt < b.path.length) {
      const wp = nodePos(nav, b.path[b.pathAt]);
      if (distXZ(wp, bot.pos) < 0.55 && Math.abs(wp.y - bot.pos.y) < 1.2) { b.pathAt++; continue; }
      const dx = wp.x - bot.pos.x;
      const dz = wp.z - bot.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      return { x: dx / len, z: dz / len };
    }
    return null;
  }

  // ── Doors ──────────────────────────────────────────────────────────────

  function openDoorAhead(world, state, bot, b, input, step, dt) {
    let found = null;
    for (const door of world.doors) {
      const ds = state.doors[door.id];
      // `target`, not `open`: a door already swinging open is not in the way,
      // and pressing the handle again would shut it in our own face.
      if (ds.broken || ds.target > 0.4) continue;
      if (Math.abs((door.pos.y ?? 0) - bot.pos.y) > 1.5) continue;
      const dx = door.pos.x - bot.pos.x;
      const dz = door.pos.z - bot.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1.7 || d < 1e-3) continue;
      // Only a door that is actually in the way of where we are going.
      if ((dx / d) * step.x + (dz / d) * step.z < 0.35) continue;
      found = { door, dx, dz };
      break;
    }
    if (!found) { b.doorTry = 0; return false; }

    // The handle is on a panel two metres high, so looking at the middle of it
    // always finds it.
    const want = Math.atan2(-found.dx, -found.dz);
    input.yaw = turnToward(bot.look.yaw, want, 5 * dt);
    input.pitch = bot.look.pitch + clamp(-0.15 - bot.look.pitch, -3 * dt, 3 * dt);
    if (Math.abs(angleTo(input.yaw, want)) > 0.2) return true;

    b.doorTry += dt;
    // Wedged, locked, or something heavy behind it: stop rattling the handle
    // and put a boot through it. Loud, which is the price.
    if (b.doorTry > 1.6) {
      input.kick = true;
      if (b.doorTry > 3.2) b.doorTry = 0;
      return true;
    }
    // The latch in the simulation means holding it down only pushes once.
    input.use = true;
    return true;
  }

  // ── Staging ────────────────────────────────────────────────────────────
  //
  // Walk to a doorway and fit whatever is being carried to it. Returns false
  // once there is nothing to do — no door worth walking to, or the errand has
  // run long enough that the bot is plainly stuck on the furniture.

  // Metres worth walking during staging. Further than it used to be, now that
  // walking somewhere means a route rather than a hopeful shove forward.
  const ERRAND_RANGE = 22;
  const ERRAND_GIVEUP = 9; // seconds before a bot admits it cannot get there

  function fitKit(world, state, bot, b, input, dt) {
    watchForStuck(state, bot, b, dt);
    if (b.errand && state.doors[b.errand.id].device) b.errand = null;
    if (b.errand && b.errandTime > ERRAND_GIVEUP) {
      // Whatever is between it and that doorway, it will not solve it by
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
        // Its own storey only: nobody goes downstairs to wire a door during
        // the minute they have to get ready.
        if (Math.abs((door.pos.y ?? 0) - bot.pos.y) > 1) continue;
        const d = distXZ(door.pos, bot.pos);
        if (d > ERRAND_RANGE) continue;
        if (!best || d < best.d) best = { door, d };
      }
      if (!best) return false;
      b.errand = best.door;
      const n = world.nav
        ? nearestNode(world.nav, { x: best.door.pos.x, y: best.door.pos.y ?? 0, z: best.door.pos.z }, 2.5)
        : -1;
      setGoal(world, state, bot, b, n, 'kit');
    }

    const door = b.errand;
    b.errandTime += dt;
    // Face it. The panel is two metres of door, so eye level always finds it.
    const want = Math.atan2(-(door.pos.x - bot.pos.x), -(door.pos.z - bot.pos.z));
    input.yaw = turnToward(bot.look.yaw, want, dt * 3.2);
    input.pitch = 0;

    if (distXZ(door.pos, bot.pos) > 1.25) {
      // Route there rather than shoving forward and hoping. Staging is quiet
      // work, so it is done at a creep.
      const step = b.goal >= 0 && world.nav ? followPath(world, bot, b, dt) : null;
      if (step) steer(input, input.yaw, step.x, step.z, b.shove);
      else steer(input, input.yaw, -Math.sin(want), -Math.cos(want));
      b.shove = Math.max(0, b.shove - dt);
      input.sneak = true;
      return true;
    }
    // Close enough, and pointed at it: press. The latch in the simulation
    // means holding it down still only fits one.
    input.gadget = true;
    return true;
  }

  // ── The dark ───────────────────────────────────────────────────────────
  //
  // What a bot does about the lights going out — and only if it picked
  // something for the dark, exactly like a player. A bot carrying wedges is as
  // blind as anybody else who spent his slot elsewhere.

  const FLARE_SPACING = 6; // no point stacking two in the same doorway

  function handleDarkness(state, bot, b, input) {
    if (state.power !== false) return;
    if (bot.gadgetLeft <= 0 || bot.gadgetCooldown > 0) return;

    // The tube costs nothing to wear, so it goes on and stays on.
    if (bot.gadget === 'nvg') {
      if (!bot.nvg) input.gadget = true;
      return;
    }
    if (bot.gadget !== 'flare') return;

    // Only where it would help. A bot that drops one at its feet every few
    // seconds turns the defence into a runway.
    for (const t of burningFlares(state)) {
      if (distXZ(t.pos, bot.pos) < FLARE_SPACING) return;
    }
    const burn = GADGETS.flare.fuse ?? 45;
    if (state.time - (b.lastFlare ?? -99) < burn * 0.5) return;
    b.lastFlare = state.time;
    input.gadget = true;
  }

  // A new round is a new building as far as a bot is concerned.
  //
  // None of this used to be cleared, and it mattered less when a bot spent
  // every round on the same side of the same flat: stale contacts were merely
  // wrong. Now that the sides change ends, a bot carries the *other* job into
  // the round — an errand to wedge a door it is now supposed to be breaching,
  // a map of rooms it walked as the defence, a squad still tense from a
  // contact that happened to somebody it is now trying to kill.
  function forget() {
    memory.clear();
    squads.clear();
  }

  return { think, forget, memory, squads };
}

// ── Helpers ──────────────────────────────────────────────────────────────

// Turn a direction in the world into the two movement keys, given the way the
// head is pointing. This is what lets a bot hold an angle and walk somewhere
// else at the same time — the whole difference between a man moving through a
// building and a man walking wherever he happens to be looking.
function steer(input, yaw, dx, dz, shove = 0) {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  // Wedged on the furniture: crab sideways for a moment instead of pushing
  // harder into it.
  const wx = shove > 0 ? -dz : dx;
  const wz = shove > 0 ? dx : dz;
  input.moveZ = clamp(-(s * wx + c * wz), -1, 1);
  input.moveX = clamp(c * wx - s * wz, -1, 1);
}

// How far this bot can make out a man standing at `at`. With the lights on it
// is the length of a room; with them off it is arm's length, and the two ways
// out of that are the two things the kit list sells for exactly that — a tube
// on your own head, or a flare burning where the other man is standing.
function sightRange(state, bot, at) {
  if (state.power !== false) return MAX_SIGHT;
  if (bot.nvg) return NVG_SIGHT;
  if (litByFlare(state, at)) return MAX_SIGHT * 0.6;
  return DARK_SIGHT;
}

// Why you cannot see someone matters. A wall means he is gone; a cloud means
// he is right there and you have only lost the sight picture, which is a thing
// you can still do something about.
function look(world, state, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return 'clear';
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  for (const h of raycastGeometry(world, state, from, dir, len - 1e-3)) {
    if (!h.material.seeThrough) return 'blocked';
  }
  return smokeBlocks(state, from, dir, len) ? 'smoke' : 'clear';
}

// How many solid surfaces a sound had to come through to reach this ear.
function wallsBetween(world, state, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return 0;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  let n = 0;
  for (const h of raycastGeometry(world, state, from, dir, len - 1e-3)) {
    if (!h.material.seeThrough) n++;
  }
  return n;
}

// How far you can see from here toward there before something stops you. A
// post that watches eight metres of corridor is worth more than one that
// watches a metre and a half of wall.
function sightlineToward(world, state, eye, target, cap) {
  const dx = target.x - eye.x;
  const dy = (target.y ?? eye.y) - eye.y;
  const dz = target.z - eye.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return 0;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  const reach = Math.min(cap, len);
  let nearest = reach;
  for (const h of raycastGeometry(world, state, eye, dir, reach)) {
    if (!h.material.seeThrough && h.t < nearest) nearest = h.t;
  }
  return nearest;
}

// Which rough part of the building a point is in. Coarse on purpose: a bot
// that remembers metres remembers nothing, and a bot that remembers rooms
// knows which rooms it has not looked in.
function patchKey(pos) {
  return `${Math.round(pos.x / PATCH)}:${Math.round(pos.y / 3.3)}:${Math.round(pos.z / PATCH)}`;
}

function turnToward(current, want, maxStep) {
  return current + clamp(angleTo(current, want), -maxStep, maxStep);
}

function angleTo(current, want) {
  let diff = want - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

// Bots used to be seeded by the length of their name, so every bot in the
// round drew the same numbers in the same order and four of them made one
// decision four times over.
function hash(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
