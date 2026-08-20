// The staging screen: reads simulation state, writes DOM. Never the other way
// round — a card only marks what you intend to carry, and nothing reaches the
// simulation until the choice is confirmed.
//
// Confirming is deliberate for a reason. Picking used to arm the weapon on
// mousedown and drop you straight back into the flat, which meant a misclick
// was a round played with the wrong gun. Now the screen waits: change your
// mind as often as you like, press "В бой" when you mean it, and if the clock
// runs out first the highlighted set is taken as your answer.

import { WEAPONS, WEAPON_CLASSES, GADGETS } from '../sim/constants.js?v=45193364';

const $ = (id) => document.getElementById(id);

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
    timer: $('loadout-timer'),
    confirm: $('btn-loadout-ready'),
    status: $('loadout-status'),
  };

  // What the player is pointing at, which is not yet what they carry.
  let pending = { weapon: null, gadget: null };
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
        + `<span class="weapon-mode">${def.count} шт</span>`
        + '</span>'
        + `<span class="weapon-blurb">${def.blurb}</span>`
        + `<span class="weapon-stats"><span class="stat">${
          def.kind === 'throw' ? 'бросок на G' : 'ставится на дверь, G'
        }</span></span>`;
      card.addEventListener('click', () => {
        pending.gadget = id;
        paint();
      });
      el.kitRow.appendChild(card);
      kitCards.set(id, card);
    }
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
    const w = WEAPONS[pending.weapon];
    const g = GADGETS[pending.gadget];
    el.status.textContent = confirmed
      ? 'Выбор принят.'
      : `Выбрано: ${w ? w.name : '—'} и ${g ? g.name.toLowerCase() : '—'}. Подтвердите, иначе выбор примут за вас.`;
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

    const t = Math.max(0, state.phaseTime);
    el.timer.textContent = `0:${String(Math.ceil(t)).padStart(2, '0')}`;
    // The clock is the second way to confirm: when staging starts, whatever is
    // highlighted is what you walk in with.
    if (state.phase !== 'select') confirm('timeout');
    paint();
  }

  // A new round means a new decision.
  function reset() {
    confirmed = false;
    pending = { weapon: null, gadget: null };
  }

  return { update, reset, confirm };
}
