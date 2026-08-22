// Switches read off the address bar.
//
// These exist for taking pictures of the game rather than playing it. The rule
// they all follow: with no query string every one of them is false and the code
// they turn on never runs, so what a visitor to the published site gets is
// exactly what it was before this file existed.
//
//   ?debug=1  hangs window.__gfu on the page — state, teleport, run the clock
//   ?still=1  stops the weapon breathing, swaying and recoiling
//   ?solo=1   goes straight into a solo match instead of waiting for a click
//   ?bots=N   how many opponents that match has, when ?solo started it
//   ?mates=N  ...and how many are on your side
//
// Any value counts as on except an explicit 0 or false, so ?debug and ?debug=1
// mean the same thing.

const q = new URLSearchParams(location.search);

function on(name) {
  const v = q.get(name);
  return v !== null && v !== '0' && v !== 'false';
}

export const DEBUG = on('debug');
export const STILL = on('still');
export const AUTO_SOLO = on('solo');

// Only read when ?solo started the match; the menu button keeps its own number.
export const SOLO_BOTS = q.has('bots') ? Math.max(0, Number(q.get('bots')) || 0) : 2;
export const SOLO_MATES = q.has('mates') ? Math.max(0, Number(q.get('mates')) || 0) : 1;
