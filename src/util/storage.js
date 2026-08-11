// Safe access to localStorage.
//
// Reading localStorage can throw outright — not return null, throw — when the
// browser blocks storage for the origin (strict privacy settings, private
// windows, embedded frames). An unguarded read at module load takes down the
// whole script with it, which looks to the player like dead buttons.
//
// Saving preferences is a nicety. It must never be able to break the game.

let warned = false;

function warnOnce(err) {
  if (warned) return;
  warned = true;
  console.warn('Settings will not persist: storage is unavailable.', err);
}

export function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

export function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (err) {
    warnOnce(err);
    return false;
  }
}
