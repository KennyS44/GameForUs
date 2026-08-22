// The staging screen: reads simulation state, writes DOM. Never the other way
// round — a card only marks what you intend to carry, and nothing reaches the
// simulation until the choice is confirmed.
//
// Confirming is deliberate for a reason. Picking used to arm the weapon on
// mousedown and drop you straight back into the flat, which meant a misclick
// was a round played with the wrong gun. Now the screen waits: change your
// mind as often as you like, press "В бой" when you mean it, and if the clock
// runs out first the highlighted set is taken as your answer.

import {
  WEAPONS, WEAPON_CLASSES, GADGETS, OPTICS, OPTICS_BY_CLASS, defaultOptic,
} from '../sim/constants.js?v=48d5848b';

const $ = (id) => document.getElementById(id);

// How each kind of device is worked, in the words the card needs. One key for
// all of them: what you picked decides what pressing it does.
const KIT_USE = {
  throw: 'бросок на G',
  door: 'ставится на дверь, G',
  toggle: 'включается на G',
};

// The three figures that decide a fight, in the units a player thinks in.
// Buckshot is quoted as the whole pattern — eight pellets of eleven is what
// actually arrives — because nobody aims one pellet.
function statLine(def) {
  const hit = def.pellets > 1 ? `${def.pellets}×${def.damage}` : `${def.damage}`;
  // Three separate figures rather than one sentence: a card is narrow, and a
  // line that wraps mid-figure ("в/" on one row, "м" on the next) reads as a
  // typo. Spacing does the separating, so a wrapped row needs no punctuation.
  return [`урон ${hit}`, `${def.rpm} в/м`, `магазин ${def.magSize}`]
    .map((part) => `<span class="stat">${part}</span>`)
    .join('');
}

