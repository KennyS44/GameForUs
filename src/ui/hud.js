// HUD: reads simulation state, writes DOM. Never the other way round.

import { WEAPONS, GADGETS, PLAYER } from '../sim/constants.js?v=b574760e';

const $ = (id) => document.getElementById(id);

export function createHud() {
  const el = {
    hud: $('hud'),
    crosshair: $('crosshair'),
    hitmarker: $('hitmarker'),
    vignette: $('vignette'),
    roundInfo: $('round-info'),
    roundPhase: $('round-phase'),
    roundTimer: $('round-timer'),
    aliveCount: $('alive-count'),
    killfeed: $('killfeed'),
    prompt: $('prompt'),
    healthFill: $('health-fill'),
    healthNum: $('health-num'),
    stance: $('stance'),
    weaponName: $('weapon-name'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    flashlightFlag: $('flashlight-flag'),
    gadgetSlot: $('gadget-slot'),
    gadgetName: $('gadget-name'),
    gadgetLeft: $('gadget-left'),
    nvg: $('nvg'),
    scope: $('scope'),
    banner: $('banner'),
    blindfold: $('blindfold'),
    clickToPlay: $('click-to-play'),
    deadNotice: $('dead-notice'),
    deadSub: $('dead-sub'),
    spectating: $('spectating'),
    spectatingName: $('spectating-name'),
    spectatingHint: $('spectating-hint'),
    scoreboard: $('scoreboard'),
    scoreboardBody: $('scoreboard-body'),
  };

  let lastHealth = PLAYER.maxHealth;
  // Whose health `lastHealth` is a reading of, so a change of view is not
  // mistaken for a wound.
  let vitalsOf = null;
  let vignetteTimer = 0;
  let bannerTimer = 0;

  // One line across the middle for something everyone in the flat just found
  // out. It fades rather than blinks: the news is that the room changed, not
  // that a message arrived.
  function banner(text) {
    el.banner.textContent = text;
    el.banner.hidden = false;
    // Force a reflow so a second banner restarts the fade instead of sitting
    // at full opacity from the first one.
    void el.banner.offsetWidth;
    el.banner.classList.add('on');
    bannerTimer = 2.6;
  }

  // How much white a given amount of blindness puts on the screen. Two places
  // ask — the flash as it lands, and every frame afterwards while it fades —
  // and they have to agree, or the moment the simulation takes over from the
  // immediate paint the screen jumps.
  //
  // Over one, because the worst of a flash should be a wall of white rather
  // than a bright grey; short of full opacity, because a player who cannot see
  // the edges of their own screen cannot tell blinded from broken.
  const blindfold = (amount) => String(Math.min(0.97, amount * 1.15));

  // A flash lands between two HUD updates, so paint the white immediately
  // rather than waiting for the next frame to read the simulation.
  function blindFlash(amount = 1) {
    el.blindfold.style.opacity = blindfold(amount);
  }

  function show(on) {
    el.hud.hidden = !on;
  }

  // How far into a scope's own sight picture the view is. Driven every frame
  // by the renderer, because only the viewmodel knows which glass is fitted.
  function setScope(amount) {
    el.scope.style.opacity = amount > 0.002 ? String(Math.min(1, amount)) : '0';
  }

  // `watching` is the name of the team-mate whose eyes these are, or null when
  // the picture is your own. Everything on screen then describes him — his
  // health, his magazine, his stance — because it is his view, and a bar that
  // read 0 over a picture of a man walking about would be nonsense.
  function update(state, me, dt, watching = null) {
    if (!me) return;

    // ── Vitals ──
    const hp = Math.max(0, Math.round(me.health));
    el.healthNum.textContent = hp;
    el.healthFill.style.transform = `scaleX(${hp / PLAYER.maxHealth})`;
    el.healthFill.classList.toggle('hurt', hp <= 40);

    // The red flash is "you were hit", so it must not fire when the numbers
    // change because the view moved to somebody else. Stepping from your own
    // corpse to a team-mate on 100 is a jump of a hundred points that nobody
    // felt.
    if (me.health < lastHealth && me.id === vitalsOf) vignetteTimer = 0.9;
    lastHealth = me.health;
    vitalsOf = me.id;
    if (vignetteTimer > 0) {
      vignetteTimer -= dt;
      el.vignette.style.opacity = String(Math.min(0.9, vignetteTimer));
    } else {
      // A permanent low-level vignette once badly hurt.
      el.vignette.style.opacity = hp <= 35 ? String(0.35 * (1 - hp / 35)) : '0';
    }

    el.stance.textContent = me.crouching ? 'ПРИСЕВ'
      : me.sneaking ? 'ТИХО'
        : me.aimAmount > 0.5 ? 'ПРИЦЕЛ' : 'СТОЯ';
    // The quiet step is a mode now, so it has to be visible at a glance.
    el.stance.classList.toggle('quiet', !!me.sneaking && !me.crouching);

    // ── Ammo ──
    const w = me.weapon;
    const def = WEAPONS[w.id];
    el.weaponName.textContent = def.name;
    el.ammoMag.textContent = w.reloading > 0 ? '- -' : w.ammo;
    el.ammoMag.classList.toggle('low', w.ammo <= def.magSize * 0.25);
    el.ammoReserve.textContent = w.reserve;
    el.flashlightFlag.hidden = !me.flashlight;

    // ── Equipment ──
    // One slot, whatever is in it. A device you spend counts down; a device
    // you wear says whether it is on, because that is the only thing about it
    // you can forget.
    const kit = GADGETS[me.gadget];
    if (kit) {
      const worn = kit.kind === 'toggle';
      el.gadgetName.textContent = kit.name;
      el.gadgetLeft.textContent = worn ? (me.nvg ? 'ВКЛ' : 'ВЫКЛ') : (me.gadgetLeft ?? 0);
      el.gadgetSlot.classList.toggle('empty', worn ? !me.nvg : (me.gadgetLeft ?? 0) <= 0);
      el.gadgetSlot.classList.toggle('live', worn && !!me.nvg);
    }

    el.nvg.classList.toggle('on', !!me.nvg);

    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0) el.banner.classList.remove('on');
    }

    // Being flashed is the simulation's business, so the screen just reads it.
    // A blast of white, then a long climb back to seeing anything.
    el.blindfold.style.opacity = blindfold(me.blind ?? 0);

    // ── Crosshair opens up with your actual cone of fire ──
    const moving = Math.hypot(me.vel.x, me.vel.z) > 1.2;
    let spread = def.spreadHip * (1 - me.aimAmount) + def.spreadAim * me.aimAmount;
    if (moving) spread += def.spreadMoving * (1 - me.aimAmount * 0.7);
    if (me.crouching) spread *= 0.7;
    const px = Math.max(3, Math.min(60, spread * 900));
    el.crosshair.style.setProperty('--spread', `${px.toFixed(1)}px`);
    el.crosshair.classList.toggle('hidden', me.aimAmount > 0.75 || !me.alive);

    // ── Round ──
    const t = Math.max(0, state.phaseTime);
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    el.roundTimer.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
    el.roundPhase.textContent =
      state.phase === 'select' ? 'Выбор оружия'
        : state.phase === 'prep' ? 'Подготовка'
          : state.phase === 'live' ? 'Раунд' : 'Окончен';
    el.roundInfo.classList.toggle('urgent', state.phase === 'live' && t <= 30);

    const alive = { attackers: 0, defenders: 0 };
    const total = { attackers: 0, defenders: 0 };
    for (const p of Object.values(state.players)) {
      total[p.team]++;
      if (p.alive) alive[p.team]++;
    }
    el.aliveCount.textContent = `Штурм ${alive.attackers}/${total.attackers}   ·   Оборона ${alive.defenders}/${total.defenders}`;

    // ── Death ──
    //
    // "Вы убиты" belongs on your own last picture, not over somebody else's:
    // once the view has moved to a team-mate the big red word would be reading
    // his screen wrong. The quiet line at the bottom takes over instead.
    el.deadNotice.hidden = me.alive || !!watching;
    el.spectating.hidden = !watching;
    if (watching) {
      el.spectatingName.textContent = watching;
      el.spectatingHint.textContent = spectateHint;
    }
  }

  // Only worth saying when there is somewhere else to look.
  let spectateHint = '';
  function setSpectateChoice(count) {
    spectateHint = count > 1 ? '· Space — следующий' : '';
  }

  function setClickToPlay(show) {
    el.clickToPlay.hidden = !show;
  }

  function setPrompt(html) {
    if (!html) {
      el.prompt.hidden = true;
      return;
    }
    if (el.prompt.innerHTML !== html) el.prompt.innerHTML = html;
    el.prompt.hidden = false;
  }

  function hitMark(kill) {
    el.hitmarker.classList.remove('show', 'kill');
    // Force a reflow so the animation restarts on rapid consecutive hits.
    void el.hitmarker.offsetWidth;
    el.hitmarker.classList.add('show');
    if (kill) el.hitmarker.classList.add('kill');
  }

  function setDeathInfo(text) {
    el.deadSub.textContent = text;
  }

  const ZONE_LABEL = { head: 'в голову', torso: 'в корпус', limb: 'в конечность' };

  function killFeed(state, ev, myId) {
    const killer = state.players[ev.by];
    const victim = state.players[ev.id];
    if (!victim) return;
    const entry = document.createElement('div');
    entry.className = 'entry' + (ev.by === myId || ev.id === myId ? ' mine' : '');
    const kName = killer ? escape(killer.name) : 'Мир';
    const kClass = killer?.team === 'attackers' ? 'name-a' : 'name-d';
    const vClass = victim.team === 'attackers' ? 'name-a' : 'name-d';
    entry.innerHTML =
      `<span class="${kClass}">${kName}</span> → ` +
      `<span class="${vClass}">${escape(victim.name)}</span> ` +
      `<span class="zone">${ZONE_LABEL[ev.zone] ?? ''}</span>`;
    el.killfeed.appendChild(entry);
    setTimeout(() => entry.remove(), 6000);
    while (el.killfeed.children.length > 5) el.killfeed.firstChild.remove();
  }

  function scoreboard(state, myId, pings, visible) {
    el.scoreboard.hidden = !visible;
    if (!visible) return;
    const rows = Object.values(state.players)
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .map((p) => {
        const team = p.team === 'attackers' ? 'Штурм' : 'Оборона';
        const ping = pings?.[p.id];
        return (
          `<tr class="${p.alive ? '' : 'dead'}">` +
          `<td class="team-${p.team}">${escape(p.name)}${p.id === myId ? ' (вы)' : ''}</td>` +
          `<td>${team}</td><td>${p.kills}</td><td>${p.deaths}</td>` +
          `<td>${ping == null ? '—' : `${Math.round(ping)} мс`}</td></tr>`
        );
      })
      .join('');
    el.scoreboardBody.innerHTML = rows;
  }

  return {
    show, blindFlash, banner, setScope, update, setPrompt, setClickToPlay, hitMark, killFeed,
    scoreboard, setDeathInfo, setSpectateChoice, el,
  };
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

