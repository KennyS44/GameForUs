// Procedural positional audio. No sound files — every effect is synthesised,
// so the whole game stays a handful of small text files and works offline.
//
// Sound is a weapon in this game: footsteps and shots are positioned in 3D and
// attenuate with distance, so listening tells you where someone is.

const SPEED_OF_SOUND = 343;

// How far the consumer unit carries. It matches POWER.loudness in the
// simulation, which is what the bots hear it at — the ears and the eardrums
// should agree about how big a noise it is.
const POWER_CARRY = 40;

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

    buildReverb();

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

  // ── The room a sound is in ────────────────────────────────────────────────
  //
  // Every sound in this game used to arrive dry, which meant a shot in a tiled
  // bathroom and the same shot out in the open courtyard were the same shot.
  // In a game whose whole instruction is "listen", that is a piece of missing
  // information, not a missing decoration: how a noise rings tells you what
  // kind of space made it, and whether there is a wall between you and it.
  //
  // Three tails, and the runtime crossfades between them from the size of the
  // room the listener is standing in:
  //
  //   tight — a bathroom, a stairwell, a corridor. Short and hard.
  //   room  — a bedroom, an office. What most of the flat sounds like.
  //   hall  — the living court and the terrace, open to the sky.
  //
  // Each is a convolver fed with noise that decays: no impulse-response files
  // to ship, and a quarter of a second of arithmetic at start-up.
  const SPACES = [
    { name: 'tight', seconds: 0.32, decay: 4.2, tone: 3400 },
    { name: 'room', seconds: 0.75, decay: 3.0, tone: 2400 },
    { name: 'hall', seconds: 1.7, decay: 2.2, tone: 1500 },
  ];
  let reverbIn = null;
  const reverbs = [];

  function buildReverb() {
    reverbIn = ctx.createGain();
    reverbIn.gain.value = 0.5;
    for (const s of SPACES) {
      const len = Math.max(1, Math.floor(ctx.sampleRate * s.seconds));
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          // Noise under an envelope that falls away: the shape of a room
          // giving a sound back, one reflection at a time.
          data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** s.decay;
        }
      }
      const conv = ctx.createConvolver();
      conv.buffer = buf;
      // Reflections lose their top end on the way back off plaster, which is
      // what stops a tail sounding like a cymbal.
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = s.tone;
      const level = ctx.createGain();
      level.gain.value = s.name === 'room' ? 1 : 0;
      reverbIn.connect(tone).connect(conv).connect(level).connect(master);
      reverbs.push(level);
    }
  }

  // Which space the listener is in, handed over by the runtime — it is the one
  // that knows where the walls are. `wet` is how much of it comes back at all:
  // a carpeted bedroom returns less than a bare stairwell.
  function setSpace({ tight = 0, room = 1, hall = 0, wet = 0.5 } = {}) {
    if (!reverbs.length) return;
    const t = ctx.currentTime;
    const to = [tight, room, hall];
    for (let i = 0; i < reverbs.length; i++) {
      reverbs[i].gain.setTargetAtTime(to[i], t, 0.25);
    }
    reverbIn.gain.setTargetAtTime(wet, t, 0.25);
  }

  // A panner that fades with distance, so far-off shots are hints not events.
  //
  // `muffle` is how much building is between the sound and the ear, from 0 for
  // a clear line to 1 for several walls. A wall does not turn a noise down so
  // much as take the edge off it: the crack goes and the thump stays, which is
  // exactly why a shot through drywall sounds further away than it is.
  // `send` is how much of this sound the room gets to answer. A gunshot is an
  // event the whole flat rings with; a footstep is not, and at the same send
  // as everything else a man walking dragged a tail behind every step and the
  // corridor sounded like a swimming pool.
  function panner(pos, refDistance, maxDistance, muffle = 0, send = 1) {
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
    if (reverbIn && send > 0.01) {
      if (send >= 0.99) {
        p.connect(reverbIn);
      } else {
        const tap = ctx.createGain();
        tap.gain.value = send;
        p.connect(tap).connect(reverbIn);
      }
    }
    if (muffle <= 0.01) return p;

    const wall = ctx.createBiquadFilter();
    wall.type = 'lowpass';
    // One wall takes it to about 1.5 kHz; three and there is nothing left but
    // the low end you feel through the floor.
    wall.frequency.value = Math.max(260, 14000 * (1 - muffle) ** 2.2);
    const drop = ctx.createGain();
    drop.gain.value = 1 - muffle * 0.45;
    wall.connect(drop).connect(p);
    return wall;
  }

  // Something happening at your own body rather than out in the flat: not
  // panned, not attenuated, and never behind a wall — but the room still
  // answers it, because your boots ring off the tiles the same as anyone's.
  function ownVoice(send = 1) {
    const g = ctx.createGain();
    g.connect(master);
    if (reverbIn && send > 0.01) {
      const tap = ctx.createGain();
      tap.gain.value = send;
      g.connect(tap).connect(reverbIn);
    }
    return g;
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

  function gunshot(pos, distance, muffle = 0) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    // Sound takes time to arrive — a distant shot lands a beat late.
    const delay = Math.min(distance / SPEED_OF_SOUND, 0.25);
    const out = panner(pos, 3, 60, muffle);

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

  // A boot is not a bell.
  //
  // This used to be a narrow band of noise plus a triangle wave an octave
  // above it, which is a description of a heel tapping a hard floor — and it
  // was the loudest thing in the flat. A boot on a floor is two duller things
  // a few milliseconds apart: the sole landing, which is a low broadband thump
  // with no pitch to it at all, and the scuff of the rubber rolling off it,
  // which is a short breath of higher noise and much quieter.
  //
  // So each floor is two numbers rather than a note: how low the thump sits,
  // and how bright and how loud the scuff over it is. Porcelain scuffs high
  // and sharp, boards thump and barely scuff, a rug does almost neither. Two
  // men in different rooms still sound like two men in different rooms, which
  // is the entire point of listening — they just no longer sound like tap
  // dancers.
  // How much of a footstep the room gets to answer. A shot is an event a flat
  // rings with; a boot is a boot. At the full send every step dragged a tail
  // after it and a corridor sounded like a swimming pool.
  const FOOT_SEND = 0.3;

  const FLOORS = {
    floor:    { thump: 380, dur: 0.085, scuff: 900, bright: 0.16, vol: 1.00 },
    tile:     { thump: 430, dur: 0.060, scuff: 2600, bright: 0.34, vol: 0.95 },
    concrete: { thump: 400, dur: 0.070, scuff: 1500, bright: 0.22, vol: 0.90 },
    wood:     { thump: 320, dur: 0.100, scuff: 700, bright: 0.13, vol: 0.98 },
    metal:    { thump: 460, dur: 0.090, scuff: 3200, bright: 0.42, vol: 1.00 },
    fabric:   { thump: 260, dur: 0.090, scuff: 400, bright: 0.06, vol: 0.55 },
    drywall:  { thump: 380, dur: 0.080, scuff: 1000, bright: 0.18, vol: 0.88 },
  };

  // `own` is your own boot. It does not get panned and it does not get a wall
  // put in front of it: your feet are not somewhere across the room from your
  // ears, they are under you. Hearing them matters — a man who cannot hear
  // himself has no way to learn what running costs, and this game charges for
  // it. So they arrive dry, quiet and straight down the middle, and the room
  // answers them the same way it answers everything else.
  function footstep(pos, loudness, surface = 'floor', { own = false, muffle = 0 } = {}) {
    if (!ensure() || !enabled) return;
    const f = FLOORS[surface] ?? FLOORS.floor;
    const t = ctx.currentTime;
    const out = own ? ownVoice(FOOT_SEND) : panner(pos, 1.2, 26, muffle, FOOT_SEND);
    // This number is before the filters, and they throw most of it away: a
    // lowpass at 400 Hz keeps about a third of a noise burst, so what reaches
    // the ear is a third of what is written here. Measured at the output it is
    // a third of what a footstep used to be — the old ones were louder than
    // the room they were walking through.
    const vol = Math.min(1.1, 0.15 + loudness * 0.043) * f.vol * (own ? 0.62 : 1);

    // The sole landing. Lowpass rather than bandpass — a thump is everything
    // below a line, and cutting the bottom out of it is what left a click —
    // and the noise is played back slow, which drags its own spectrum down to
    // where the filter can do something with it instead of deleting it.
    const body = noiseSource(f.dur, 0.10 + Math.random() * 0.06);
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = f.thump * (0.9 + Math.random() * 0.2);
    low.Q.value = 0.9;
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0, t);
    bodyGain.gain.linearRampToValueAtTime(vol, t + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0006, t + f.dur);
    body.connect(low).connect(bodyGain).connect(out);

    // ...and the rubber rolling off it, a moment later and much quieter. Wide
    // Q on purpose: any narrower and it starts to have a pitch again.
    const scuffDur = f.dur * 0.55;
    // The buffer has to outlive the envelope, which starts a few milliseconds
    // late — otherwise the source stops mid-decay and puts a click back in.
    const scuff = noiseSource(scuffDur + 0.02, 0.8 + Math.random() * 0.3);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = f.scuff * (0.85 + Math.random() * 0.3);
    band.Q.value = 0.7;
    const scuffGain = ctx.createGain();
    const at = t + 0.008 + Math.random() * 0.006;
    scuffGain.gain.setValueAtTime(0, at);
    scuffGain.gain.linearRampToValueAtTime(vol * f.bright, at + 0.003);
    scuffGain.gain.exponentialRampToValueAtTime(0.0005, at + scuffDur);
    scuff.connect(band).connect(scuffGain).connect(out);
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

  function doorSound(pos, kind, muffle = 0) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const out = panner(pos, 2, 34, muffle);

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
  function blast(pos, kind = 'blast', muffle = 0) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const out = panner(pos, 3, kind === 'smoke' ? 20 : 60, muffle);
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

  // The consumer unit going over: a hard mechanical clack and, under it, the
  // building's hum stopping. It carries, and it is meant to — cutting the
  // power tells everyone in the flat both that it happened and roughly where
  // the man who did it was standing.
  function breaker(pos, on) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const out = panner(pos, 3, POWER_CARRY);

    const clack = noiseSource(0.09, 1.0);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1400;
    band.Q.value = 0.9;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.5, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    clack.connect(band).connect(cg).connect(out);

    // The hum: it drops away when the mains go and comes back when they return.
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.setValueAtTime(50, t);
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(on ? 0.001 : 0.07, t);
    hg.gain.exponentialRampToValueAtTime(on ? 0.05 : 0.001, t + 0.35);
    hg.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    hum.connect(hg).connect(out);
    hum.start(t);
    hum.stop(t + 0.75);
  }

  // A flare catching: a scrape, then the hiss of it burning.
  function flare(pos) {
    if (!ensure() || !enabled) return;
    const t = ctx.currentTime;
    const out = panner(pos, 2, 22);
    const src = noiseSource(1.1, 1.0);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(3200, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.02, t + 1.0);
    src.connect(f).connect(g).connect(out);
  }

  return {
    resume,
    setListener,
    setSpace,
    gunshot,
    footstep,
    impact,
    doorSound,
    click,
    blast,
    alarm,
    breaker,
    flare,
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
