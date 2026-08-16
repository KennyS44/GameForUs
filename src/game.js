// The runtime: drives a session at a fixed tick rate and turns its state into
// pictures and sound. Knows nothing about menus or networking.

import * as THREE from '../vendor/three.module.js?v=dd0e4e06';
import { buildScene, syncDoors, syncLights, makeAvatar } from './render/scene.js?v=dd0e4e06';
import { createEffects } from './render/effects.js?v=dd0e4e06';
import { createView } from './render/view.js?v=dd0e4e06';
import { createHud } from './ui/hud.js?v=dd0e4e06';
import { DT, PLAYER } from './sim/constants.js?v=dd0e4e06';
import { lookTarget, eyePosition, aimDirection } from './sim/sim.js?v=dd0e4e06';
import { raycastGeometry } from './sim/world.js?v=dd0e4e06';
import { distXZ } from './sim/math.js?v=dd0e4e06';

const MAX_CATCHUP_TICKS = 12; // bound catch-up work after a stall, without
                              // dropping into slow motion on a weak machine

export function createGame({ canvas, session, audio, input, onPause, onRoundEnd }) {
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
  const hud = createHud();

  const avatars = new Map();
  let accumulator = 0;
  let lastTime = performance.now();
  let running = false;
  let rafId = 0;
  let scoreboardVisible = false;
  let roundEndFired = false;

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
          effects.spawnImpact(ev.pos, ev.normal, ev.material);
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
      const h = PLAYER.heightCrouch + (PLAYER.heightStand - PLAYER.heightCrouch) * p.stance;
      av.position.set(p.pos.x, p.pos.y, p.pos.z);
      av.scale.y = h / PLAYER.heightStand;
      av.rotation.y = p.look.yaw;
      // Tilt with their lean, so a peeking shoulder reads correctly.
      av.rotation.z = -(p.lean ?? 0) * PLAYER.leanAngle;
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
    hud.setPrompt(
      `<kbd>F</kbd> ${closing ? 'закрыть' : 'открыть'} · <kbd>Tab+F</kbd> тихо · <kbd>V</kbd> ногой`,
    );
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
    syncLights(built, session.state);
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
