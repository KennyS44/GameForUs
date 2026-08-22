// Entry point: menus, room setup, and starting a match.

import { APARTMENT } from './maps/apartment.js?v=09f108eb';
// The same projection tools/floorplan.mjs draws the sheets with, so a mark and
// the wall it is next to are worked out from one set of numbers.
import { PLAN, UPPER_FROM } from './maps/plan.js?v=09f108eb';
import { createGame } from './game.js?v=09f108eb';
import { createAudio } from './audio/audio.js?v=09f108eb';
import { createInputSource, saveSettings } from './input/input.js?v=09f108eb';
import { createLocalSession, createHostSession, createClientSession } from './net/session.js?v=09f108eb';
import {
  createHostTransport, createClientTransport, makeRoomCode, normaliseCode,
} from './net/transport.js?v=09f108eb';
import { createLoadout } from './ui/loadout.js?v=09f108eb';
import { createArmoury, savedOptics, saveOptic } from './ui/armoury.js?v=09f108eb';
import { storageGet, storageSet } from './util/storage.js?v=09f108eb';
import { DEBUG, AUTO_SOLO, AUTO_RANGE, SOLO_BOTS, SOLO_MATES } from './util/flags.js?v=09f108eb';
import { swapsSides } from './sim/sim.js?v=09f108eb';

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const overlay = $('overlay');
const screens = {
  main: $('screen-main'),
  armoury: $('screen-armoury'),
  lobby: $('screen-lobby'),
  loadout: $('screen-loadout'),
  plan: $('screen-plan'),
  pause: $('screen-pause'),
  round: $('screen-round'),
  loading: $('screen-loading'),
};

// A pointer-locked FPS needs a mouse; say so plainly rather than half-working.
const isTouchOnly = matchMedia('(hover: none) and (pointer: coarse)').matches;
if (isTouchOnly || !('requestPointerLock' in Element.prototype)) {
  $('desktop-only').hidden = false;
  overlay.hidden = true;
}

const audio = createAudio();
const input = createInputSource(canvas);

let game = null;
let transport = null;
let pendingWelcome = null;
const NAME_KEY = 'gameforus.name';
// The gun the armoury and the range were last pointed at.
const WEAPON_KEY = 'gameforus.lastWeapon';

// ── Screens ───────────────────────────────────────────────────────────────

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  overlay.hidden = false;
}

function hideOverlay() {
  overlay.hidden = true;
}

// ── Weapon selection ──────────────────────────────────────────────────────
//
// The screen is open while the round is choosing weapons, and it polls the
// state ten times a second instead of riding the render loop: that is plenty
// for a countdown, and it keeps the runtime free of menus.

const loadout = createLoadout({
  // The one place a choice reaches the game. Both roads lead here: the button
  // and the countdown running out.
  onConfirm: ({ weapon, gadget, optic, reason }) => {
    game?.session.chooseWeapon?.(weapon);
    game?.session.chooseGadget?.(gadget);
    // A sight is not handed back at the end of the round the way the gun and
    // the device are, and it outlives the match as well: changing your mind
    // here writes it into the armoury, so the rifle stays set up next time.
    if (optic) {
      game?.session.chooseOptic?.(weapon, optic);
      saveOptic(weapon, optic);
    }
    stopLoadoutPolling();
    // Confirmed by hand, with time still on the clock: the minute that follows
    // is the defence taking the flat, and there is nothing for an attacker to
    // do in it. Hand him the plans instead of a wall to look at — and a way
    // back to the racks, because a choice you cannot change is a misclick.
    if (reason === 'player' && staging()) openPlan();
    else closeLoadout();
  },
});
let loadoutPoll = 0;

function refreshLoadout() {
  if (game) loadout.update(game.session.state, game.session.me);
}

function openLoadout() {
  if (!game) return;
  loadout.reset(); // a new round is a new decision
  showLoadout();
}

// Back from the plans to the racks: the same screen, still holding what you
// picked, waiting to be confirmed again.
function reopenLoadout() {
  if (!game) return;
  loadout.reopen();
  showLoadout();
}

function showLoadout() {
  showScreen('loadout'); // shown first: onPause reads it to know this is not a pause
  input.releaseLock();
  refreshLoadout();
  if (!loadoutPoll) loadoutPoll = setInterval(refreshLoadout, 100);
}

