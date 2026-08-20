// The runtime: drives a session at a fixed tick rate and turns its state into
// pictures and sound. Knows nothing about menus or networking.

import * as THREE from '../vendor/three.module.js?v=3d9441b4';
import {
  buildScene, syncDoors, syncLights, makeAvatar, poseAvatar, setAvatarWeapon,
  createEquipmentView,
} from './render/scene.js?v=3d9441b4';
import { createEffects } from './render/effects.js?v=3d9441b4';
import { createView } from './render/view.js?v=3d9441b4';
import { createHud } from './ui/hud.js?v=3d9441b4';
import { DT } from './sim/constants.js?v=3d9441b4';
import { lookTarget, eyePosition, aimDirection } from './sim/sim.js?v=3d9441b4';
import { raycastGeometry } from './sim/world.js?v=3d9441b4';
import { distXZ } from './sim/math.js?v=3d9441b4';

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
          audio.gunshot(ev.pos, distXZ(ev.pos, me.pos));
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
          if (ev.by !== me.id) audio.footstep(ev.pos, ev.loud);
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
          if (door) audio.doorSound(doorEar(door), ev.type === 'doorBreak' ? 'break' : 'kick');
          break;
        }
        case 'doorShatter': {
          const door = session.world.doors.find((d) => d.id === ev.doorId);
          if (door) audio.impact(doorEar(door), 'glass');
          break;
        }
        case 'doorMove': {
          const door = session.world.doors.find((d) => d.id === ev.doorId);
          if (door) audio.doorSound(doorEar(door), 'creak');
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
          if (door) audio.doorSound(doorEar(door), 'wedged');
          break;
        }
        case 'alarm': {
          const door = session.world.doors.find((d) => d.id === ev.doorId);
          if (door) audio.alarm(doorEar(door));
          break;
        }
        case 'flash':
          effects.flash(ev.pos, 3.4);
          audio.blast(ev.pos, 'flash');
          break;
        case 'deviceBlast':
          effects.flash(ev.pos, 2.6);
          audio.blast(ev.pos, 'blast');
          break;
        case 'smoke':
          audio.blast(ev.pos, 'smoke');
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

  function syncAvatars() {
    const me = session.me;
    for (const p of Object.values(session.state.players)) {
      if (p.id === me?.id) continue;
      let av = avatars.get(p.id);
      if (!av) {
        av = makeAvatar(p.team);
        built.scene.add(av);
        avatars.set(p.id, av);
      }
      av.visible = p.alive;
      if (!p.alive) continue;
      setAvatarWeapon(av, p.weapon?.id);
      poseAvatar(av, p);
    }
    for (const [id, av] of avatars) {
      if (!session.state.players[id]) {
        built.scene.remove(av);
        avatars.delete(id);
      }
    }
  }

  // ── Prompt ──────────────────────────────────────────────────────────────

  function updatePrompt() {
    const me = session.me;
    if (!me?.alive) {
      hud.setPrompt(null);
      return;
    }
    const target = lookTarget(session.world, session.state, me);
    if (!target) {
      hud.setPrompt(null);
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

  // ── Main loop ───────────────────────────────────────────────────────────

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
      const frameInput = input.sample();
      session.tick(frameInput, DT);
      handleEvents(session.drainEvents());
      accumulator -= DT;
      ticks++;
    }
    if (ticks === MAX_CATCHUP_TICKS) accumulator = 0;

    if (session.state.phase !== lastPhase) {
      const prev = lastPhase;
      lastPhase = session.state.phase;
      onPhase?.(lastPhase, prev);
    }

    const me = session.me;
    if (me) {
      const moving = Math.hypot(me.vel.x, me.vel.z) > 0.4;
      view.update(me, dtReal, moving, wallAhead(me));
      audio.setListener(view.camera.position, forwardOf(view.camera));
      hud.update(session.state, me, dtReal);
      updatePrompt();
    }
    hud.setClickToPlay(!input.locked);

    syncDoors(built, session.state);
    syncLights(built, session.state, me ? me.pos.y : 0);
    equipment.sync(session.state, session.world);
    syncAvatars();
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
    get session() {
      return session;
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
