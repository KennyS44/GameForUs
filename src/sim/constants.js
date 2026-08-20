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

// Damage: every hit hurts, no hit is a coin flip you lose the round to.
//
// The rule the whole roster is built around: one hit never kills a healthy
// player. Not a lucky round out of a spray, not a head clipped by the ninth
// bullet of a burst — the fight is decided by how many rounds you land, which
// is what makes aiming worth anything. The single exception is the .50, and
// only on a clean line: put a wall in front of it and it obeys the rule too.
//
// A weapon carries its own torso figure (see the roster below); what lives
// here is what every weapon shares — where a hit landed and what it went
// through on the way.
export const DAMAGE = {
  // No single hit may take more than this, so the worst case still leaves 15
  // health and a chance to shoot back, break line of sight or close a door.
  // The ceiling is what makes the rule a rule rather than a lucky sum: every
  // figure below can be retuned without ever creating a one-shot kill.
  maxPerHit: 85,
  // Multipliers on the weapon's torso damage. A head hit is worth nearly two
  // body hits and halves how long anyone needs to be exposed — decisive, but
  // still a hit you have to follow up.
  head: 1.8,
  limb: 0.55,
  // Buckshot gets no head bonus at all. A pattern is a dozen small hits, and
  // multiplying every one of them by a head hit is how a shotgun ends up
  // killing outright at the door — which is exactly what this roster does not
  // do. Aiming a shotgun still pays: more of the pattern lands.
  pelletHead: 1.0,
  // Armour soaks a flat amount per hit on the torso only. Buckshot is stopped
  // best by a vest, armour-piercing rounds barely notice it: each weapon
  // scales this with its own `armourPierce`. Kept modest, because a flat soak
  // punishes the low-damage weapons hardest and would push an SMG to six
  // rounds a kill.
  armourReduction: 12,
  // Bullets lose damage passing through cover.
  penetrationLossPerCm: 3.5,
};

// ── The roster ─────────────────────────────────────────────────────────────
//
// Eleven weapons, one per blueprint sheet in docs/weapons.html, and the ids
// here are the sheet ids: one name for a gun across the drawing, the model and
// the simulation. No entry carries a manufacturer's name or model number.
//
// Where the numbers come from. Rate of fire, magazine and barrel length are
// ours — they are printed on the sheets. Everything that decides a fight is
// lifted from two games that already solved this balance and checked against
// each other: Rainbow Six Siege (measured live values, Y11S2.3) for the shape
// of the roster, and Zero Hour where Siege has no equivalent — its sawn-off
// and its flat, no-falloff damage model are closer to what this game is.
// Each entry says which real gun its figures were taken from.
//
// Two conversions were applied to every Siege figure:
//
//   Damage x1.2, then trimmed to the shots-to-kill this game wants. Siege
//   bodies hold 100-125 health; ours hold 100 and nobody dies to one round.
//   That fixes the ceiling — the hardest rifle lands on 52, because 52 x 1.8
//   to the head is 94 and a head hit still has to be followed up — and the
//   rest of the ladder is set by shots to kill rather than by the multiplier:
//   three body hits for a rifle, four for an SMG, two for the marksman rifle,
//   two patterns for a shotgun. Inside a class the Siege ordering survives:
//   the AK-derived AV-74 still hits harder than the C8-derived AR-556.
//
//   Damage falloff is Siege's own model, stated in their Y6S3 designer's
//   notes: full damage to `near` metres, a straight line down to `far`, then
//   a floor. Their class figures are 25/35/60% for rifles, 18/28/60% for
//   SMGs, 30/40/70% for marksman rifles, and buckshot falls to 45% by 13 m.
//   The flat is 32 x 24 m, so only the heavy pair ever reaches its floor.
//
// Aim times are Siege's class ladder (SMG < rifle < marksman < heavy) rescaled
// to the quarter-second this game already used, not its absolute values.

