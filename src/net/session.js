// A session owns the world state and decides where it comes from.
//
// This is the seam that makes the game portable. The rest of the client only
// ever asks a session for `state` and hands it `input`. Swapping a local
// session for a networked one — or later, a dedicated-server one — changes
// nothing else.

import { buildWorld } from '../sim/world.js';
import {
  createState, addPlayer, removePlayer, stepSim, createInput, resetRound,
} from '../sim/sim.js';
import { createBotBrain } from '../sim/bot.js';
import { DT } from '../sim/constants.js';

// ── Solo / training ───────────────────────────────────────────────────────

export function createLocalSession({ map, name = 'Игрок', bots = 1, seed = 1337 }) {
  const world = buildWorld(map);
  const state = createState(world, seed);
  const localId = 'local';
  addPlayer(world, state, localId, 'attackers', name);

  const brain = createBotBrain(seed);
  const botIds = [];
  for (let i = 0; i < bots; i++) {
    const id = `bot${i}`;
    addPlayer(world, state, id, 'defenders', `Бот ${i + 1}`);
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
    nextRound() {
      resetRound(world, state);
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
        weapon: p.weapon, kills: p.kills, deaths: p.deaths,
      };
    }
    const doors = {};
    for (const [id, d] of Object.entries(state.doors)) {
      doors[id] = { open: d.open, target: d.target, forced: d.forced, locked: d.locked, health: d.health };
    }
    const lights = {};
    for (const [id, l] of Object.entries(state.lights)) lights[id] = { broken: l.broken };

    return {
      t: 'snap',
      tick: state.tick,
      time: state.time,
      phase: state.phase,
      phaseTime: state.phaseTime,
      players, doors, lights,
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
    state.doors = snap.doors;
    state.lights = snap.lights;
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
