// Procedural positional audio. No sound files — every effect is synthesised,
// so the whole game stays a handful of small text files and works offline.
//
// Sound is a weapon in this game: footsteps and shots are positioned in 3D and
// attenuate with distance, so listening tells you where someone is.

const SPEED_OF_SOUND = 343;

export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let enabled = true;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;

    // Gentle limiter so a burst of gunfire never clips or hurts.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 8;
    comp.attack.value = 0.002;
    comp.release.value = 0.18;
    master.connect(comp);
    comp.connect(ctx.destination);

    // One reusable buffer of white noise — the basis of most of these sounds.
    const len = ctx.sampleRate * 2;
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    ctx.listener.upX ? setListenerOrientation(0, 0, -1) : null;
    return ctx;
  }

  function resume() {
    ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function setListener(pos, forward) {
    if (!ctx) return;
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  function setListenerOrientation(x, y, z) {
    if (!ctx) return;
    const l = ctx.listener;
    if (l.forwardX) {
      l.forwardX.value = x;
      l.forwardY.value = y;
      l.forwardZ.value = z;
    }
  }

  // A panner that fades with distance, so far-off shots are hints not events.
  function panner(pos, refDistance, maxDistance) {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.maxDistance = maxDistance;
    p.rolloffFactor = 1.4;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    p.connect(master);
    return p;
  }

  function noiseSource(duration, playbackRate = 1) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    src.playbackRate.value = playbackRate;
    src.start(ctx.currentTime, Math.random() * 1.5, duration);
    src.stop(ctx.currentTime + duration);
    return src;
  }

  // ── Sounds ──────────────────────────────────────────────────────────────

  function gunshot(pos, distance) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    // Sound takes time to arrive — a distant shot lands a beat late.
    const delay = Math.min(distance / SPEED_OF_SOUND, 0.25);
    const out = panner(pos, 3, 60);

    // Crack: bright, very short.
    const crack = noiseSource(0.09);
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'highpass';
    crackFilter.frequency.value = 1400 - Math.min(distance * 22, 1100);
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0, t + delay);
    crackGain.gain.linearRampToValueAtTime(0.9, t + delay + 0.002);
    crackGain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.075);
    crack.connect(crackFilter).connect(crackGain).connect(out);

    // Body: low thump that carries through walls.
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(160, t + delay);
    thump.frequency.exponentialRampToValueAtTime(48, t + delay + 0.12);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.7, t + delay);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.16);
    thump.connect(thumpGain).connect(out);
    thump.start(t + delay);
    thump.stop(t + delay + 0.18);

    // Tail: the room ringing afterwards.
    const tail = noiseSource(0.5, 0.4);
    const tailFilter = ctx.createBiquadFilter();
    tailFilter.type = 'bandpass';
    tailFilter.frequency.value = 700;
    tailFilter.Q.value = 0.8;
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0.28, t + delay + 0.01);
    tailGain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.45);
    tail.connect(tailFilter).connect(tailGain).connect(out);
  }

  function footstep(pos, loudness) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const out = panner(pos, 1.2, 26);
    const src = noiseSource(0.11, 0.7 + Math.random() * 0.25);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 260 + Math.random() * 140;
    filter.Q.value = 1.1;
    const gain = ctx.createGain();
    const vol = Math.min(0.34, 0.05 + loudness * 0.011);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.1);
    src.connect(filter).connect(gain).connect(out);
  }

  function impact(pos, material) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const out = panner(pos, 2, 30);
    const profile = {
      concrete: { freq: 1800, dur: 0.09, vol: 0.32, type: 'highpass' },
      drywall: { freq: 700, dur: 0.11, vol: 0.26, type: 'bandpass' },
      wood: { freq: 900, dur: 0.10, vol: 0.28, type: 'bandpass' },
      metal: { freq: 3200, dur: 0.20, vol: 0.30, type: 'bandpass' },
      glass: { freq: 4200, dur: 0.28, vol: 0.34, type: 'highpass' },
      fabric: { freq: 320, dur: 0.07, vol: 0.16, type: 'lowpass' },
      flesh: { freq: 240, dur: 0.09, vol: 0.42, type: 'lowpass' },
    }[material] ?? { freq: 1000, dur: 0.1, vol: 0.25, type: 'bandpass' };

    const src = noiseSource(profile.dur, 0.8 + Math.random() * 0.4);
    const filter = ctx.createBiquadFilter();
    filter.type = profile.type;
    filter.frequency.value = profile.freq;
    filter.Q.value = 1.4;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(profile.vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + profile.dur);
    src.connect(filter).connect(gain).connect(out);
  }

  function doorSound(pos, kind) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const out = panner(pos, 2, 34);

    if (kind === 'kick' || kind === 'break') {
      const boom = ctx.createOscillator();
      boom.type = 'triangle';
      boom.frequency.setValueAtTime(120, t);
      boom.frequency.exponentialRampToValueAtTime(38, t + 0.22);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.85, t);
      bg.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      boom.connect(bg).connect(out);
      boom.start(t);
      boom.stop(t + 0.32);

      const splinter = noiseSource(kind === 'break' ? 0.4 : 0.16, 1.1);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.4, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'break' ? 0.38 : 0.15));
      splinter.connect(f).connect(g).connect(out);
      return;
    }

    // Hinge creak — quiet, and the thing that gives you away when sneaking.
    const src = noiseSource(0.32, 0.25);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(420, t);
    f.frequency.linearRampToValueAtTime(700, t + 0.3);
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(kind === 'sneak' ? 0.05 : 0.14, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(f).connect(g).connect(out);
  }

  function click(kind, pos) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    // Fitting a wedge happens somewhere in the flat; racking your own slide
    // happens at your own hands.
    g.connect(pos ? panner(pos, 1.5, 16) : master);
    const src = noiseSource(0.05, kind === 'dry' ? 1.6 : 1.0);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2200;
    g.gain.setValueAtTime(kind === 'dry' ? 0.25 : 0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    src.connect(f).connect(g);
  }

  // Anything that goes off with a bang: the flashbang's crack, a charge, a
  // tripwire, and the soft thump of a smoke can popping. One shape, three
  // settings — a low body, a bright crack on top, and a tail of noise.
  function blast(pos, kind = 'blast') {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const out = panner(pos, 3, kind === 'smoke' ? 20 : 60);
    const soft = kind === 'smoke';

    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(soft ? 220 : 90, t);
    body.frequency.exponentialRampToValueAtTime(soft ? 90 : 32, t + (soft ? 0.2 : 0.45));
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(soft ? 0.25 : 1, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + (soft ? 0.25 : 0.6));
    body.connect(bg).connect(out);
    body.start(t);
    body.stop(t + 0.7);

    const crack = noiseSource(soft ? 0.5 : 0.9, kind === 'flash' ? 1.6 : 1.0);
    const f = ctx.createBiquadFilter();
    f.type = soft ? 'lowpass' : 'highpass';
    f.frequency.value = soft ? 900 : 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(soft ? 0.18 : 0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (soft ? 0.5 : 0.55));
    crack.connect(f).connect(g).connect(out);
  }

  // The door alarm: a two-tone warble that carries across the flat.
  function alarm(pos) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const out = panner(pos, 4, 40);
    for (let i = 0; i < 4; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      const at = t + i * 0.22;
      osc.frequency.setValueAtTime(i % 2 ? 780 : 1180, at);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(0.22, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.18);
      osc.connect(g).connect(out);
      osc.start(at);
      osc.stop(at + 0.2);
    }
  }

  function hitMarker() {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1400, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.09, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  return {
    resume,
    setListener,
    gunshot,
    footstep,
    impact,
    doorSound,
    click,
    blast,
    alarm,
    hitMarker,
    setEnabled(v) {
      enabled = v;
    },
    setVolume(v) {
      if (master) master.gain.value = v;
    },
    get context() {
      return ctx;
    },
  };
}
