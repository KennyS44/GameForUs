// The debug handle: `window.__gfu`, and only when ?debug=1 asked for it.
//
// This is everything a tool needs to photograph the game without playing it —
// start a match, skip the setup clock, stand the man somewhere, point him at
// something, put a gun in his hands, hold a button down, run the round forward
// and draw the result. See tools/shot.mjs, which is the only caller.
//
// It exists because the alternative was editing the game's own source before
// every screenshot and remembering to take it out afterwards. That is exactly
// how a debug hook ends up on a live site, and it had already cost enough time
// checking that one had not.
//
// The safety property is in main.js, not here: this module is only imported
// when the flag is set, so a visitor to the published site never downloads it
// and `window.__gfu` is undefined. Nothing else in the game reads it.

import { ROUND, DT, WEAPONS, GADGETS } from '../sim/constants.js?v=76a1d3ce';

export function installDebug({ input, getGame, startSolo }) {
  // Fields forced into every input frame the game samples. The simulation reads
  // input through one function, so wrapping it is enough to hold a button down
  // — and it works with no pointer lock, which a headless browser has no way to
  // grant. That is the point: `sample` returns look-only when unlocked, and
  // these go on top of whatever it decided.
  let held = {};
  const sampleReal = input.sample.bind(input);
  input.sample = () => Object.assign(sampleReal(), held);

  const game = () => {
    const g = getGame();
    if (!g) throw new Error('__gfu: нет запущенного матча — сначала solo()');
    return g;
  };
  const state = () => game().session.state;
  const me = () => game().session.me;
  const map = () => game().session.world.map;

  // Where a named room is, in the coordinates a player stands in: the middle of
  // its floor plan, on its own storey.
  function roomSpot(id) {
    const r = map().rooms.find((x) => x.id === id);
    if (!r) throw new Error(`__gfu: нет комнаты "${id}"`);
    return {
      x: (r.min.x + r.max.x) / 2,
      y: r.floor === 1 ? map().upperFloorY : 0,
      z: (r.min.z + r.max.z) / 2,
    };
  }

  const api = {
    // ── Looking ──

    // Enough to know where you are and what you are holding, in one object that
    // survives being turned into JSON and read on the other side of a browser.
    info() {
      const g = getGame();
      if (!g) return { running: false };
      const s = g.session.state;
      const p = g.session.me;
      return {
        running: true,
        phase: s.phase,
        phaseTime: Number(s.phaseTime.toFixed(2)),
        me: p && {
          pos: { x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2) },
          look: { yaw: +p.look.yaw.toFixed(3), pitch: +p.look.pitch.toFixed(3) },
          weapon: p.weapon?.id,
          gadget: p.gadget,
          health: p.health,
          alive: p.alive,
          aim: +(p.aimAmount ?? 0).toFixed(2),
          grounded: p.grounded,
        },
        players: Object.values(s.players).length,
      };
    },

    // The names `at()` accepts, with where each one puts you.
    rooms() {
      return map().rooms.map((r) => ({
        id: r.id, name: r.name, floor: r.floor, spot: roomSpot(r.id),
      }));
    },

    weapons: () => Object.keys(WEAPONS),
    gadgets: () => Object.keys(GADGETS),

    // ── Setting things up ──

    // Start a solo match without touching the menu.
    solo(bots = 2) {
      startSolo(bots);
      return true;
    },

    // Skip the setup. A minute of countdown stands between a fresh page and
    // anything worth photographing, and it is a minute even when nothing in it
    // moves. Naming a phase jumps the round straight to it.
    phase(name = 'live', seconds) {
      const s = state();
      s.phase = name;
      s.phaseTime = seconds ?? (name === 'live' ? ROUND.duration : ROUND.prepTime);
      return s.phase;
    },

    // The racks only open before the round starts, and by the time there is
    // anything to photograph they have shut. Opening them for the length of one
    // call is cheaper than making every caller remember the order.
    weapon(id) {
      if (!WEAPONS[id]) throw new Error(`__gfu: нет оружия "${id}"`);
      const s = state();
      const was = s.phase;
      s.phase = 'select';
      const ok = game().session.chooseWeapon(id);
      s.phase = was;
      return ok;
    },

    gadget(id) {
      if (!GADGETS[id]) throw new Error(`__gfu: нет снаряжения "${id}"`);
      const s = state();
      const was = s.phase;
      s.phase = 'select';
      const ok = game().session.chooseGadget(id);
      s.phase = was;
      return ok;
    },

    // Stand somewhere. Either a room id — `at('kitchen')` — or coordinates.
    // Dropped in still, because arriving with the last position's velocity
    // means sliding out of frame while the picture is being taken.
    at(where, y) {
      const p = me();
      const spot = typeof where === 'string'
        ? roomSpot(where)
        : { x: where.x, y: where.y ?? p.pos.y, z: where.z };
      p.pos.x = spot.x;
      p.pos.z = spot.z;
      p.pos.y = y ?? spot.y;
      p.vel.x = p.vel.y = p.vel.z = 0;
      return { x: p.pos.x, y: p.pos.y, z: p.pos.z };
    },

    // Point him somewhere. Yaw runs the way the simulation reads it, so this
    // and the mouse agree; both the input and the player are set, because a
    // picture may be wanted without running a single tick first.
    look(yaw, pitch = 0) {
      const p = me();
      p.look.yaw = yaw;
      p.look.pitch = pitch;
      input.setLook(yaw, pitch);
      return { yaw, pitch };
    },

    // ...or point him at something, which is usually what was meant. Takes the
    // same argument as at().
    face(where) {
      const p = me();
      const spot = typeof where === 'string' ? roomSpot(where) : where;
      const dx = spot.x - p.pos.x;
      const dz = spot.z - p.pos.z;
      const yaw = Math.atan2(-dx, -dz);
      const dy = (spot.y ?? p.pos.y) + 1.2 - (p.pos.y + 1.5);
      return api.look(yaw, Math.atan2(dy, Math.hypot(dx, dz)));
    },

    // ── Buttons ──

    // Hold whatever a hand would hold: { aim: true }, { fire: true },
    // { moveZ: 1, run: true }. Cleared by release().
    hold(fields) {
      held = { ...held, ...fields };
      return held;
    },
    release() {
      held = {};
      return true;
    },

    // ── Running it ──

    // Move the round on by this many ticks and draw the result, right now,
    // whatever the browser's clock is doing.
    tick(n = 1) {
      game().advance(n);
      return +(n * DT).toFixed(2);
    },

    // Seconds instead of ticks, for when that reads better.
    run(seconds) {
      return api.tick(Math.round(seconds / DT));
    },

    // Stop and start the loop that paces itself. A tool pauses first and then
    // does its own ticking, so that nothing drifts between setting a scene up
    // and taking the picture.
    pause() {
      game().pause();
      return true;
    },
    resume() {
      game().resume();
      return true;
    },

    // ── Getting out of the way ──

    // The overlays are not the subject. Without this every screenshot carries a
    // crosshair, a health bar and — with no pointer lock to be had in a
    // headless browser — a "click to play" notice across the middle.
    hud(on) {
      const el = document.getElementById('hud');
      if (el) el.style.visibility = on ? '' : 'hidden';
      return !!on;
    },

    // One drawn frame, resolved once the browser has actually painted it.
    frame() {
      return new Promise((done) => requestAnimationFrame(() => done(true)));
    },
  };

  window.__gfu = api;
  return api;
}
