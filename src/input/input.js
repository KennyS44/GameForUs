// Keyboard and mouse -> a plain input object for the simulation.
// Nothing here knows about the game rules; it only reports intent.

import { createInput } from '../sim/sim.js?v=bc0527d3';
import { LOOK } from '../sim/constants.js?v=bc0527d3';
import { clamp } from '../sim/math.js?v=bc0527d3';
import { storageGet, storageSet } from '../util/storage.js?v=bc0527d3';

export const DEFAULT_BINDINGS = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sprint: 'ShiftLeft',
  sneak: 'Tab',
  crouch: 'ControlLeft',
  leanLeft: 'KeyQ',
  leanRight: 'KeyE',
  use: 'KeyF',
  kick: 'KeyV',
  flashlight: 'KeyT',
  reload: 'KeyR',
  scoreboard: 'KeyB',
};

const SETTINGS_KEY = 'gameforus.settings';

export function loadSettings() {
  const defaults = { sensitivity: 0.0022, invertY: false };
  try {
    const raw = storageGet(SETTINGS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults; // corrupt JSON — fall back rather than break the game
  }
}

export function saveSettings(s) {
  storageSet(SETTINGS_KEY, JSON.stringify(s));
}

export function createInputSource(canvas, bindings = DEFAULT_BINDINGS) {
  const keys = new Set();
  const settings = loadSettings();

  const look = { yaw: 0, pitch: 0 };
  let mouseDown = 0; // bitmask
  // Edge-triggered actions: consumed once by the next input frame.
  const pending = { use: false, kick: false, flashlight: false, reload: false, jump: false };
  // Sneaking is a mode you switch on, not a key you hold down: creeping across
  // a flat takes long enough that holding a key the whole way is just a chore.
  let sneaking = false;
  let locked = false;
  const listeners = { lockChange: [] };

  // While the game has the mouse, the keyboard belongs to the game. Without
  // this, crouching (Ctrl) and opening a door (F) together fire the browser's
  // find bar, which steals focus and breaks the round. Escape must still work
  // so the player can always let the cursor go, and the function keys are left
  // alone so developer tools stay reachable.
  function swallowBrowserShortcut(e) {
    if (!locked) return;
    if (e.code === 'Escape' || /^F\d{1,2}$/.test(e.code)) return;
    e.preventDefault();
  }

  function onKeyDown(e) {
    swallowBrowserShortcut(e);
    if (keys.has(e.code)) return; // ignore auto-repeat for edge actions
    keys.add(e.code);
    if (e.code === bindings.use) pending.use = true;
    if (e.code === bindings.kick) pending.kick = true;
    if (e.code === bindings.flashlight) pending.flashlight = true;
    if (e.code === bindings.reload) pending.reload = true;
    if (e.code === bindings.jump) pending.jump = true;
    if (e.code === bindings.sneak) sneaking = !sneaking;
    // Breaking into a run is a decision to be loud: it drops the mode there
    // and then, rather than fighting it while you move.
    if (e.code === bindings.sprint) sneaking = false;
  }
  function onKeyUp(e) {
    swallowBrowserShortcut(e);
    keys.delete(e.code);
  }
  function onMouseMove(e) {
    if (!locked) return;
    look.yaw -= e.movementX * settings.sensitivity;
    const dy = e.movementY * settings.sensitivity * (settings.invertY ? 1 : -1);
    look.pitch = clamp(look.pitch + dy, -LOOK.pitchLimit, LOOK.pitchLimit);
    // Keep yaw in a sane range so it never loses float precision over a session.
    if (look.yaw > Math.PI) look.yaw -= Math.PI * 2;
    if (look.yaw < -Math.PI) look.yaw += Math.PI * 2;
  }
  function onMouseDown(e) {
    if (!locked) return;
    mouseDown |= 1 << e.button;
  }
  function onMouseUp(e) {
    mouseDown &= ~(1 << e.button);
  }
  function onBlur() {
    keys.clear();
    mouseDown = 0;
  }

  function setSneaking(v) {
    sneaking = !!v;
  }
  function onLockChange() {
    locked = document.pointerLockElement === canvas;
    if (!locked) onBlur();
    listeners.lockChange.forEach((fn) => fn(locked));
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  document.addEventListener('pointerlockchange', onLockChange);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    settings,
    get locked() {
      return locked;
    },
    onLockChange(fn) {
      listeners.lockChange.push(fn);
    },
    // Browsers only grant pointer lock from a user gesture. A client whose
    // round is started by a network message has no gesture to offer, so this
    // is allowed to fail quietly — the caller shows a "click to play" hint.
    requestLock() {
      try {
        const result = canvas.requestPointerLock?.();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        /* no gesture available; the click handler will pick it up */
      }
    },
    releaseLock() {
      document.exitPointerLock?.();
    },
    isDown(action) {
      return keys.has(bindings[action]);
    },
    setLook(yaw, pitch) {
      look.yaw = yaw;
      look.pitch = pitch;
    },
    getLook() {
      return { ...look };
    },

    get sneaking() {
      return sneaking;
    },
    setSneaking,

    // Build one simulation input frame and clear edge-triggered actions.
    sample() {
      const i = createInput();
      if (!locked) {
        i.yaw = look.yaw;
        i.pitch = look.pitch;
        return i;
      }
      i.moveZ = (keys.has(bindings.forward) ? 1 : 0) - (keys.has(bindings.back) ? 1 : 0);
      i.moveX = (keys.has(bindings.right) ? 1 : 0) - (keys.has(bindings.left) ? 1 : 0);
      i.run = keys.has(bindings.sprint);
      if (i.run) sneaking = false; // held down from before the mode went on
      i.sneak = sneaking;
      i.crouch = keys.has(bindings.crouch);
      i.jump = pending.jump;
      i.lean = (keys.has(bindings.leanRight) ? 1 : 0) - (keys.has(bindings.leanLeft) ? 1 : 0);
      i.yaw = look.yaw;
      i.pitch = look.pitch;
      // MouseEvent.button: 0 left, 1 middle, 2 right — so right is bit 2.
      i.fire = (mouseDown & (1 << 0)) !== 0;
      i.aim = (mouseDown & (1 << 2)) !== 0;

      i.use = pending.use;
      i.kick = pending.kick;
      i.toggleLight = pending.flashlight;
      i.reload = pending.reload;
      pending.use = pending.kick = pending.flashlight = pending.reload = pending.jump = false;
      return i;
    },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('pointerlockchange', onLockChange);
    },
  };
}
