// The loadout screen: reads simulation state, writes DOM. Never the other way
// round — picking a card calls back out, and what a player is actually carrying
// is whatever the simulation says a moment later.

import { WEAPONS, WEAPON_CLASSES } from '../sim/constants.js?v=0f7349cc';

const $ = (id) => document.getElementById(id);

// The three figures that decide a fight, in the units a player thinks in.
// Buckshot is quoted as the whole shell — eight pellets of 34 is what actually
// arrives — because nobody aims one pellet.
function statLine(def) {
  const hit = def.pellets > 1 ? `${def.pellets}×${def.damage}` : `${def.damage}`;
  // Three separate figures rather than one sentence: a card is narrow, and a
  // line that wraps mid-figure ("в/" on one row, "м" on the next) reads as a
  // typo. Spacing does the separating, so a wrapped row needs no punctuation.
  return [`урон ${hit}`, `${def.rpm} в/м`, `магазин ${def.magSize}`]
    .map((part) => `<span class="stat">${part}</span>`)
    .join('');
}

export function createLoadout({ onPick }) {
  const el = {
    screen: $('screen-loadout'),
    grid: $('loadout-grid'),
    timer: $('loadout-timer'),
  };

  // Built once from the roster: a twelfth weapon means one more line in
  // constants.js, not a change here or in the markup.
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
      card.addEventListener('click', () => onPick(id));
      row.appendChild(card);
      cards.set(id, card);
    }
    section.appendChild(row);
    el.grid.appendChild(section);
  }

  function update(state, me) {
    const t = Math.max(0, state.phaseTime);
    el.timer.textContent = `0:${String(Math.ceil(t)).padStart(2, '0')}`;
    const carrying = me?.loadout;
    for (const [id, card] of cards) {
      const on = id === carrying;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-pressed', String(on));
    }
  }

  return { update };
}