function stopLoadoutPolling() {
  clearInterval(loadoutPoll);
  loadoutPoll = 0;
}

function closeLoadout() {
  stopLoadoutPolling();
  if (screens.loadout.hidden) return;
  hideOverlay();
  input.requestLock();
}

// ── The plans ─────────────────────────────────────────────────────────────
//
// Two sheets and your own side's positions on them. Open while the round is
// still getting ready; gone the moment it starts.

let planPoll = 0;

function staging() {
  const phase = game?.session.state.phase;
  return phase === 'select' || phase === 'prep';
}

function refreshPlan() {
  if (!game) return;
  const state = game.session.state;
  if (!staging()) { closePlan(); return; }

  const selecting = state.phase === 'select';
  $('plan-phase').textContent = selecting ? 'До подготовки' : 'До начала';
  $('plan-timer').textContent = `0:${String(Math.ceil(Math.max(0, state.phaseTime))).padStart(2, '0')}`;
  // Changing your mind is only possible while nothing has been taken yet.
  $('btn-plan-back').hidden = !selecting;

  const me = game.session.me;
  const marks = { ground: [], upper: [] };
  for (const id of Object.keys(state.players)) {
    const p = state.players[id];
    // Your own side only. Everything else you have to find out the hard way.
    if (!p.alive || !me || p.team !== me.team) continue;
    const floor = p.pos.y >= UPPER_FROM ? 'upper' : 'ground';
    marks[floor].push(
      `<i class="plan-mark${p.id === me.id ? ' self' : ''}" style="left:${
        ((PLAN.left + (p.pos.x - PLAN.x0) * PLAN.scale) / PLAN.w * 100).toFixed(2)
      }%;top:${
        ((PLAN.top + (p.pos.z - PLAN.z0) * PLAN.scale) / PLAN.h * 100).toFixed(2)
      }%"></i>`,
    );
  }
  $('plan-marks-ground').innerHTML = marks.ground.join('');
  $('plan-marks-upper').innerHTML = marks.upper.join('');
}

function openPlan() {
  if (!game || !staging()) return;
  stopLoadoutPolling();
  showScreen('plan');
  input.releaseLock();
  refreshPlan();
  if (!planPoll) planPoll = setInterval(refreshPlan, 200);
}

function closePlan() {
  clearInterval(planPoll);
  planPoll = 0;
  if (screens.plan.hidden) return;
  hideOverlay();
  input.requestLock();
}

$('btn-plan-close').addEventListener('click', closePlan);
$('btn-plan-back').addEventListener('click', () => {
  clearInterval(planPoll);
  planPoll = 0;
  reopenLoadout();
});

// M for the plans, while there is still nothing to shoot at. Ignored the
// moment the round goes live: a man reading a map is a man not watching a
// doorway, and this game does not do that to you.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
  if (/^(INPUT|TEXTAREA)$/.test(e.target?.tagName ?? '')) return;
  if (!game || !staging()) return;
  if (!screens.loadout.hidden) return;
  e.preventDefault();
  if (screens.plan.hidden) openPlan(); else closePlan();
});



function setStatus(el, msg, kind = '') {
  el.textContent = msg;
  el.className = `net-status ${kind}`;
}

// ── Settings ──────────────────────────────────────────────────────────────

const sensEl = $('sens');
const volEl = $('vol');
const invertEl = $('invert-y');

sensEl.value = (input.settings.sensitivity * 1000).toFixed(1);
invertEl.checked = input.settings.invertY;
$('sens-value').textContent = sensEl.value;
$('vol-value').textContent = volEl.value;

sensEl.addEventListener('input', () => {
  input.settings.sensitivity = Number(sensEl.value) / 1000;
  $('sens-value').textContent = sensEl.value;
  saveSettings(input.settings);
});
volEl.addEventListener('input', () => {
  $('vol-value').textContent = volEl.value;
  audio.setVolume(Number(volEl.value) / 100);
});
invertEl.addEventListener('change', () => {
  input.settings.invertY = invertEl.checked;
  saveSettings(input.settings);
});

const nameEl = $('player-name');
nameEl.value = storageGet(NAME_KEY) || '';
nameEl.addEventListener('change', () => {
  storageSet(NAME_KEY, nameEl.value.trim().slice(0, 14));
});

