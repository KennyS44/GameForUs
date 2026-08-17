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

// Every weapon in the roster is a stub today: all eight share one set of
// numbers, the ones the single gun used to have. This pass is about the frame —
// a choice that reaches the simulation and the other players — not the balance.
// Real figures arrive one weapon at a time, by editing an entry below.
//
// Names are the codes from the blueprint sheets in docs/weapons.html: no entry
// here carries a manufacturer's name or model number.
const STUB = {
  magSize: 30,
  reserveMags: 4,
  rpm: 800,
  damage: 'torso',
  muzzleVelocity: 400,
  reloadTime: 2.4,
  reloadTimeEmpty: 3.1,
  // Recoil is a fixed spray pattern, not a dice roll: the first seven shots
  // walk the muzzle up a known path with a bend in it. Learn the path and
  // you can hold it. After that the climb slows to a crawl and the barrel
  // starts wandering and trembling instead — a long burst is still a worse
  // idea than a short one, but it is a decision rather than a coin toss.
  //
  // Deltas are radians [yaw, pitch] per shot, counted from the moment you
  // opened fire. The magazine has nothing to do with it: fire seven, let go
  // for a third of a second, and the next shot starts the path again.
  recoilClimb: [
    [0.000, 0.016],
    [-0.003, 0.024],
    [-0.005, 0.028],
    [-0.005, 0.028],
    [-0.003, 0.025],
    [0.001, 0.021],
    [0.004, 0.017],
  ],
  // Every shot after the path. The climb is a fraction of the opening seven,
  // but it never stops: hold the trigger to the end of the magazine and the
  // sights keep creeping up and wandering wider. This is recoil, not spread —
  // the cone of fire below is untouched, so the rounds still go where the
  // barrel is pointing. `shake` is a small random kick on top, enough that
  // the muzzle visibly trembles late in a burst without hiding the pattern.
  recoilSettle: { pitch: 0.006, yaw: 0.016, sway: 0.9, shake: 0.0035 },
  recoilRecovery: 5.2, // how quickly the sights settle back once you stop
  // Trigger released for this long and the pattern starts over.
  burstResetTime: 0.28,
  // Cone of fire (radians) added on top of recoil.
  spreadHip: 0.032,
  spreadAim: 0.0035,
  spreadMoving: 0.028,
  aimTime: 0.22,
  penetration: 8, // centimetres of drywall it can punch through
  loudness: 40, // metres the shot carries
};

export const WEAPONS = {
  'pp-9': { ...STUB, name: 'PP-9', cls: 'smg', blurb: '9×19, роликовое запирание' },
  'pp-45': { ...STUB, name: 'PP-45', cls: 'smg', blurb: '.45, гасящий затвор' },
  'av-74': { ...STUB, name: 'AV-74', cls: 'rifle', blurb: '5,45×39, длинный ход поршня' },
  'ar-556': { ...STUB, name: 'AR-556', cls: 'rifle', blurb: '5,56×45, короткий ход поршня' },
  'sg-12p': { ...STUB, name: 'SG-12P', cls: 'shotgun', blurb: '12 калибр, помповое' },
  'sg-12d': { ...STUB, name: 'SG-12D', cls: 'shotgun', blurb: '12 калибр, обрез' },
  'amr-50': { ...STUB, name: 'AMR-50', cls: 'sniper', blurb: '.50, самозарядная' },
  'dmr-762': { ...STUB, name: 'DMR-762', cls: 'sniper', blurb: '7,62×51, марксманская' },
};

// What everyone carries until they pick something else.
export const DEFAULT_WEAPON = 'pp-9';

// The order the loadout screen lays its sections out in, so adding a weapon
// means adding it above rather than editing the markup.
export const WEAPON_CLASSES = [
  { id: 'smg', label: 'Пистолеты-пулемёты' },
  { id: 'rifle', label: 'Штурмовые' },
  { id: 'shotgun', label: 'Дробовики' },
  { id: 'sniper', label: 'Снайперские' },
];

export const DOOR = {
  // A door swings flat against the wall, not to a tidy right angle, so an
  // opened doorway is genuinely clear instead of half blocked by its panel.
  // Its hinges sit on the face of the wall, so "flat" really does mean
  // touching the jamb.
  openAngle: (178 * Math.PI) / 180,
  openSpeed: 2.2, // radians/sec when pushed open normally
  sneakSpeed: 0.5, // slow, quiet nudge
  kickSpeed: 11.0,
  kickRange: 1.7,
  // A kick always bursts the door open on the first try — waiting out several
  // kicks in a doorway is not a decision, it is just a delay.
  kickDamage: 260,
  health: 100,
  // Glass takes two rounds and falls out of the frame altogether.
  glassHits: 2,
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
  // Half a minute at the loadout screen, both sides at once, nobody moving.
  // Set this to 0 and the phase disappears: picking a weapon is allowed all
  // through staging too, so the choice simply folds into the minute below.
  selectTime: 30,
  // Then half a minute of staging. The attackers are held at the door for it
  // while the defenders take the flat — that asymmetry is the point of the
  // phase, and the map says which rooms each side may be in while it lasts.
  prepTime: 30,
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
