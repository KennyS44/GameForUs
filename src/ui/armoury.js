// The armoury: what is bolted to each weapon, decided before a match.
//
// The loadout screen has a sight row too, but it is a place to change your
// mind under a thirty-second clock with a round about to start. Setting a rack
// of eleven weapons up properly is a different job and wants a different room —
// no clock, every gun in the list, and a range next door to find out whether
// the choice was any good.
//
// The choices outlive the browser tab. They are kept here rather than in the
// simulation because they are a preference, like mouse sensitivity: the
// simulation is told about them when a match starts, and is the only authority
// on whether a fitting is legal once it has been.

import {
  WEAPONS, WEAPON_CLASSES, OPTICS, OPTICS_BY_CLASS, defaultOptic, opticFits,
} from '../sim/constants.js?v=09f108eb';
import { storageGet, storageSet } from '../util/storage.js?v=09f108eb';

const $ = (id) => document.getElementById(id);
const KEY = 'gameforus.optics';

// ── What is remembered ────────────────────────────────────────────────────

// Read defensively: this is player-editable storage from a previous version of
// the game, and a fitting that is no longer legal must not reach the rest of
// the code. An unreadable file means "nothing chosen", not a broken menu.
export function savedOptics() {
  try {
    const raw = storageGet(KEY);
    if (!raw) return {};
    const out = {};
    for (const [weapon, optic] of Object.entries(JSON.parse(raw))) {
      if (opticFits(weapon, optic)) out[weapon] = optic;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveOptic(weaponId, opticId) {
  if (!opticFits(weaponId, opticId)) return false;
  const all = savedOptics();
  all[weaponId] = opticId;
  storageSet(KEY, JSON.stringify(all));
  return true;
}

// What this weapon wears, as far as the menus are concerned.
export function opticFor(weaponId) {
  return savedOptics()[weaponId] ?? defaultOptic(weaponId);
}

// ── The screen ────────────────────────────────────────────────────────────

export function createArmoury({ onRange, onBack }) {
  const el = {
    grid: $('armoury-grid'),
    weaponName: $('armoury-weapon'),
    opticRow: $('armoury-optic-row'),
    note: $('armoury-note'),
    range: $('btn-armoury-range'),
    back: $('btn-armoury-back'),
  };

  let picked = null; // which weapon is being set up
  const weaponCards = new Map();
  const opticCards = new Map();

  // The rack, built once. Same cards as the loadout screen so the two rooms
  // read as the same game, with the fitted sight written under each gun —
  // which is the one thing you come here to see at a glance.
  for (const cls of WEAPON_CLASSES) {
    const section = document.createElement('section');
    section.className = 'loadout-class';
    const h = document.createElement('h3');
    h.textContent = cls.label;
    section.appendChild(h);

    const row = document.createElement('div');
    row.className = 'loadout-row';
    for (const [id, def] of Object.entries(WEAPONS)) {
      if (def.cls !== cls.id) continue;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'weapon-card';
      card.dataset.weapon = id;
      card.innerHTML =
        `<img class="weapon-art" src="docs/weapons/${id}-icon.svg" alt="" loading="lazy">`
        + '<span class="weapon-head">'
        + `<span class="weapon-code">${def.name}</span>`
        + '<span class="weapon-mode" data-fitted></span>'
        + '</span>'
        + `<span class="weapon-blurb">${def.blurb}</span>`;
      card.addEventListener('click', () => {
        picked = id;
        buildOptics();
        paint();
      });
      row.appendChild(card);
      weaponCards.set(id, card);
    }
    section.appendChild(row);
    el.grid.appendChild(section);
  }

  function buildOptics() {
    const def = WEAPONS[picked];
    if (!def) return;
    el.weaponName.textContent = def.name;
    el.opticRow.textContent = '';
    opticCards.clear();
    for (const id of OPTICS_BY_CLASS[def.cls] ?? []) {
      const o = OPTICS[id];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'weapon-card kit-card';
      card.dataset.optic = id;
      card.innerHTML =
        '<span class="weapon-head">'
        + `<span class="weapon-code">${o.name}</span>`
        + `<span class="weapon-mode">${o.zoom > 1 ? `${String(o.zoom).replace('.', ',')}×` : '1×'}</span>`
        + '</span>'
        + `<span class="weapon-blurb">${o.blurb}</span>`
        + `<span class="weapon-stats"><span class="stat">${aimWord(o.aimScale)}</span></span>`;
      card.addEventListener('click', () => {
        saveOptic(picked, id);
        paint();
      });
      el.opticRow.appendChild(card);
      opticCards.set(id, card);
    }
  }

  function aimWord(scale) {
    if (scale < 1) return 'вскидка быстрее';
    if (scale > 1) return `вскидка на ${Math.round((scale - 1) * 100)}% дольше`;
    return 'вскидка обычная';
  }

  function paint() {
    const fitted = savedOptics();
    for (const [id, card] of weaponCards) {
      card.classList.toggle('selected', id === picked);
      card.setAttribute('aria-pressed', String(id === picked));
      const tag = card.querySelector('[data-fitted]');
      if (tag) tag.textContent = OPTICS[fitted[id] ?? defaultOptic(id)].short;
    }
    const on = picked ? (fitted[picked] ?? defaultOptic(picked)) : null;
    for (const [id, card] of opticCards) {
      card.classList.toggle('selected', id === on);
      card.setAttribute('aria-pressed', String(id === on));
    }
    el.range.disabled = !picked;
    el.note.textContent = picked
      ? `На полигоне вы получите ${WEAPONS[picked].name} с прицелом «${OPTICS[on].short}».`
      : 'Выберите оружие, чтобы поставить на него прицел.';
  }

  el.range.addEventListener('click', () => {
    if (picked) onRange(picked, opticFor(picked));
  });
  el.back.addEventListener('click', onBack);

  // Opening the room: start on whatever is in hand, so the first thing shown
  // is a gun rather than an empty panel asking a question.
  function open(weaponId) {
    picked = weaponId && WEAPONS[weaponId] ? weaponId : Object.keys(WEAPONS)[0];
    buildOptics();
    paint();
  }

  return { open, get weapon() { return picked; } };
}