function playerName() {
  const n = nameEl.value.trim().slice(0, 14);
  return n || 'Игрок';
}

// ── The armoury, and the range next door ──────────────────────────────────
//
// Setting a rack up is not the same job as picking a gun with a round about to
// start, so it gets a room of its own with no clock in it. The range is a
// second map with nobody else on it: one man, one weapon, and something to
// shoot at until the sight either makes sense or does not.

const armoury = createArmoury({
  onRange: (weaponId) => startRange(weaponId),
  onBack: () => showScreen('main'),
});

$('btn-armoury').addEventListener('click', () => showMenu('armoury'));

// Opening a menu screen from outside, which is what a screenshot tool needs:
// some of them have to be filled in before they mean anything, and only this
// file knows which.
function showMenu(name) {
  if (name === 'armoury') armoury.open(lastWeapon());
  showScreen(name);
}

// Whatever is in hand, so the armoury opens on the gun you were last using
// rather than on the top of the list.
function lastWeapon() {
  return game?.session.me?.loadout ?? storageGet(WEAPON_KEY) ?? null;
}

async function startRange(weaponId) {
  audio.resume();
  showScreen('loading');
  $('loading-detail').textContent = 'Открываем полигон…';
  storageSet(WEAPON_KEY, weaponId);
  let RANGE;
  try {
    ({ RANGE } = await import('./maps/range.js?v=09f108eb'));
  } catch {
    setStatus($('net-status'), 'Полигон не открылся.', 'error');
    showScreen('armoury');
    return;
  }
  requestAnimationFrame(() => {
    // Nobody to fight: no defenders means the round cannot be won or lost, so
    // it simply runs, which is what a range is.
    const session = createLocalSession({ map: RANGE, name: playerName(), bots: 0, mates: 0 });
    session.chooseWeapon?.(weaponId);
    for (const [w, o] of Object.entries(savedOptics())) session.chooseOptic?.(w, o);
    onRange = true;
    // Past the racks and the staging minute before the runtime ever sees the
    // round, not after: there is nothing to stage on a range and nobody to
    // hide from, and doing it afterwards flashed the loadout screen up for as
    // long as it took the loop to notice — long enough to see, and long enough
    // that the pause screen refused to open while it was there.
    session.state.phase = 'live';
    session.state.phaseTime = 3600;
    startGame(session);
  });
}

// Leaving the range goes back to the armoury rather than to the main menu,
// because you came from there to answer a question about a sight.
let onRange = false;

// ── Starting a match ──────────────────────────────────────────────────────

function startGame(session) {
  game?.stop();
  game = createGame({
    canvas,
    session,
    audio,
    input,
    onPause: () => {
      // Choosing a weapon releases the mouse too, and that is not a pause: the
      // countdown has to keep running or nobody ever reaches the round.
      if (!screens.loadout.hidden || !screens.plan.hidden) return;
      // In a live match the world keeps turning while you're in the menu —
      // stopping the host would freeze everyone else. Alone against bots
      // nobody else is waiting, so the round really does stop.
      const solo = session.kind === 'local';
      if (solo) game.pause();
      // The range is not a match, so the pause screen must not talk like one.
      // The way out of it was there all along — Escape, then the button that
      // said "leave the match" — which is a poor sign to hang over the only
      // door in a room you came into to try a sight for ten seconds.
      $('pause-hint').textContent = onRange
        ? 'Полигон. Стрельба остановлена, Escape — вернуться к ней.'
        : solo
          ? 'Раунд остановлен. Escape — вернуться в игру.'
          : 'Раунд продолжается. Вас всё ещё можно убить.';
      $('btn-quit').textContent = onRange ? 'В оружейную' : 'Выйти из матча';
      if (screens.round.hidden) showScreen('pause');
    },
    onPhase: (phase) => {
      if (phase === 'select') openLoadout();
      else closeLoadout();
      // Whatever is on screen, the round starting takes it away.
      if (phase !== 'select' && phase !== 'prep') closePlan();
    },
    onRoundEnd: (winner) => {
      const iWon = session.me?.team === winner;
      $('round-result').textContent = iWon ? 'Победа' : 'Поражение';
      const how = winner === 'attackers'
        ? 'Штурмовая группа зачистила пентхаус.'
        : 'Оборона удержала пентхаус.';
      // Which side you are on next is the first thing worth knowing, because
      // the two share nothing but the walls: one carries a breach charge, the
      // other wedges and a tripwire. Said here rather than left for the player
      // to notice on the loadout screen, where the kit row quietly changes.
      const swapping = swapsSides(session.state.round + 1);
      const mine = session.me?.team;
      const next = swapping
        ? (mine === 'attackers' ? 'defenders' : 'attackers')
        : mine;
      $('round-detail').textContent = swapping && mine
        ? `${how} Меняетесь сторонами: следующий раунд вы за ${next === 'attackers' ? 'штурм' : 'оборону'}.`
        : how;
      $('btn-next').hidden = session.kind === 'client';
      input.releaseLock();
      showScreen('round');
    },
  });
  // The armoury's choices are a preference, not simulation state, so they have
  // to be handed over at the start of every match. The simulation is still the
  // authority: anything it refuses simply stays as the weapon shipped.
  for (const [weaponId, opticId] of Object.entries(savedOptics())) {
    session.chooseOptic?.(weaponId, opticId);
  }
  audio.setVolume(Number(volEl.value) / 100);
  game.start();
  if (session.state.phase === 'select') {
    openLoadout();
  } else {
    hideOverlay();
    input.requestLock();
  }
}

