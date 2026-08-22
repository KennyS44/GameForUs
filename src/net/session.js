// A session owns the world state and decides where it comes from.
//
// This is the seam that makes the game portable. The rest of the client only
// ever asks a session for `state` and hands it `input`. Swapping a local
// session for a networked one — or later, a dedicated-server one — changes
// nothing else.

import { buildWorld } from '../sim/world.js?v=48d5848b';
import {
  createState, addPlayer, removePlayer, stepSim, createInput, resetRound, setLoadout, setGadget,
  setOptic,
} from '../sim/sim.js?v=48d5848b';
import { createBotBrain } from '../sim/bot.js?v=48d5848b';
import { DT } from '../sim/constants.js?v=48d5848b';

// ── Solo / training ───────────────────────────────────────────────────────

// `bots` is how many are against you; `mates` how many are with you.
//
// A team-mate is not decoration in training. Half of what the flat teaches is
// how two people move through it together, and until there was somebody on
// your side, dying meant the round was simply over for you — there was nobody
// whose eyes the view could move to, so the feature that does that had nothing
// to work with outside a real two-a-side match.
export function createLocalSession({ map, name = 'Игрок', bots = 1, mates = 0, seed = 1337 }) {
  const world = buildWorld(map);
  const state = createState(world, seed);
  const localId = 'local';
  addPlayer(world, state, localId, 'attackers', name);

  const brain = createBotBrain(seed);
  const botIds = [];
  // Defenders do not all carry the same gun: walking into a room and being met
  // by buckshot rather than by a rifle is half of what the roster is for.
  const botGuns = ['ar-556-piston', 'sg-12-pump', 'smg-45-inline', 'ar-545-piston', 'dmr-762'];
  // Nor the same kit: the first one wires a doorway, the second carries flares
  // for the dark, the rest hold theirs shut and shout about it. Staging is
  // when the ones with something to fit go and fit it.
  const botKit = ['trap', 'flare', 'wedge', 'alarm', 'wedge'];
  for (let i = 0; i < bots; i++) {
    const id = `bot${i}`;
    addPlayer(world, state, id, 'defenders', `Бот ${i + 1}`);
    setLoadout(state, id, botGuns[i % botGuns.length]);
    setGadget(state, id, botKit[i % botKit.length]);
    botIds.push(id);
  }
  // Your own side. Named rather than numbered, because you will be watching
  // through his eyes and "Бот 2" is not a person to hand your round to.
  const mateNames = ['Ворон', 'Сокол', 'Беркут'];
  for (let i = 0; i < mates; i++) {
    const id = `mate${i}`;
    addPlayer(world, state, id, 'attackers', mateNames[i % mateNames.length]);
    setLoadout(state, id, botGuns[(i + 1) % botGuns.length]);
    setGadget(state, id, i === 0 ? 'charge' : 'smoke');
    botIds.push(id);
  }

  return {
    kind: 'local',
    world,
    state,
    localId,
    pings: {},
    get me() {
      return state.players[localId];
    },
    tick(input, dt = DT) {
      const inputs = { [localId]: input };
      for (const id of botIds) {
        const bot = state.players[id];
        if (bot) inputs[id] = brain.think(world, state, bot, dt);
      }
      stepSim(world, state, inputs, dt);
    },
    drainEvents() {
      return state.events;
    },
    chooseWeapon(weaponId) {
      return setLoadout(state, localId, weaponId);
    },
    chooseGadget(gadgetId) {
      return setGadget(state, localId, gadgetId);
    },
    chooseOptic(weaponId, opticId) {
      return setOptic(state, localId, weaponId, opticId);
    },
    nextRound() {
      resetRound(world, state);
      // The sides have just changed ends, so what a bot remembers is now the
      // other side's job. See forget() in src/sim/bot.js.
      brain.forget();
    },
    dispose() {},
  };
}

// ── Host: authoritative simulation, broadcasts snapshots ──────────────────

const SNAPSHOT_HZ = 20;