export function createLoadout({ onConfirm }) {
  const el = {
    screen: $('screen-loadout'),
    grid: $('loadout-grid'),
    kit: $('loadout-kit'),
    kitRow: $('loadout-kit-row'),
    kitSide: $('loadout-kit-side'),
    opticRow: $('loadout-optic-row'),
    opticWeapon: $('loadout-optic-weapon'),
    timer: $('loadout-timer'),
    confirm: $('btn-loadout-ready'),
    status: $('loadout-status'),
  };

  // What the player is pointing at, which is not yet what they carry.
  let pending = { weapon: null, gadget: null, optic: null };
  let team = null;
  let confirmed = false;

  // ── Weapons: built once from the roster ──
  const cards = new Map();
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
      // The picture is the blueprint sheet with the paper stripped away, so
      // the gun on the card is the drawing the model was built from.
      card.innerHTML =
        `<img class="weapon-art" src="docs/weapons/${id}-icon.svg" alt="" loading="lazy">`
        + '<span class="weapon-head">'
        + `<span class="weapon-code">${def.name}</span>`
        + `<span class="weapon-mode">${def.fireMode === 'auto' ? 'АВТ' : 'ОДИН'}</span>`
        + '</span>'
        + `<span class="weapon-blurb">${def.blurb}</span>`
        + `<span class="weapon-stats">${statLine(def)}</span>`;
      card.addEventListener('click', () => {
        pending.weapon = id;
        paint();
      });
      row.appendChild(card);
      cards.set(id, card);
    }
    section.appendChild(row);
    el.grid.appendChild(section);
  }

  // ── Equipment: only your own side's, so the row is rebuilt when the team is
  // known and again if it ever changes.
  const kitCards = new Map();

  function buildKit(forTeam) {
    el.kitSide.textContent = forTeam === 'attackers' ? 'штурм' : 'оборона';
    el.kitRow.textContent = '';
    kitCards.clear();
    for (const [id, def] of Object.entries(GADGETS)) {
      if (def.team !== forTeam) continue;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'weapon-card kit-card';
      card.dataset.gadget = id;
      card.innerHTML =
        '<span class="weapon-head">'
        + `<span class="weapon-code">${def.name}</span>`
        + `<span class="weapon-mode">${def.kind === 'toggle' ? 'ВКЛ/ВЫКЛ' : `${def.count} шт`}</span>`
        + '</span>'
        + `<span class="weapon-blurb">${def.blurb}</span>`
        + `<span class="weapon-stats"><span class="stat">${KIT_USE[def.kind]}</span></span>`;
      card.addEventListener('click', () => {
        pending.gadget = id;
        paint();
      });
      el.kitRow.appendChild(card);
      kitCards.set(id, card);
    }
  }

  // ── Sights ──
  //
  // The list depends on the weapon, so this row cannot be built once the way
  // the racks are — a submachine gun has no business offering a marksman tube.
  // What it must never do is quietly change a fitting: coming back to a rifle
  // you set up in the armoury has to show that rifle's own sight still on it,
  // which is why the pick is looked up per weapon rather than carried across
  // from whatever happened to be highlighted a moment ago.
  const opticCards = new Map();
  let opticFor = null; // which weapon the row currently describes

  function buildOptics(weaponId, chosen) {
    const def = WEAPONS[weaponId];
    if (!def) return;
    opticFor = weaponId;
    el.opticWeapon.textContent = def.name;
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
        pending.optic = id;
        paint();
      });
      el.opticRow.appendChild(card);
      opticCards.set(id, card);
    }
    pending.optic = chosen;
  }

  // The one figure a sight moves, put the way a player thinks about it rather
  // than as the multiplier it is in the table.
  function aimWord(scale) {
    if (scale < 1) return 'вскидка быстрее';
    if (scale > 1) return `вскидка на ${Math.round((scale - 1) * 100)}% дольше`;
    return 'вскидка обычная';
  }

  function paint() {
    for (const [id, card] of cards) {
      const on = id === pending.weapon;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-pressed', String(on));
    }
    for (const [id, card] of kitCards) {
      const on = id === pending.gadget;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-pressed', String(on));
    }
    for (const [id, card] of opticCards) {
      const on = id === pending.optic;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-pressed', String(on));
    }
    const w = WEAPONS[pending.weapon];
    const g = GADGETS[pending.gadget];
    const o = OPTICS[pending.optic];
    el.status.textContent = confirmed
      ? 'Выбор принят.'
      : `Выбрано: ${w ? w.name : '—'}${o ? ` с прицелом «${o.short}»` : ''}`
        + ` и ${g ? g.name.toLowerCase() : '—'}. Подтвердите, иначе выбор примут за вас.`;
  }

  // Hand the pending set to the game. Called by the button and by the clock.
  function confirm(reason = 'player') {
    if (confirmed) return;
    confirmed = true;
    onConfirm({ ...pending, reason });
  }

  el.confirm.addEventListener('click', () => confirm('player'));

  // Called ten times a second while the screen is up.
  function update(state, me) {
    if (!me) return;
    if (me.team !== team) {
      team = me.team;
      buildKit(team);
    }
    // First look of the round: start from what the player is already carrying,
    // so confirming without touching anything keeps last round's kit.
    if (!pending.weapon) pending.weapon = me.loadout;
    if (!pending.gadget) pending.gadget = me.gadget;

    // The sight row follows the weapon. Rebuilt only when the weapon actually
    // changes, or every tenth of a second would throw away the row the player
    // is in the middle of clicking.
    if (pending.weapon !== opticFor) {
      buildOptics(pending.weapon, me.optics?.[pending.weapon] ?? defaultOptic(pending.weapon));
    }

    // On a range there is no clock and nothing to be late for: the rack is
    // open for as long as you want it, and nothing is taken as your answer.
    if (state.practice) {
      el.timer.textContent = '—';
    } else {
      const t = Math.max(0, state.phaseTime);
      el.timer.textContent = `0:${String(Math.ceil(t)).padStart(2, '0')}`;
      // The clock is the second way to confirm: when staging starts, whatever
      // is highlighted is what you walk in with.
      if (state.phase !== 'select') confirm('timeout');
    }
    paint();
  }

  // A new round means a new decision.
  function reset() {
    confirmed = false;
    pending = { weapon: null, gadget: null, optic: null };
    // Force the sight row to be rebuilt from what the player actually has on
    // the gun, rather than from what was highlighted last round.
    opticFor = null;
  }

  // Coming back to change your mind, which is a different thing. What you
  // picked stays picked and stays highlighted; all that is undone is the
  // confirming, so the clock can still answer for you if you walk away again.
  function reopen() {
    confirmed = false;
    paint();
  }

  return { update, reset, reopen, confirm };
}