// Pointer lock can only be requested from a user gesture, so clicking the
// canvas is how you get back in.
canvas.addEventListener('click', () => {
  if (game && overlay.hidden && !input.locked) input.requestLock();
});

// ── Solo ──────────────────────────────────────────────────────────────────

function startSolo(bots = SOLO_BOTS, mates = SOLO_MATES) {
  audio.resume();
  showScreen('loading');
  $('loading-detail').textContent = 'Собираем пентхаус…';
  // One frame of breathing room so the loading screen actually paints.
  requestAnimationFrame(() => {
    const session = createLocalSession({ map: APARTMENT, name: playerName(), bots, mates });
    startGame(session);
  });
}

$('btn-solo').addEventListener('click', () => startSolo());

// ── Host ──────────────────────────────────────────────────────────────────

let hostSession = null;

$('btn-host').addEventListener('click', async () => {
  audio.resume();
  const code = makeRoomCode();
  showScreen('lobby');

  // The room does not exist until the broker has registered it. Handing out
  // the code before then means the other player types a correct code and is
  // told there is no such room — so it stays visibly "not ready yet", and the
  // copy button waits with it.
  $('room-code').textContent = code;
  $('room-code').classList.add('pending');
  $('btn-copy').disabled = true;
  $('btn-start').hidden = false;
  setStatus($('lobby-status'), 'Открываем комнату…');

  transport?.close();
  transport = createHostTransport({
    code,
    onStatus: (msg, kind) => setStatus($('lobby-status'), msg, kind),
  });

  try {
    await transport.ready;
  } catch {
    $('room-code').classList.remove('pending');
    return; // the status line already explains what went wrong
  }

  $('room-code').classList.remove('pending');
  $('btn-copy').disabled = false;

  hostSession = createHostSession({
    map: APARTMENT,
    name: playerName(),
    transport,
    seed: (Math.random() * 1e9) | 0,
    onRoster: renderLobby,
  });
  renderLobby();
});

function renderLobby() {
  const list = $('lobby-list');
  const players = hostSession ? Object.values(hostSession.state.players) : [];
  list.innerHTML = players
    .map(
      (p) =>
        `<li><span>${escapeHtml(p.name)}</span>` +
        `<span class="tag">${p.team === 'attackers' ? 'штурм' : 'оборона'}</span></li>`,
    )
    .join('');
  const btn = $('btn-start');
  btn.disabled = players.length < 2;
  btn.textContent = players.length < 2 ? 'Ждём второго игрока…' : 'Начать раунд';
}

$('btn-start').addEventListener('click', () => {
  if (!hostSession) return;
  hostSession.nextRound();
  transport.broadcast({ t: 'start' });
  startGame(hostSession);
});

$('btn-copy').addEventListener('click', async () => {
  const code = $('room-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    setStatus($('lobby-status'), 'Код скопирован.', 'ok');
  } catch {
    setStatus($('lobby-status'), `Скопируйте вручную: ${code}`);
  }
});