export function createHostSession({ map, name, transport, seed = 1337, onRoster }) {
  const world = buildWorld(map);
  const state = createState(world, seed);
  const localId = 'host';
  addPlayer(world, state, localId, 'attackers', name);

  const clientInputs = new Map(); // peerId -> {input, seq}
  const pings = {};
  let sinceSnapshot = 0;

  transport.onPeerJoin((peerId, meta) => {
    // Teams alternate so a 1v1 is attacker vs defender.
    const counts = { attackers: 0, defenders: 0 };
    for (const p of Object.values(state.players)) counts[p.team]++;
    const team = counts.defenders <= counts.attackers ? 'defenders' : 'attackers';
    addPlayer(world, state, peerId, team, (meta?.name || 'Гость').slice(0, 14));
    clientInputs.set(peerId, { input: createInput(), seq: 0 });
    transport.sendTo(peerId, { t: 'welcome', id: peerId, seed, mapId: map.id });
    onRoster?.();
  });

  transport.onPeerLeave((peerId) => {
    removePlayer(state, peerId);
    clientInputs.delete(peerId);
    delete pings[peerId];
    onRoster?.();
  });

  transport.onMessage((peerId, msg) => {
    if (msg.t === 'input') {
      const slot = clientInputs.get(peerId);
      // Ignore out-of-order input frames; UDP-ish transports can reorder.
      if (slot && msg.seq > slot.seq) {
        slot.input = msg.i;
        slot.seq = msg.seq;
      }
    } else if (msg.t === 'loadout') {
      // The host is the only authority on who is carrying what, so a client's
      // pick goes through the same check as the host's own.
      setLoadout(state, peerId, msg.id);
    } else if (msg.t === 'gadget') {
      setGadget(state, peerId, msg.id);
    } else if (msg.t === 'optic') {
      // Same rule as the weapon: the host decides, so a guest asking for a
      // marksman tube on a shotgun is simply told no by the same function that
      // tells the host no.
      setOptic(state, peerId, msg.w, msg.o);
    } else if (msg.t === 'ping') {
      transport.sendTo(peerId, { t: 'pong', c: msg.c, s: performance.now() });
    } else if (msg.t === 'rtt') {
      pings[peerId] = msg.v;
    }
  });

  function snapshot() {
    const players = {};
    for (const [id, p] of Object.entries(state.players)) {
      players[id] = {
        id, team: p.team, name: p.name,
        pos: p.pos, vel: p.vel, look: p.look, recoil: p.recoil,
        stance: p.stance, crouching: p.crouching, lean: p.lean,
        health: p.health, alive: p.alive, flashlight: p.flashlight,
        aimAmount: p.aimAmount, grounded: p.grounded,
        weapon: p.weapon, loadout: p.loadout, kills: p.kills, deaths: p.deaths,
        // What is on each of his guns, so a guest draws the sight the host
        // thinks he is looking through.
        optics: p.optics,
        gadget: p.gadget, gadgetLeft: p.gadgetLeft, blind: p.blind,
        // Night vision is worn where everyone can see it, so it travels with
        // everything else a guest's screen has to agree with the host about.
        nvg: p.nvg,
        // Carried so a client replaying its pending inputs continues the
        // recoil climb and the jump timer from the host's numbers rather than
        // its own guess.
        burstShots: p.burstShots, sinceShot: p.sinceShot,
        jumpCooldown: p.jumpCooldown, airborne: p.airborne,
      };
    }
    const doors = {};
    for (const [id, d] of Object.entries(state.doors)) {
      doors[id] = {
        open: d.open, target: d.target, forced: d.forced, broken: d.broken,
        locked: d.locked, health: d.health, device: d.device, charge: d.charge,
      };
    }
    const lights = {};
    for (const [id, l] of Object.entries(state.lights)) lights[id] = { broken: l.broken };

    return {
      t: 'snap',
      tick: state.tick,
      time: state.time,
      phase: state.phase,
      phaseTime: state.phaseTime,
      // Which round it is, because the sides swap on it. A guest works this
      // out for itself from the reset messages it receives, and would drift
      // from the host the first time one went missing; sending it means the
      // host's count is the only one that decides who is attacking.
      round: state.round,
      // One switch for the whole building, so it belongs in the snapshot next
      // to the doors: a guest whose lights are still on is playing a different
      // round from everyone else.
      power: state.power,
      players, doors, lights,
      // Grenades in the air and clouds on the floor are world state like any
      // other: a guest has to see the same smoke the host does.
      throwables: state.throwables,
      smokes: state.smokes,
      events: state.events,
      acks: Object.fromEntries([...clientInputs].map(([id, s]) => [id, s.seq])),
      pings,
    };
  }

  return {
    kind: 'host',
    world,
    state,
    localId,
    pings,
    get me() {
      return state.players[localId];
    },
    tick(input, dt = DT) {
      const inputs = { [localId]: input };
      for (const [id, slot] of clientInputs) inputs[id] = slot.input;
      stepSim(world, state, inputs, dt);

      sinceSnapshot += dt;
      if (sinceSnapshot >= 1 / SNAPSHOT_HZ) {
        sinceSnapshot = 0;
        transport.broadcast(snapshot());
      }
    },
    drainEvents() {
      return state.events;
    },
    chooseWeapon(weaponId) {
      return setLoadout(state, localId, weaponId);
    },
    chooseGadget(gadgetId) {
      return setGadget(state, localId, gadgetId);
    },
    chooseOptic(weaponId, opticId) {
      return setOptic(state, localId, weaponId, opticId);
    },
    nextRound() {
      resetRound(world, state);
      transport.broadcast({ t: 'reset' });
    },
    dispose() {
      transport.close();
    },
  };
}