// Recoil is a fixed spray pattern, not a dice roll: the first seven shots
// walk the muzzle up a known path with a bend in it. Learn the path and you
// can hold it. After that the climb slows to a crawl and the barrel starts
// wandering and trembling instead — a long burst is still a worse idea than a
// short one, but it is a decision rather than a coin toss.
//
// Every weapon walks the same shape and differs only in how hard: a pattern
// learned on one gun reads the same on the next, which is the point of having
// a pattern at all. Fractions of the worst shot, [yaw, pitch].
const CLIMB_SHAPE = [
  [0.000, 0.571],
  [-0.107, 0.857],
  [-0.180, 1.000],
  [-0.180, 1.000],
  [-0.107, 0.893],
  [0.036, 0.750],
  [0.143, 0.607],
];

// `peak` is the radians the muzzle jumps on the worst shot of the path.
// Deltas are counted from the moment you opened fire; the magazine has nothing
// to do with it. Fire seven, let go for a third of a second, and the path
// starts again.
const climb = (peak) => CLIMB_SHAPE.map(([y, p]) => [
  Math.round(y * peak * 1e5) / 1e5,
  Math.round(p * peak * 1e5) / 1e5,
]);

// Every shot after the path. The climb is a fraction of the opening seven, but
// it never stops: hold the trigger to the end of the magazine and the sights
// keep creeping up and wandering wider. This is recoil, not spread — the cone
// of fire is untouched, so rounds still go where the barrel is pointing.
// `shake` is a small random kick on top, enough that the muzzle visibly
// trembles late in a burst without hiding the pattern.
const settle = (peak) => ({
  pitch: peak * 0.21,
  yaw: peak * 0.57,
  sway: 0.9,
  shake: peak * 0.125,
});

// Defaults every entry shares, so a weapon line says only what makes it itself.
const gun = (def) => ({
  pellets: 1,
  fireMode: 'auto',
  reloadStyle: 'mag', // 'mag' drops the partial magazine; 'shell' tops up one at a time
  armourPierce: 1,
  moveScale: 1,
  muzzleVelocity: 400,
  recoilRecovery: 5.2, // how quickly the sights settle back once you stop
  burstResetTime: 0.28, // trigger released for this long and the pattern restarts
  doorDamage: 8, // per projectile, against a door's 100 health
  ...def,
  recoilClimb: climb(def.peak),
  recoilSettle: settle(def.peak),
});