// ── Join ──────────────────────────────────────────────────────────────────

$('btn-join').addEventListener('click', async () => {
  audio.resume();
  const code = normaliseCode($('join-code').value);
  if (code.length !== 6) {
    setStatus($('net-status'), 'Код состоит из 6 символов.', 'error');
    return;
  }

  setStatus($('net-status'), 'Ищем комнату…');
  transport?.close();
  pendingWelcome = null;

  transport = createClientTransport({
    code,
    name: playerName(),
    onStatus: (msg, kind) => setStatus($('net-status'), msg, kind),
  });

  transport.onMessage((_peer, msg) => {
    if (msg.t === 'welcome') {
      pendingWelcome = msg;
      showScreen('lobby');
      $('room-code').textContent = code;
      $('btn-start').hidden = true;
      $('lobby-list').innerHTML = '<li><span>Вы в комнате</span><span class="tag">ждём хоста</span></li>';
      setStatus($('lobby-status'), 'Подключено. Хост запустит раунд.', 'ok');
    } else if (msg.t === 'start' && pendingWelcome) {
      const session = createClientSession({
        map: APARTMENT,
        transport,
        myId: pendingWelcome.id,
        seed: pendingWelcome.seed,
      });
      startGame(session);
    }
  });

  transport.onPeerLeave(() => {
    if (!game) return;
    game.stop();
    game = null;
    setStatus($('net-status'), 'Хост вышел — комната закрыта.', 'error');
    showScreen('main');
  });

  try {
    await transport.ready;
  } catch {
    /* status line already set */
  }
});

$('join-code').addEventListener('input', (e) => {
  e.target.value = normaliseCode(e.target.value);
});

// ── Pause / round / quit ──────────────────────────────────────────────────

function resumeGame() {
  if (!game) return;
  game.resume();
  hideOverlay();
  input.requestLock();
}

$('btn-resume').addEventListener('click', resumeGame);

$('btn-next').addEventListener('click', () => {
  if (!game) return;
  game.nextRound();
  if (game.session.kind === 'host') transport?.broadcast({ t: 'start' });
  game.resume();
  // A new round starts at the loadout screen, so go straight there rather than
  // flashing the world for one frame first.
  if (game.session.state.phase === 'select') {
    openLoadout();
  } else {
    hideOverlay();
    input.requestLock();
  }
});

function quitToMenu() {
  stopLoadoutPolling();
  game?.stop();
  game = null;
  hostSession = null;
  transport?.close();
  transport = null;
  if (onRange) {
    onRange = false;
    armoury.open(storageGet(WEAPON_KEY));
    showScreen('armoury');
    return;
  }
  showScreen('main');
}

$('btn-quit').addEventListener('click', quitToMenu);
$('btn-quit-round').addEventListener('click', quitToMenu);
$('btn-leave').addEventListener('click', quitToMenu);

// Escape is the pause key both ways: it drops you out of the match into the
// pause menu, where "Выйти из матча" ends it, and pressing it again puts you
// straight back in.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || !game) return;
  if (overlay.hidden) input.releaseLock(); // triggers onPause
  else if (!screens.pause.hidden) resumeGame();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

showScreen('main');

// ── The address-bar switches ──────────────────────────────────────────────
//
// Neither of these does anything on a normal visit: without ?debug the module
// below is never fetched, so `window.__gfu` stays undefined on the live site,
// and there is nothing to remember to take out again. See src/util/flags.js.
if (DEBUG) {
  import('./util/debug.js?v=09f108eb').then(({ installDebug }) => {
    installDebug({ input, getGame: () => game, startSolo, showMenu });
    // Started only after the handle exists, so a tool that asks for both never
    // races the match into being before it can steer it.
    if (AUTO_RANGE) startRange(storageGet(WEAPON_KEY) ?? 'ar-545-piston');
    else if (AUTO_SOLO) startSolo();
  });
} else if (AUTO_RANGE) {
  startRange(storageGet(WEAPON_KEY) ?? 'ar-545-piston');
} else if (AUTO_SOLO) {
  startSolo();
}

// Tells the start-up watchdog in crash-banner.js that the game really did boot.
// Without it the watchdog assumes the module never ran and reports why.
window.__gameforusReady = true;
