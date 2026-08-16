// Every tuning number lives here, so "feels too floaty" is a one-line fix.
// Units: metres, seconds, radians.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const PLAYER = {
  radius: 0.28,
  heightStand: 1.75,
  heightCrouch: 1.15,
  eyeOffset: 0.12, // eyes sit this far below the top of the head

  // Hardcore: slow, deliberate movement. No sprinting across a flat.
  speedWalk: 2.5,
  speedRun: 4.2,
  speedSneak: 1.1,
  speedCrouch: 1.4,

  accelGround: 28,
  friction: 12,
  stepHeight: 0.32,

  // A short hop, not an arena-shooter leap. Landing is loud.
  jumpSpeed: 4.4,
  jumpCooldown: 0.35,

  // Leaning peeks the camera sideways without moving the body much.
  leanMax: 0.42,
  leanAngle: 0.28,
  leanSpeed: 5.0,

  stanceSpeed: 6.0, // how fast you go prone/crouch/stand

  maxHealth: 100,
};

// Field of view is fixed for everyone: a wider FOV would otherwise be a real
// competitive advantage in tight rooms, and this game is decided in doorways.
export const FOV = 80;

export const LOOK = {
  pitchLimit: Math.PI / 2 - 0.02,
};

// Hardcore damage: torso hits kill in one or two rounds, no health regeneration.
export const DAMAGE = {
  head: 200,
  torso: 65,
  limb: 32,
  // Armour soaks a flat amount per hit on the torso only.
  armourReduction: 22,
  // Bullets lose damage passing through cover.
  penetrationLossPerCm: 3.5,
};

export const WEAPONS = {
  mp5: {
    name: 'MP5',
    magSize: 30,
    reserveMags: 4,
    rpm: 800,
    damage: 'torso',
    muzzleVelocity: 400,
    reloadTime: 2.4,
    reloadTimeEmpty: 3.1,
    // Recoil. The first shot is controllable; a held trigger climbs fast and
    // starts wandering sideways, so bursts beat spraying.
    recoilVertical: 0.021, // radians of climb on the first shot
    recoilHorizontal: 0.0075,
    recoilRecovery: 5.2, // how quickly the sights settle back
    // Each further shot in the same burst kicks harder, up to this multiplier.
    recoilRamp: 0.085,
    recoilRampMax: 2.4,
    // Trigger released for this long and the climb resets.
    burstResetTime: 0.28,
    // Cone of fire (radians) added on top of recoil.
    spreadHip: 0.032,
    spreadAim: 0.0035,
    spreadMoving: 0.028,
    aimTime: 0.22,
    penetration: 8, // centimetres of drywall it can punch through
    loudness: 40, // metres the shot carries
  },
};

export const DOOR = {
  // A door swings almost flat against the wall, not to a tidy right angle, so
  // an opened doorway is genuinely clear instead of half blocked by its panel.
  openAngle: (170 * Math.PI) / 180,
  openSpeed: 2.2, // radians/sec when pushed open normally
  sneakSpeed: 0.5, // slow, quiet nudge
  kickSpeed: 11.0,
  kickRange: 1.7,
  // A kick always bursts the door open on the first try — waiting out several
  // kicks in a doorway is not a decision, it is just a delay.
  kickDamage: 260,
  health: 100,
  loudnessKick: 30,
  loudnessOpen: 6,
  loudnessSneak: 1.5,
};

export const LIGHT = {
  health: 1, // one bullet kills a bulb
  loudnessBreak: 12,
};

export const FLASHLIGHT = {
  range: 18,
  angle: 0.42,
  intensity: 11, // candela — Three.js uses physical light units
};

export const ROUND = {
  prepTime: 5,
  // The penthouse is two storeys and thirty-odd rooms: clearing it carefully,
  // rather than running it, is a quarter of an hour of work.
  duration: 900,
};

// Noise a movement style makes, in metres it can be heard.
export const NOISE = {
  run: 22,
  walk: 11,
  sneak: 2.5,
  crouch: 4,
  land: 14,
  reload: 6,
};
