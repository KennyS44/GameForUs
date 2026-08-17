// The loadout screen: reads simulation state, writes DOM. Never the other way
// round — picking a card calls back out, and what a player is actually carrying
// is whatever the simulation says a moment later.

import { WEAPONS, WEAPON_CLASSES } from '../sim/constants.js?v=031dc91d';

const $ = (id) => document.getElementById(id);

export function createLoadout({ onPick }) {
  const el = {
    screen: $('screen-loadout'),
    grid: $('loadout-grid'),
    timer: $('loadout-timer'),
  };

  // Built once from the roster: a ninth weapon means one more line in
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
      card.innerHTML =
        `<span class="weapon-code">${def.name}</span>` +
        `<span class="weapon-blurb">${def.blurb}</span>`;
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
