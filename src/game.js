// The runtime: drives a session at a fixed tick rate and turns its state into
// pictures and sound. Knows nothing about menus or networking.

import * as THREE from '../vendor/three.module.js?v=61b09a34';
import {
  buildScene, syncDoors, syncLights, syncSmokeFog, makeAvatar, poseAvatar,
  setAvatarWeapon, createEquipmentView,
} from './render/scene.js?v=61b09a34';
import { createEffects } from './render/effects.js?v=61b09a34';
import { createView } from './render/view.js?v=61b09a34';
import { createHud } from './ui/hud.js?v=61b09a34';
import { DT, NVG } from './sim/constants.js?v=61b09a34';
import { lookTarget, eyePosition, aimDirection, spectateTarget } from './sim/sim.js?v=61b09a34';
import { raycastGeometry } from './sim/world.js?v=61b09a34';
import { distXZ } from './sim/math.js?v=61b09a34';

const MAX_CATCHUP_TICKS = 12; // bound catch-up work after a stall, without
                              // dropping into slow motion on a weak machine

export function createGame({ canvas, session, audio, input, onPause, onRoundEnd, onPhase }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: window.devicePixelRatio < 2,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const built = buildScene(session.world);
  const view = createView(built.scene);
  const effects = createEffects(built.scene);
  // Grenades, clouds and whatever is fitted to a door. It needs the door
  // pivots so a charge swings with the panel it is stuck to.
  const equipment = createEquipmentView(built.scene);
  equipment.attachDoors(built.doorMeshes);
  const hud = createHud();

  // ── Warm-up ──
  // Nothing in a WebGL scene is free the first time it is used: a material is
  // compiled against the exact set of lights present, geometry is uploaded on
  // its first draw, and a shadow-casting light allocates its map. Left alone,
  // that bill arrives on the first shot and the first press of the torch —
  // seconds of freeze, mid-round. So it is paid here, behind the loading
  // screen, by compiling both passes and drawing one frame with every pooled
  // effect showing and the torch lit.
  {
    renderer.compile(built.scene, view.camera);
    renderer.compile(view.viewScene, view.viewCamera);
    const undo = effects.prime();
    view.primeTorch(true);
    renderer.clear();
    renderer.render(built.scene, view.camera);
    renderer.clearDepth();
    renderer.render(view.viewScene, view.viewCamera);
    view.primeTorch(false);
    undo();
  }

  const avatars = new Map();
  let accumulator = 0;
  let lastTime = performance.now();
  let running = false;
  let rafId = 0;
  let scoreboardVisible = false;
  let roundEndFired = false;
  // The runtime still knows nothing about menus — it only reports that the
  // round moved on, the same way it reports that the round ended.
  let lastPhase = session.state.phase;

  // Start the player facing their spawn direction.
  const me0 = session.me;
  if (me0) input.setLook(me0.look.yaw, 0);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    view.setAspect(w / h);
  }
  resize();
  window.addEventListener('resize', resize);

  // ── Events -> sight and sound ───────────────────────────────────────────

  // Where a door makes its noise: chest height on its own storey.
  const doorEar = (door) => ({ x: door.pos.x, y: (door.pos.y ?? 0) + 1, z: door.pos.z });

  // ── How much building is between a noise and the ear ──
  //
  // The simulation already answers this for bullets, so the same raycast
  // answers it for sound: count the solid surfaces on the straight line from
  // where the noise happened to where the listener's head is. Glass is not one
  // of them — you can hear through a pane about as well as you can see through
  // it — and neither is the far side of a wall the ray leaves, so a single
  // partition counts once rather than twice.
  //
  // Two walls is the practical ceiling. Past that a noise is a rumour anyway.
  function muffleTo(pos) {
    const me = session.me;
    if (!me) return 0;
    const ear = eyePosition(me);
    const dx = pos.x - ear.x;
    const dy = pos.y - ear.y;
    const dz = pos.z - ear.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.2) return 0;
    const hits = raycastGeometry(
      session.world, session.state, ear,
      { x: dx / len, y: dy / len, z: dz / len }, len - 0.05,
    );
    let solid = 0;
    for (const h of hits) if (!h.material.seeThrough) solid++;
    // Each surface is one face of a wall, so a partition crossed shows up
    // twice; halving turns faces back into walls.
    return Math.min(1, (solid / 2) * 0.5);
  }

  function handleEvents(events) {
    const me = session.me;
    if (!me) return;

    for (const ev of events) {
      switch (ev.type) {
        case 'shot': {
          const mine = ev.by === me.id;
          const from = mine ? view.muzzleWorldPosition() : ev.pos;
          const to = {
            x: ev.pos.x + ev.dir.x * 40,
            y: ev.pos.y + ev.dir.y * 40,
            z: ev.pos.z + ev.dir.z * 40,
          };
          effects.spawnTracer(from, to);
          if (mine) {
            effects.flash(from);
            view.flash();
          }
          audio.gunshot(ev.pos, distXZ(ev.pos, me.pos), mine ? 0 : muffleTo(ev.pos));
          break;
        }
        case 'impact':
          effects.spawnImpact(ev.pos, ev.normal, ev.material,
            ev.doorId ? built.doorMeshes.get(ev.doorId)?.pivot : null);
          audio.impact(ev.pos, ev.material);
          break;
        case 'hit':
          if (ev.by === me.id) {
            hud.hitMark(false);
            audio.hitMarker();
          }
          break;
        case 'death': {
          hud.killFeed(session.state, ev, me.id);
          if (ev.by === me.id) hud.hitMark(true);
          if (ev.id === me.id) {
            const killer = session.state.players[ev.by];
            hud.setDeathInfo(
              killer
                ? `${killer.name} — попадание ${ev.zone === 'head' ? 'в голову' : 'в корпус'}`
                : 'Раунд продолжается без вас',
            );
          }
          break;
        }
        case 'step':
        case 'land':
          // Your own boots included. A game that charges you for running has to
          // let you hear what running sounds like, and until now the one player
          // who could not hear your footsteps was you.
          audio.footstep(ev.pos, ev.loud, ev.surface, ev.by === me.id
            ? { own: true }
            : { muffle: muffleTo(ev.pos) });
          break;
        case 'reload':
          audio.click('reload');
          break;
        case 'dryFire':
          if (ev.by === me.id) audio.click('dry');
          break;
        case 'doorKick':
        case 'doorBreak': {
          const door = session.world.doors.find((d) => d.id === ev.doorId);
          if (door) audio.doorSound(doorEar(door), ev.type === 'doorBreak' ? 'break' : 'kick', muffleTo(doorEar(door)));
          break;
        }
        case 'doorShatter': {
          const door = session.world.doors.find((d) => d.id === ev.doorId);
          if (door) audio.impact(doorEar(door), 'glass');
          break;
        }
        case 'doorMove': {
          const door = session.world.doors.find((d) => d.id === ev.doorId);
          if (door) audio.doorSound(doorEar(door), 'creak', muffleTo(doorEar(door)));
          break;
        }
        case 'lightBreak':
          audio.impact(ev.pos, 'glass');
          break;
        case 'throw':
          audio.click('throw');
          break;
        case 'bounce':
          audio.impact(ev.pos, 'metal');
          break;
        case 'devicePlaced':
        case 'deviceBroken': {
          const door = session.world.doors.find((d) => d.id === ev.doorId);
          if (door) audio.click('device', doorEar(door));
          break;
        }
        case 'doorWedged': {
          const door = session.world.doors.find((d) => d.id === ev.doorId);
          if (door) audio.doorSound(doorEar(door), 'wedged', muffleTo(doorEar(door)));
          break;
        }
        case 'alarm': {
          const door = session.world.doors.find((d) => d.id === ev.doorId);
          if (door) audio.alarm(doorEar(door));
          break;
        }
        case 'flash':
          effects.flash(ev.pos, 3.4);
          audio.blast(ev.pos, 'flash', muffleTo(ev.pos));
          break;
        case 'deviceBlast':
          effects.flash(ev.pos, 2.6);
          audio.blast(ev.pos, 'blast', muffleTo(ev.pos));
          break;
        case 'smoke':
          audio.blast(ev.pos, 'smoke', muffleTo(ev.pos));
          break;
        case 'power':
          audio.breaker(ev.pos, ev.on);
          hud.banner(ev.on ? 'Электричество восстановлено' : 'Электричество отключено');
          break;
        case 'flare':
          audio.flare(ev.pos);
          break;
        case 'nvg':
          if (ev.by === me.id) audio.click('device');
          break;
        case 'blinded':
          // Only our own eyes are ours to white out.
          if (ev.id === me.id) hud.blindFlash(ev.amount);
          break;
        case 'roundEnd':
          if (!roundEndFired) {
            roundEndFired = true;
            onRoundEnd?.(ev.winner);
          }
          break;
        default:
          break;
      }
    }
  }

  // ── Avatars for everyone but us ─────────────────────────────────────────

  function syncAvatars(dt, eyes) {
    for (const p of Object.values(session.state.players)) {
      // Never draw the body the camera is inside — your own, or the team-mate
      // you are watching through. From in there it is a wall of jacket.
      if (p.id === eyes?.id) continue;
      let av = avatars.get(p.id);
      if (!av) {
        av = makeAvatar(p.team);
        built.scene.add(av);
        avatars.set(p.id, av);
      }
      // The dead stay on the floor: a body in a doorway is half of what you
      // know about the round you walked into.
      av.visible = true;
      setAvatarWeapon(av, p.weapon?.id);
      poseAvatar(av, p, dt);
    }
    for (const [id, av] of avatars) {
      if (!session.state.players[id]) {
        built.scene.remove(av);
        avatars.delete(id);
      }
    }
  }

  // ── Whose eyes ──────────────────────────────────────────────────────────
  //
  // Dying used to leave you looking out of your own corpse: the camera stayed
  // where you fell and you could turn your head, which in a round that runs a
  // quarter of an hour is a long time staring at a skirting board. Now the
  // picture moves to somebody on your side who is still standing.
  //
  // It is his view, not a free camera — his position, his aim, his sight
  // picture — so nothing reaches you that he could not see himself. That is
  // the whole reason to do it this way round: a camera you could fly through
  // walls would hand a dead man the enemy's position, and in a game where the
  // living team-mate is meant to be the one with the information, that is
  // worse than a black screen.
  //
  // Nobody left to watch, and you stay where you fell — there is no third
  // thing to show, and the body on the floor is at least honest.
  // Who to watch is a rule, and lives with the rules — see spectateTarget in
  // src/sim/sim.js. All that belongs here is the key: Space steps to the next
  // man, on the press rather than for every frame it is held down.
  let spectateId = null;
  let cycleHeld = false;

  function viewer() {
    const me = session.me;
    if (!me) return null;
    const wants = input.isDown('jump');
    const step = wants && !cycleHeld;
    cycleHeld = wants;

    const mate = spectateTarget(session.state, me, spectateId, step);
    spectateId = mate?.id ?? null;
    hud.setSpectateChoice(me.alive ? 0 : mates(me));
    return mate ?? me;
  }

  // Only for the hint: whether there is more than one man to choose between.
  function mates(me) {
    let n = 0;
    for (const p of Object.values(session.state.players)) {
      if (p.alive && p.team === me.team && p.id !== me.id) n++;
    }
    return n;
  }

  // ── Prompt ──────────────────────────────────────────────────────────────

  function updatePrompt(me) {
    if (!me?.alive) {
      hud.setPrompt(null);
      return;
    }
    const target = lookTarget(session.world, session.state, me);
    if (!target) {
      hud.setPrompt(null);
      return;
    }
    if (target.kind === 'switch') {
      hud.setPrompt(target.on
        ? `${target.name} · <kbd>F</kbd> вырубить свет во всём здании`
        : `${target.name} · <kbd>F</kbd> включить свет`);
      return;
    }
    if (target.locked) {
      hud.setPrompt('Заперто · <kbd>V</kbd> выбить ногой');
      return;
    }
    if (target.forced) {
      hud.setPrompt('Замок выбит — дверь не закрыть');
      return;
    }
    const closing = target.target > 0.5;
    const verb = closing ? 'закрыть' : 'открыть';
    // The quiet step is a mode, so the door follows whatever mode you are in.
    hud.setPrompt(me.sneaking
      ? `<kbd>F</kbd> ${verb} тихо · <kbd>V</kbd> ногой`
      : `<kbd>F</kbd> ${verb} · <kbd>Tab</kbd> тихий шаг · <kbd>V</kbd> ногой`);
  }

  // ── What the room around the listener sounds like ─────────────────────────
  //
  // Six rays out of the head — four along the floor plan, one up, one down —
  // and the average of what they hit is the size of the space you are standing
  // in. A bathroom answers at two metres, a bedroom at four, the living court
  // at twenty because the ray going up never comes back at all.
  //
  // That average picks the tail: tight, room, or the open court. It is measured
  // four times a second rather than every frame, because a man does not change
  // rooms sixty times a second and six raycasts are not free.
  const EAR_RAYS = [
    { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
    { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  ];
  const EAR_REACH = 22;
  // What a surface does to a sound that hits it. This, not the size of the
  // room, is why a bathroom rings and a bedroom does not: the two are much the
  // same number of metres across, and one is porcelain while the other is
  // plaster, carpet and a bed.
  const HARDNESS = {
    tile: 1.0, concrete: 0.95, glass: 0.9, metal: 1.0,
    floor: 0.55, wood: 0.45, drywall: 0.3, fabric: 0.0,
  };
  let earTimer = 0;

  function listenToRoom(player, dt) {
    earTimer -= dt;
    if (earTimer > 0) return;
    earTimer = 0.25;

    const ear = eyePosition(player);
    let sum = 0;
    // How much of what is around is hard. Tile and concrete throw a sound back;
    // a bedroom full of cloth swallows it, and that difference is audible.
    let hard = 0;
    for (const dir of EAR_RAYS) {
      const hit = raycastGeometry(session.world, session.state, ear, dir, EAR_REACH)[0];
      sum += hit ? hit.t : EAR_REACH;
      hard += hit ? (HARDNESS[hit.material.name] ?? 0.5) : 0;
    }
    const size = sum / EAR_RAYS.length;

    // Crossfade across the three tails by size, and let the hard surfaces
    // decide how much of it comes back.
    const toRoom = Math.max(0, Math.min(1, (size - 2.2) / 2.6));
    const toHall = Math.max(0, Math.min(1, (size - 6.0) / 5.0));
    audio.setSpace({
      tight: (1 - toRoom),
      room: toRoom * (1 - toHall),
      hall: toHall,
      wet: 0.22 + (hard / EAR_RAYS.length) * 0.5,
    });
  }

  // ── Main loop ───────────────────────────────────────────────────────────

  // Moving the round on, and drawing a picture of it, are two jobs rather than
  // one. Normally the clock decides how much of each happens and they run back
  // to back, which is the loop below. Kept apart, they can also be driven by
  // hand — see `advance` — and that is the difference between a screenshot tool
  // that waits on a browser's clock and one that says "thirty seconds in" and
  // gets there at once.
  function simulate(ticks) {
    for (let i = 0; i < ticks; i++) {
      session.tick(input.sample(), DT);
      handleEvents(session.drainEvents());
    }
    if (session.state.phase !== lastPhase) {
      const prev = lastPhase;
      lastPhase = session.state.phase;
      onPhase?.(lastPhase, prev);
    }
  }

  function present(dtReal) {
    const me = session.me;
    // Whose eyes the picture comes from. Yours while you are alive; a living
    // team-mate's once you are not.
    const eyes = viewer();
    const watching = eyes && me && eyes.id !== me.id;
    if (eyes) {
      const moving = Math.hypot(eyes.vel.x, eyes.vel.z) > 0.4;
      view.update(eyes, dtReal, moving, wallAhead(eyes));
      // Whatever the sight is magnifying, the mouse is divided by. Not while
      // watching somebody else — the mouse is not moving that view.
      input.setZoom(watching ? 1 : view.zoom);
      // ...and if that glass is a scope, the screen becomes the eyepiece.
      hud.setScope(view.scoped);
      audio.setListener(view.camera.position, forwardOf(view.camera));
      listenToRoom(eyes, dtReal);
      // The vitals belong to the man whose eyes these are, or the bar would
      // read empty over a picture of somebody very much alive.
      hud.update(session.state, eyes, dtReal, watching ? eyes.name : null);
      updatePrompt(watching ? null : me);
    }
    hud.setClickToPlay(!input.locked);

    syncDoors(built, session.state);
    syncLights(built, session.state, eyes ? eyes.pos.y : 0, !!eyes?.nvg);
    // Smoke you are standing in is not an object in front of the camera, it is
    // the air the camera is in — so it is the scene's fog that draws it.
    syncSmokeFog(built, session.state, view.camera.position);
    // A tube also opens the iris: everything already lit reads brighter, which
    // is why a lamp through night vision is painful and a flare is worse.
    renderer.toneMappingExposure = eyes?.nvg ? NVG.exposure : 1.0;
    equipment.sync(session.state, session.world, view.camera);
    syncAvatars(dtReal, eyes);
    effects.update(dtReal);

    const wantScoreboard = input.isDown('scoreboard');
    if (wantScoreboard !== scoreboardVisible) {
      scoreboardVisible = wantScoreboard;
      hud.scoreboard(session.state, session.localId, session.pings, scoreboardVisible);
    } else if (scoreboardVisible) {
      hud.scoreboard(session.state, session.localId, session.pings, true);
    }

    // World first, then the weapon on a cleared depth buffer so it always sits
    // in front and never intersects geometry.
    renderer.render(built.scene, view.camera);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(view.viewScene, view.viewCamera);
    renderer.autoClear = true;
  }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    if (!running) return;

    let dtReal = (now - lastTime) / 1000;
    lastTime = now;
    // A tab that was backgrounded shouldn't fast-forward the match.
    if (dtReal > 0.25) dtReal = 0.25;
    accumulator += dtReal;

    let ticks = 0;
    while (accumulator >= DT && ticks < MAX_CATCHUP_TICKS) {
      accumulator -= DT;
      ticks++;
    }
    if (ticks === MAX_CATCHUP_TICKS) accumulator = 0;

    simulate(ticks);
    present(dtReal);
  }

  // Distance to whatever the player is pointing at, within arm's reach. The
  // view uses it to raise the muzzle instead of pushing it through the wall.
  const WEAPON_PROBE = 1.4;
  function wallAhead(player) {
    const hits = raycastGeometry(
      session.world,
      session.state,
      eyePosition(player),
      aimDirection(player),
      WEAPON_PROBE,
    );
    return hits.length ? hits[0].t : Infinity;
  }

  function forwardOf(camera) {
    const v = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    return { x: v.x, y: v.y, z: v.z };
  }

  // ── Public surface ──────────────────────────────────────────────────────

  input.onLockChange((locked) => {
    canvas.classList.toggle('unlocked', !locked);
    if (!locked && running) onPause?.();
  });

  return {
    start() {
      running = true;
      lastTime = performance.now();
      accumulator = 0;
      hud.show(true);
      audio.resume();
      if (!rafId) rafId = requestAnimationFrame(frame);
    },
    pause() {
      running = false;
    },
    resume() {
      running = true;
      lastTime = performance.now();
      accumulator = 0;
    },
    nextRound() {
      session.nextRound();
      roundEndFired = false;
      effects.clearDecals();
    },
    // Run the round forward on the spot and draw the result, whether or not the
    // loop above is running. A round is paced by requestAnimationFrame, and
    // under a software renderer that clock crawls — a minute of round costs
    // twenty minutes of waiting — so a tool that wants to photograph the state
    // of things at some point in the round asks for it instead of sitting out
    // the wait. Used by the debug handle; nothing in the game calls it.
    advance(ticks) {
      simulate(ticks);
      present(DT);
    },
    get session() {
      return session;
    },
    get view() {
      return view;
    },
    // The world's scene, for the debug handle only. Nothing in the game reads
    // it: the runtime is the only thing that should be touching the graph.
    get scene() {
      return built.scene;
    },
    get hud() {
      return hud;
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
      rafId = 0;
      hud.show(false);
      hud.scoreboard(session.state, session.localId, session.pings, false);
      window.removeEventListener('resize', resize);
      for (const av of avatars.values()) built.scene.remove(av);
      avatars.clear();
      built.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
      renderer.dispose();
      session.dispose();
    },
  };
}