export const WEAPONS = {
  // ── Submachine guns ──
  // MP5: 27 damage at 799 rpm, the middle of Siege's SMG class in every stat.
  'smg-9-roller': gun({
    name: 'PP-9', cls: 'smg', blurb: '9×19, роликовое запирание',
    from: 'Rainbow Six Siege — MP5 (27 dmg, 799 rpm, 30+1)',
    damage: 42, rpm: 800, magSize: 30, reserve: 120,
    reloadTime: 2.2, reloadTimeEmpty: 2.9,
    range: { near: 18, far: 28, floor: 0.6 },
    peak: 0.019, spreadHip: 0.030, spreadAim: 0.0030, spreadMoving: 0.026,
    aimTime: 0.24, penetration: 6, loudness: 36,
  }),
  // P90: the class's largest magazine and its lowest damage, 22 at 968 rpm.
  // The 5.7 round is what makes it worth carrying: it goes through a vest
  // almost untouched, so its poor torso figure barely gets worse against one.
  'smg-57-pdw': gun({
    name: 'PDW-57', cls: 'smg', blurb: '5,7×28, буллпап, магазин 50',
    from: 'Rainbow Six Siege — P90 (22 dmg, 968 rpm, 50+1)',
    damage: 34, rpm: 950, magSize: 50, reserve: 100,
    reloadTime: 2.4, reloadTimeEmpty: 2.9,
    range: { near: 18, far: 28, floor: 0.6 },
    peak: 0.014, spreadHip: 0.028, spreadAim: 0.0028, spreadMoving: 0.024,
    aimTime: 0.22, penetration: 9, loudness: 38, armourPierce: 0.35,
  }),
  // Vector: 23 damage at 1200 rpm, the fastest gun in Siege and the shortest
  // barrel here, so it also loses its damage earlier than the rest of the class.
  'smg-45-inline': gun({
    name: 'PP-45', cls: 'smg', blurb: '.45 ACP, гасящий затвор',
    from: 'Rainbow Six Siege — Vector .45 ACP (23 dmg, 1200 rpm, 25+1)',
    damage: 38, rpm: 1100, magSize: 25, reserve: 125,
    reloadTime: 2.0, reloadTimeEmpty: 2.8,
    range: { near: 14, far: 24, floor: 0.55 },
    peak: 0.016, spreadHip: 0.034, spreadAim: 0.0034, spreadMoving: 0.030,
    aimTime: 0.23, penetration: 5, loudness: 34,
  }),

  // ── Assault rifles ──
  // AK-74M: Siege's hardest-hitting rifle at 44, and its slowest at 650 rpm.
  'ar-545-piston': gun({
    name: 'AV-74', cls: 'rifle', blurb: '5,45×39, длинный ход поршня',
    from: 'Rainbow Six Siege — AK-74M (44 dmg, 650 rpm)',
    damage: 52, rpm: 600, magSize: 30, reserve: 120,
    reloadTime: 2.4, reloadTimeEmpty: 3.2,
    range: { near: 25, far: 35, floor: 0.6 },
    peak: 0.034, spreadHip: 0.040, spreadAim: 0.0030, spreadMoving: 0.034,
    aimTime: 0.30, penetration: 14, loudness: 47, moveScale: 0.95, doorDamage: 10,
  }),
  // C8-SFW: 40 damage at 837 rpm — the easy one, fast and forgiving.
  'ar-556-piston': gun({
    name: 'AR-556', cls: 'rifle', blurb: '5,56×45, короткий ход поршня',
    from: 'Rainbow Six Siege — C8-SFW (40 dmg, 837 rpm)',
    damage: 48, rpm: 800, magSize: 30, reserve: 120,
    reloadTime: 2.2, reloadTimeEmpty: 3.0,
    range: { near: 25, far: 35, floor: 0.6 },
    peak: 0.024, spreadHip: 0.038, spreadAim: 0.0026, spreadMoving: 0.032,
    aimTime: 0.28, penetration: 13, loudness: 46, moveScale: 0.96, doorDamage: 10,
  }),
  // AR33: 41 damage, polymer lower, side-folding stock, one rail the length of
  // the gun. Slower than the piston carbine and steadier for it.
  'ar-556-folder': gun({
    name: 'AC-556', cls: 'rifle', blurb: '5,56×45, полимерная коробка, складной',
    from: 'Rainbow Six Siege — AR33 (41 dmg, 749 rpm)',
    damage: 50, rpm: 620, magSize: 30, reserve: 120,
    reloadTime: 2.3, reloadTimeEmpty: 3.1,
    range: { near: 28, far: 38, floor: 0.65 },
    peak: 0.026, spreadHip: 0.042, spreadAim: 0.0022, spreadMoving: 0.034,
    aimTime: 0.32, penetration: 13, loudness: 46, moveScale: 0.93, doorDamage: 10,
  }),

  // ── Shotguns ──
  // Zero Hour's sawn-off: seven pellets, and the hardest pellet in the game —
  // its 35 chest against the pump gun's 30. Two rounds, no stock, no sights.
  'sg-12-double': gun({
    name: 'SG-12D', cls: 'shotgun', blurb: '12 калибр, обрез, два ствола',
    from: 'Zero Hour — Sawed Off (7 pellets, 35 chest, 2 rounds)',
    damage: 12, pellets: 7, fireMode: 'semi', rpm: 240, magSize: 2, reserve: 16,
    reloadTime: 3.4, reloadTimeEmpty: 3.4,
    range: { near: 4, far: 11, floor: 0.4 },
    peak: 0.130, spreadHip: 0.105, spreadAim: 0.075, spreadMoving: 0.120,
    aimTime: 0.18, penetration: 2, loudness: 52, armourPierce: 1.2,
    moveScale: 1.02, doorDamage: 16,
  }),
  // M590A1: Siege's hardest shotgun, 48 a pellet across eight pellets, and its
  // slowest at 87 rpm. Shells go in one at a time, so a reload can be cut short.
  'sg-12-pump': gun({
    name: 'SG-12P', cls: 'shotgun', blurb: '12 калибр, помповое, магазин 7',
    from: 'Rainbow Six Siege — M590A1 (48/pellet x8, 87 rpm, 6+1)',
    damage: 11, pellets: 8, fireMode: 'semi', rpm: 80, magSize: 7, reserve: 28,
    reloadStyle: 'shell', reloadTime: 0.62, reloadTimeEmpty: 0.62,
    range: { near: 5, far: 13, floor: 0.45 },
    peak: 0.090, spreadHip: 0.095, spreadAim: 0.062, spreadMoving: 0.105,
    aimTime: 0.26, penetration: 2, loudness: 55, armourPierce: 1.2,
    moveScale: 0.93, doorDamage: 12,
  }),
  // SASG-12: the magazine-fed one, 26 a pellet — half the pump's punch, three
  // times its rate, and the only shotgun here that reloads like a rifle.
  'sg-12-mag': gun({
    name: 'SG-12M', cls: 'shotgun', blurb: '12 калибр, самозарядное, магазин 8',
    from: 'Rainbow Six Siege — SASG-12 (26/pellet x8, 348 rpm, 10+1)',
    damage: 8, pellets: 8, fireMode: 'semi', rpm: 240, magSize: 8, reserve: 32,
    reloadTime: 2.6, reloadTimeEmpty: 3.4,
    range: { near: 5, far: 13, floor: 0.45 },
    peak: 0.075, spreadHip: 0.090, spreadAim: 0.058, spreadMoving: 0.100,
    aimTime: 0.28, penetration: 2, loudness: 54, armourPierce: 1.2,
    moveScale: 0.92, doorDamage: 9,
  }),

  // ── Heavy ──
  // Siege has no .50, so its heaviest round stands in: the CSRX 300 at 135
  // damage and 52 rpm, one shot down at any armour, five surfaces punched
  // through. Ours keeps that job and pays for it in everything else.
  'amr-50': gun({
    name: 'AMR-50', cls: 'heavy', blurb: '.50, самозарядная, пробивает стены',
    from: 'Rainbow Six Siege — CSRX 300 (135 dmg, 52 rpm, one-shot down)',
    damage: 190, oneShot: true, fireMode: 'semi', rpm: 60, magSize: 10, reserve: 30,
    reloadTime: 3.2, reloadTimeEmpty: 4.2,
    range: { near: 40, far: 60, floor: 0.85 },
    peak: 0.160, spreadHip: 0.075, spreadAim: 0.0016, spreadMoving: 0.070,
    aimTime: 0.52, penetration: 60, loudness: 75, armourPierce: 0,
    moveScale: 0.78, muzzleVelocity: 850, doorDamage: 60,
  }),
  // 417/CAMRS: 69 damage at 444 rpm, two body shots, and Siege's shallowest
  // falloff. The blueprint's own promise, in their numbers.
  'dmr-762': gun({
    name: 'DMR-762', cls: 'heavy', blurb: '7,62×51, марксманская, магазин 20',
    from: 'Rainbow Six Siege — 417 / CAMRS (69 dmg, 444 rpm, 20+1)',
    damage: 54, fireMode: 'semi', rpm: 300, magSize: 20, reserve: 80,
    reloadTime: 2.5, reloadTimeEmpty: 3.3,
    range: { near: 30, far: 40, floor: 0.7 },
    peak: 0.055, spreadHip: 0.055, spreadAim: 0.0018, spreadMoving: 0.050,
    aimTime: 0.34, penetration: 24, loudness: 55, armourPierce: 0.3,
    moveScale: 0.90, muzzleVelocity: 780, doorDamage: 14,
  }),
};