// ── Client: predicts itself, follows the host for everything else ─────────

export function createClientSession({ map, transport, myId, seed = 1337 }) {
  const world = buildWorld(map);
  const state = createState(world, seed);
  const localId = myId;

  // Inputs we've sent but the host hasn't confirmed yet.
  const pending = [];
  let seq = 0;
  let lastAck = 0;
  let rtt = 0;
  const pings = {};

  // Interpolation buffer for remote players, so they move smoothly between
  // the 20 snapshots per second we actually receive.
  const remotePrev = new Map();
  const remoteNext = new Map();
  let interpT = 0;
  let interpDuration = 1 / SNAPSHOT_HZ;

  // Events reach the renderer from two places, and we must not play them twice.
  //
  //  - Feedback for our own actions is predicted locally, so firing feels
  //    instant instead of lagging by a round trip.
  //  - Everything with a real consequence (hits, deaths, doors) comes from the
  //    host, which is the only authority on what actually happened.
  const PREDICTED_LOCALLY = new Set(['shot', 'dryFire', 'reload', 'reloadDone', 'step']);
  const outEvents = [];
  let replaying = false;

  transport.onMessage((_peerId, msg) => {
    if (msg.t === 'snap') applySnapshot(msg);
    else if (msg.t === 'pong') {
      rtt = performance.now() - msg.c;
      pings[localId] = rtt;
      transport.send({ t: 'rtt', v: rtt });
    } else if (msg.t === 'reset') {
      resetRound(world, state);
      pending.length = 0;
    }
  });

  function applySnapshot(snap) {
    state.tick = snap.tick;
    state.time = snap.time;
    state.phase = snap.phase;
    state.phaseTime = snap.phaseTime;
    state.round = snap.round ?? state.round;
    state.doors = snap.doors;
    state.lights = snap.lights;
    state.power = snap.power !== false;
    state.throwables = snap.throwables ?? [];
    state.smokes = snap.smokes ?? [];
    Object.assign(pings, snap.pings ?? {});

    for (const ev of snap.events ?? []) {
      if (ev.by === localId && PREDICTED_LOCALLY.has(ev.type)) continue;
      outEvents.push(ev);
    }

    // Remote players: keep the previous snapshot to interpolate from.
    for (const [id, sp] of Object.entries(snap.players)) {
      if (id === localId) continue;
      const existing = state.players[id];
      if (existing) {
        remotePrev.set(id, {
          pos: { ...existing.pos },
          look: { ...existing.look },
          stance: existing.stance,
          lean: existing.lean,
        });
      }
      state.players[id] = { ...(existing ?? {}), ...sp };
      remoteNext.set(id, {
        pos: { ...sp.pos },
        look: { ...sp.look },
        stance: sp.stance,
        lean: sp.lean,
      });
    }
    for (const id of Object.keys(state.players)) {
      if (id !== localId && !snap.players[id]) {
        delete state.players[id];
        remotePrev.delete(id);
        remoteNext.delete(id);
      }
    }
    interpT = 0;

    // ── Reconcile our own player ──
    const authoritative = snap.players[localId];
    if (!authoritative) return;
    const me = state.players[localId] ?? (state.players[localId] = {});
    Object.assign(me, authoritative);

    lastAck = snap.acks?.[localId] ?? lastAck;
    while (pending.length && pending[0].seq <= lastAck) pending.shift();

    // Replay everything the host hasn't seen yet, so our own movement stays
    // responsive instead of lagging by a full round trip. Replayed ticks must
    // not emit sound or muzzle flashes a second time.
    replaying = true;
    for (const p of pending) {
      stepSim(world, state, { [localId]: p.input }, DT);
    }
    replaying = false;
  }

  let pingTimer = 0;

  return {
    kind: 'client',
    world,
    state,
    localId,
    pings,
    get me() {
      return state.players[localId];
    },
    get rtt() {
      return rtt;
    },
    tick(input, dt = DT) {
      seq++;
      pending.push({ seq, input });
      // Cap the buffer: on a very bad connection this would grow forever.
      if (pending.length > 180) pending.shift();
      transport.send({ t: 'input', seq, i: input });

      // Predict our own player immediately.
      if (state.players[localId]) {
        stepSim(world, state, { [localId]: input }, dt);
        if (!replaying) {
          for (const ev of state.events) {
            if (ev.by === localId && PREDICTED_LOCALLY.has(ev.type)) outEvents.push(ev);
          }
        }
      }

      // Advance remote players along the interpolation buffer.
      interpT += dt;
      const a = Math.min(1, interpT / interpDuration);
      for (const [id, next] of remoteNext) {
        const prev = remotePrev.get(id);
        const p = state.players[id];
        if (!p || !prev) continue;
        p.pos = {
          x: prev.pos.x + (next.pos.x - prev.pos.x) * a,
          y: prev.pos.y + (next.pos.y - prev.pos.y) * a,
          z: prev.pos.z + (next.pos.z - prev.pos.z) * a,
        };
        p.look = {
          yaw: lerpAngle(prev.look.yaw, next.look.yaw, a),
          pitch: prev.look.pitch + (next.look.pitch - prev.look.pitch) * a,
        };
        p.stance = prev.stance + (next.stance - prev.stance) * a;
        p.lean = prev.lean + (next.lean - prev.lean) * a;
      }

      pingTimer += dt;
      if (pingTimer > 1) {
        pingTimer = 0;
        transport.send({ t: 'ping', c: performance.now() });
      }
    },
    drainEvents() {
      const out = outEvents.slice();
      outEvents.length = 0;
      return out;
    },
    chooseWeapon(weaponId) {
      transport.send({ t: 'loadout', id: weaponId });
      // Show it in our own hands straight away; the next snapshot either
      // confirms it or quietly puts the old gun back.
      return setLoadout(state, localId, weaponId);
    },
    chooseGadget(gadgetId) {
      transport.send({ t: 'gadget', id: gadgetId });
      return setGadget(state, localId, gadgetId);
    },
    chooseOptic(weaponId, opticId) {
      transport.send({ t: 'optic', w: weaponId, o: opticId });
      return setOptic(state, localId, weaponId, opticId);
    },
    nextRound() {
      // Only the host may start a round; clients wait for the reset message.
    },
    dispose() {
      transport.close();
    },
  };
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