// What everyone carries until they pick something else: the middle of the
// roster, so a first round is never decided by an unfamiliar gun.
export const DEFAULT_WEAPON = 'smg-9-roller';

// The order the loadout screen lays its sections out in, so adding a weapon
// means adding it above rather than editing the markup.
export const WEAPON_CLASSES = [
  { id: 'smg', label: 'Пистолеты-пулемёты' },
  { id: 'rifle', label: 'Штурмовые' },
  { id: 'shotgun', label: 'Дробовики' },
  { id: 'heavy', label: 'Крупный калибр' },
];

// ── Equipment ──────────────────────────────────────────────────────────────
//
// One device each, and the two sides do not share a list — that split is
// straight out of Zero Hour, where SWAT carry breaching and optics while the
// criminals hold the building with wedges and traps. Attack buys its way
// through a door and takes the room's senses away; defence makes every door
// cost time and noise.
//
// Two kinds, and the difference is how you deliver them:
//   'throw' — lobbed underarm, bounces, then goes off on its fuse.
//   'door'  — fitted to the door you are looking at, within arm's reach.
//
// Nothing here breaks the rule the guns follow: the hardest blast in the list
// takes 70 of 100, so a device wounds and warns, it does not delete anyone.
//
// How far a blast reaches. Zero Hour never publishes a radius — its grenades
// are only ever described as having a small one, and its breaching charge as
// something you stack away from — so the shape here is ours, built to behave
// the way that game feels:
//
//   • `blastCore` metres of full damage — arm's length, the doorway itself.
//   • from there, straight down to nothing at `blastRadius`, so the edge of a
//     blast is a scratch rather than a cliff.
//   • no line of sight, no damage at all. A wall, a floor or a cloud between
//     you and it is complete cover, which is why leaning out of the doorway is
//     the difference between a bruise and a body.
//
// The one exception is the panel the device is fitted to: the door you are
// opening does not shield you from the trap taped to it.
export const GADGETS = {
  // Zero Hour's flash needs nothing but a line of sight, and it empties the
  // victim: five seconds blind, and an afterimage long after that. Ours keeps
  // the line-of-sight rule — the wall you are behind is the counter.
  flash: {
    name: 'Светошумовая', team: 'attackers', kind: 'throw', count: 2,
    blurb: 'Слепит всех, кто её видит. За углом — не действует.',
    fuse: 1.6, radius: 14, blind: 5, loudness: 34,
  },
  // Two per player in Zero Hour, full cloud a few seconds after it lands and
  // gone within twenty. It hides bodies from bots as well as from players:
  // the cloud is part of line of sight, not a decal.
  smoke: {
    name: 'Дымовая', team: 'attackers', kind: 'throw', count: 2,
    blurb: 'Облако 3,5 м на 16 секунд: сквозь него не видно никому.',
    fuse: 1.2, radius: 3.5, duration: 16, growTime: 2.5, loudness: 12,
  },
  // The C2 door charge: fitted to the handle, four seconds, and the door is
  // gone rather than merely open. Loud enough that the whole flat hears it.
  charge: {
    name: 'Заряд C2', team: 'attackers', kind: 'door', count: 2,
    blurb: 'На дверь. Через 4 с сносит её вместе с клином — и всех у проёма.',
    fuse: 4, damage: 70, blastCore: 1.2, blastRadius: 3.4, loudness: 50,
  },
  // The wedge blocks opening, not breaking — the same trade Zero Hour makes.
  // The first boot tears it out, the second takes the door: a wedged doorway
  // costs an attacker a second and a lot of noise.
  wedge: {
    name: 'Дверной клин', team: 'defenders', kind: 'door', count: 2,
    blurb: 'Дверь не открыть — только выбить, и с двух ударов.',
  },
  // Zero Hour's door trap: a tripwire and a grenade, seventy damage. Ours
  // hangs the wire where you can see it — and where a steady shot can cut it
  // from across the room, which is the attacker's answer to a wired doorway.
  trap: {
    name: 'Растяжка', team: 'defenders', kind: 'door', count: 1,
    blurb: 'Сработает, когда дверь тронут. Нить видно — и по ней можно попасть.',
    damage: 70, blastCore: 0.9, blastRadius: 2.6, loudness: 42,
  },
  // The door alarm, defender-only over there too. In a game where the ears do
  // the scouting, a doorway that shouts is worth as much as one that holds.
  alarm: {
    name: 'Сигнализация', team: 'defenders', kind: 'door', count: 2,
    blurb: 'Дверь открыли — вой на весь этаж. Слышно за 34 м.',
    loudness: 34,
  },
};

// What each side carries until it picks something else.
export const DEFAULT_GADGET = { attackers: 'flash', defenders: 'wedge' };

// How fast a blinded player recovers once the flash has burned out, and how
// blind a bot has to be before it stops seeing anything at all.
export const BLIND = { fade: 0.22, botThreshold: 0.35 };

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
