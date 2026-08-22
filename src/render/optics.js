// The sight catalogue: six things that can be clamped to a rail.
//
// Until now a weapon was born wearing one sight and could not be talked out of
// it — the open reflex on nine of the eleven, a scope on the two marksman
// rifles. That is fine while there is nothing to choose between, and a waste of
// the rail the moment there is: what a sight decides is how fast the weapon
// comes to the eye, how much of the room you can still see once it is there,
// and how far away a man is still a man. Three different trades, and a roster
// where every gun makes the same one has a single answer in it.
//
// What a sight is *worth* — its name, its magnification, what it costs in aim
// time — lives in `OPTICS` in src/sim/constants.js, with the rest of the rules,
// because the simulation has to answer those questions in plain Node with no
// renderer. What a sight *looks like* lives here, and the two halves are joined
// at the bottom of this file into one entry per id. Neither half is copied: a
// second table of zoom figures would be a second table to forget.
//
// Units are the blueprints' units: sheet millimetres measured from the weapon's
// aiming reference `def.sight`, negative toward the muzzle, positive toward the
// eye. The conversions are handed to each builder rather than imported, so the
// dependency runs one way — a weapon knows about sights, a sight knows nothing
// about weapons.

import * as THREE from '../../vendor/three.module.js?v=48d5848b';
import { OPTICS as FITTING, OPTICS_BY_CLASS } from '../sim/constants.js?v=48d5848b';

// ── Reticles ───────────────────────────────────────────────────────────────
//
// A mark is projected light, not a painted part. Sized in real millimetres it
// would be a fraction of a pixel across, so everything below is sized to what
// it has to be on the screen and divided back out of the viewmodel's own
// scale — which is why an AMR's chevron is the same chevron as a rifle's.
const ETCH_LINE = 0.0011;   // thickness of an etched line
const SCOPE_DOT = 0.0046;   // the dot in the middle of a scope's cross
const CHEVRON = 0.0086;     // the prism's chevron, apex to the end of a leg
const STEM = { gap: 0.0028, len: 0.0086 };  // and the stem hanging under it

// A projected dot is instead a fraction of its own window, the same fraction on
// every sight that has one: that is what a mark quoted in minutes of angle
// actually is, and it keeps the closed tube's dot and the open reflex's dot
// looking like the same dot.
const DOT_OF_GLASS = 0.055;

// ── Where the mark sits ────────────────────────────────────────────────────
//
// `def.sight[1]` is the blueprint's own figure: the middle of a tube lying on
// the rail. Anything that stands off the rail on a mount of its own sits higher
// than that, and iron sights — which have no mount at all — sit lower. This is
// not cosmetic. The renderer puts exactly this height on the middle of the
// screen, so a sight drawn at one height and referenced at another aims at the
// wall above the target.
const RISE = 11;   // how far a collimator's glass stands above a tube's axis

// Iron sights are the exception, because they are the one thing here that does
// not bring a riser with it. They are measured off the two blocks the drawing
// already puts on the rail under the optic: those blocks become the sight's own
// base, and the line runs `IRON.clear` above them — close enough that their
// tops sit just under it, the way the shoulders of a rear blade do.
const IRON = {
  clear: 12,   // how far the sight line runs above the mounts
  post: 3,     // width of the front post
  ear: 2.4,    // the guards either side of it
  earGap: 11,  // and how far apart they stand
  notch: 10,   // the gap in the rear blade
  blade: 24,   // how wide that blade is
  floor: 5,    // how much steel is left under the notch
  bead: 1.7,   // the fibre bead on top of the post
};

// The two blocks on the rail that carry the optic. Every drawing on the roster
// has exactly one pair of them, sitting inside the optic's own footprint and
// reaching up toward its axis, so they can be found rather than named: a slab
// lying wholly within the `sight` part and coming up to within 20 mm of the
// sight line is a mount, and nothing else on the weapon is.
function mounts(def) {
  const seat = def.parts.find((p) => p[0] === 'sight');
  const found = [];
  if (seat) {
    const from = Math.min(seat[1], seat[2]);
    const to = Math.max(seat[1], seat[2]);
    for (const part of def.parts) {
      if (part[0] !== 'slab') continue;
      const x0 = Math.min(part[1], part[2]);
      const x1 = Math.max(part[1], part[2]);
      if (x0 < from || x1 > to) continue;
      const top = Math.max(part[3], part[4]);
      if (top < def.sight[1] - 20) continue;
      found.push({ at: (x0 + x1) / 2, top });
    }
  }
  // A drawing built some other way falls back on where the pair sits on every
  // weapon that does have one, rather than on nothing.
  if (!found.length) {
    return { front: def.sight[0] - 40, back: def.sight[0] + 40, top: def.sight[1] - 15 };
  }
  return {
    front: Math.min(...found.map((m) => m.at)),
    back: Math.max(...found.map((m) => m.at)),
    top: Math.max(...found.map((m) => m.top)),
  };
}

// How high the aiming reference sits with this sight fitted, in sheet
// millimetres above the bore.
export function opticHeightFor(def, opticId) {
  return (OPTICS[opticId] ?? OPTICS.reflex).height(def);
}

// Which sights this weapon may be fitted with, in the order a menu should show
// them. The class rule is the simulation's, because the network has to check it
// too; what is added here is the guarantee that whatever the weapon already
// wears is in the list — a rule that could forbid the thing on the drawing
// would be a rule with a bug in it.
export function opticsFor(def) {
  const list = OPTICS_BY_CLASS[def.cls] ?? OPTICS_BY_CLASS.rifle;
  const worn = defaultOpticFor(def);
  return list.includes(worn) ? list : [...list, worn];
}

// What it wears when nobody has chosen: whatever the drawing has on it.
export function defaultOpticFor(def) {
  return def.optic ?? 'reflex';
}

// ── The shapes ─────────────────────────────────────────────────────────────
//
// One entry per id: how high it puts the mark, and how to draw it. Listed from
// open to magnified, because that is the direction the trade runs in.

const SHAPES = {
  iron: {
    height: (def) => mounts(def).top + IRON.clear,
    build(group, def, z, scale, h) {
      const { MM, MATS } = h;
      const m = mounts(def);
      const y = opticHeightFor(def, 'iron') * MM;
      const block = h.block(group, def, z, y);
      const stand = IRON.clear;
      const front = m.front - def.sight[0];
      const back = m.back - def.sight[0];

      // The front post, standing on the forward mount with its tip exactly on
      // the sight line, and the two ears that keep it from being bent. The ears
      // stand wider apart than the rear notch and a good deal further away, so
      // what you see through the notch is the post between two uprights and not
      // the uprights themselves.
      block(IRON.post * MM, stand * MM, 5 * MM, 0, -(stand / 2) * MM, front);
      for (const side of [-1, 1]) {
        block(IRON.ear * MM, (stand + 3) * MM, 5 * MM,
          side * (IRON.earGap / 2) * MM, -(stand / 2 - 1.5) * MM, front);
      }

      // A fibre bead on the tip. Irons project nothing, so the mark is the top
      // of the post — and on a dark landing the top of a black post against a
      // black doorway is no mark at all. This is the one part of an iron sight
      // that is allowed to glow.
      const bead = new THREE.Mesh(new THREE.SphereGeometry(IRON.bead * MM, 10, 8), MATS.dot);
      bead.position.set(0, y, z(def.sight[0] + front));
      group.add(bead);

      // The rear blade: two shoulders with a notch cut between them, standing
      // on the rear mount. The shoulders come up to the sight line, so lining
      // the post's tip up with them is the same act as putting the mark on the
      // middle of the screen.
      const shoulder = (IRON.blade - IRON.notch) / 2;
      for (const side of [-1, 1]) {
        block(shoulder * MM, stand * MM, 4 * MM,
          side * ((IRON.notch + shoulder) / 2) * MM, -(stand / 2) * MM, back);
      }
      block(IRON.blade * MM, IRON.floor * MM, 4 * MM,
        0, -(stand - IRON.floor / 2) * MM, back);
    },
  },

  dot: {
    height: (def) => def.sight[1] + RISE,
    build(group, def, z, scale, h) {
      const { MM, MATS } = h;
      const y = opticHeightFor(def, 'dot') * MM;
      const block = h.block(group, def, z, y);
      const T = TUBE;
      const inner = (T.radius - T.wall) * MM;

      // The body, open at both ends and drawn inside as well as out, so aiming
      // down it shows the room through it rather than a black cylinder.
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(T.radius * MM, T.radius * MM, (T.back - T.front) * MM, 20, 1, true),
        MATS.housing,
      );
      body.rotation.x = Math.PI / 2;
      body.position.set(0, y, z(def.sight[0] + (T.front + T.back) / 2));
      group.add(body);

      // Steel rims round both ends: what says at a glance that this tube is a
      // sight and not a length of pipe.
      for (const at of [T.front + T.ring, T.back - T.ring]) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(T.radius * MM, T.ring * MM, 6, 20),
          MATS.steel,
        );
        ring.position.set(0, y, z(def.sight[0] + at));
        group.add(ring);
      }

      // Glass at each end — that is what closed means — and the ring of light
      // where the front one meets the housing.
      for (const at of [T.front + 5, T.back - 5]) {
        const glass = new THREE.Mesh(new THREE.CircleGeometry(inner, 24), MATS.lens);
        glass.position.set(0, y, z(def.sight[0] + at));
        group.add(glass);
      }
      const rim = new THREE.Mesh(new THREE.RingGeometry(inner * 0.86, inner, 28), MATS.rim);
      rim.position.set(0, y, z(def.sight[0] + T.front + 7));
      group.add(rim);

      // The dot, floating just behind the front glass where the emitter throws
      // it, with a halo under it so it reads as light and not as a red pixel.
      const at = z(def.sight[0] + T.front + 10);
      const dot = inner * DOT_OF_GLASS;
      const halo = new THREE.Mesh(new THREE.CircleGeometry(dot * 2.6, 16), MATS.glow);
      halo.position.set(0, y, at);
      group.add(halo);
      const core = new THREE.Mesh(new THREE.CircleGeometry(dot, 16), MATS.dot);
      core.position.set(0, y, at + 0.0004);
      group.add(core);

      // The saddle bridging the gap down to the mounts the drawing puts on the
      // rail, and the thumbscrew that clamps it there.
      block(T.mount * MM, 8 * MM, 44 * MM, 0, -(T.radius + 1) * MM, -2);
      clampScrew(group, MATS, MM, y - (T.radius + 1) * MM, z(def.sight[0] + 14));
    },
  },

  reflex: {
    height: (def) => def.sight[1] + RISE,
    build: buildReflex,
  },

  holo: {
    height: (def) => def.sight[1] + RISE,
    build(group, def, z, scale, h) {
      const { MM, MATS } = h;
      const y = opticHeightFor(def, 'holo') * MM;
      const block = h.block(group, def, z, y);
      const H = HOLO;
      const half = { w: (H.windowW / 2) * MM, h: (H.windowH / 2) * MM };
      const frame = H.frame * MM;
      const outerW = half.w + frame;

      // The bezel round the opening. Half again as wide as it is tall, which is
      // this sight's whole silhouette: the open reflex is a window, this is a
      // letterbox, and you can tell them apart across a room.
      const bezel = 8 * MM;
      block(frame, half.h * 2 + frame * 2, bezel, -(half.w + frame / 2), 0, H.glassAt);
      block(frame, half.h * 2 + frame * 2, bezel, half.w + frame / 2, 0, H.glassAt);
      block(outerW * 2, frame, bezel, 0, half.h + frame / 2, H.glassAt);
      block(outerW * 2, frame, bezel, 0, -(half.h + frame / 2), H.glassAt);

      // ...and the boxy hood behind it: roof, floor and two cheeks running back
      // toward the eye, open at both ends. A holographic sight is a rectangular
      // tunnel with a picture hanging in the front of it, and the four flat
      // sides are what make the picture look like it is hanging there.
      const wall = H.wall * MM;
      const mid = H.glassAt + H.body / 2;
      const shell = outerW * 2 + wall * 2;
      block(shell, H.roof * MM, H.body * MM, 0, half.h + frame + (H.roof / 2) * MM, mid);
      block(shell, H.floor * MM, H.body * MM, 0, -(half.h + frame + (H.floor / 2) * MM), mid);
      for (const side of [-1, 1]) {
        block(wall, half.h * 2 + frame * 2, H.body * MM, side * (outerW + wall / 2), 0, mid);
      }
      clampScrew(group, MATS, MM,
        y - (half.h + frame + H.floor * MM), z(def.sight[0] + H.glassAt + 40));

      // The glass, with a thin bright edge drawn as four slivers rather than as
      // a plane, so the middle of the window stays clear.
      const on = z(def.sight[0] + H.glassAt);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(half.w * 2, half.h * 2), MATS.lens);
      glass.position.set(0, y, on);
      group.add(glass);
      const lip = 0.7 * MM;
      const edge = (w, hh, dx, dy) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), MATS.edge);
        m.position.set(dx, y + dy, on + 0.0004);
        group.add(m);
      };
      edge(half.w * 2, lip, 0, half.h - lip / 2);
      edge(half.w * 2, lip, 0, -(half.h - lip / 2));
      edge(lip, half.h * 2, -(half.w - lip / 2), 0);
      edge(lip, half.h * 2, half.w - lip / 2, 0);

      // And the mark: a ring with a dot in the middle of it. The ring is the
      // whole argument for this sight — far too big to aim with, which is the
      // point, because you drop it over a man in a doorway without looking for
      // anything. The dot inside is there for when there is time to look.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(half.h * (H.ring - H.ringLine), half.h * H.ring, 40),
        MATS.dot,
      );
      ring.position.set(0, y, on + 0.001);
      group.add(ring);
      const dot = half.h * H.dot;
      const halo = new THREE.Mesh(new THREE.CircleGeometry(dot * 2.4, 16), MATS.glow);
      halo.position.set(0, y, on + 0.0008);
      group.add(halo);
      const core = new THREE.Mesh(new THREE.CircleGeometry(dot, 16), MATS.dot);
      core.position.set(0, y, on + 0.0012);
      group.add(core);
    },
  },

  prism: {
    // On its own mount, like the collimators and unlike the marksman tube.
    // Sat at the bare blueprint height it is a tube bolted flat to the
    // receiver, and the receiver then fills the bottom third of the sight
    // picture — which at 1.8× is the third the target is standing in.
    height: (def) => def.sight[1] + RISE,
    build(group, def, z, scale, h) {
      const { MM, MATS } = h;
      const y = opticHeightFor(def, 'prism') * MM;
      const P = PRISM;
      const inner = (P.radius - P.wall) * MM;
      const s = 1 / scale;

      // A stubby body — a prism sight is short because the glass does its
      // folding inside instead of down a foot of tube — with the eyepiece
      // flared out at the back where the eye goes.
      const bodyBack = P.back - P.ocularLen;
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(P.radius * MM, P.radius * MM, (bodyBack - P.front) * MM, 20, 1, true),
        MATS.housing,
      );
      body.rotation.x = Math.PI / 2;
      body.position.set(0, y, z(def.sight[0] + (P.front + bodyBack) / 2));
      group.add(body);

      const ocular = new THREE.Mesh(
        new THREE.CylinderGeometry(P.ocular * MM, P.ocular * MM, P.ocularLen * MM, 20, 1, true),
        MATS.housing,
      );
      ocular.rotation.x = Math.PI / 2;
      ocular.position.set(0, y, z(def.sight[0] + bodyBack + P.ocularLen / 2));
      group.add(ocular);

      for (const [at, radius] of [[P.front + P.ring, P.radius], [P.back - P.ring, P.ocular]]) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(radius * MM, P.ring * MM, 6, 20),
          MATS.steel,
        );
        ring.position.set(0, y, z(def.sight[0] + at));
        group.add(ring);
      }

      const glass = new THREE.Mesh(new THREE.CircleGeometry(inner, 24), MATS.lens);
      glass.position.set(0, y, z(def.sight[0] + P.front + 6));
      group.add(glass);
      const rim = new THREE.Mesh(new THREE.RingGeometry(inner * 0.88, inner, 28), MATS.rim);
      rim.position.set(0, y, z(def.sight[0] + P.front + 8));
      group.add(rim);

      // The reticle is etched into the glass, which means it is still there
      // with the battery out — the argument for a prism over a dot, and it
      // should look like it. A chevron with its point on the aim, and a stem
      // under it to hang holdover off. Nothing at all is drawn above the point:
      // what you are shooting has to sit on top of it, uncovered.
      const at = z(def.sight[0]);
      const bar = (w, hh, x, dy, roll) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, 0.0006), MATS.etch);
        m.position.set(x, y + dy, at);
        m.rotation.z = roll;
        group.add(m);
      };
      const leg = CHEVRON * s;
      const line = ETCH_LINE * s;
      const arm = (leg / 2) * Math.SQRT1_2;
      bar(leg, line, -arm, -arm, Math.PI / 4);
      bar(leg, line, arm, -arm, -Math.PI / 4);
      bar(line, STEM.len * s, 0, -(STEM.gap * s + (STEM.len * s) / 2), 0);
    },
  },

  scope: {
    height: (def) => def.sight[1],
    build: buildScope,
  },
};

// What a sight is worth, joined to what it looks like. The keys come from this
// file, because six shapes is what it can draw; the figures come from the
// simulation's table, because that is where a number belongs when the rules
// read it.
export const OPTICS = Object.fromEntries(
  Object.entries(SHAPES).map(([id, shape]) => [id, {
    name: id, blurb: '', zoom: 1, aimScale: 1, ...FITTING[id], ...shape,
  }]),
);

// ── The tubes and boxes, in millimetres ────────────────────────────────────

// The closed collimator, drawn off a T-2. A 30 mm tube is a fraction of what
// the open reflex's window is, and everything about how this sight plays comes
// out of that: a smaller hole to find with your eye, a rim to level the weapon
// by, and the rest of the room gone.
const TUBE = {
  radius: 21,
  wall: 2.2,
  front: -38,
  back: 34,
  ring: 2.2,    // the steel rims that finish each end
  mount: 26,    // the saddle down to the rail
};

// The holographic sight, drawn off an EOTech: a letterbox window in a square
// hood. Wider than it is tall on purpose — that shape is the whole of how you
// tell one from the reflex at a glance.
const HOLO = {
  windowW: 62,
  windowH: 42,
  frame: 3,
  wall: 3.5,
  roof: 6,
  floor: 5,
  glassAt: -24,
  body: 58,        // how far the hood runs back from the glass
  ring: 0.30,      // the reticle ring, as a fraction of the window's half-height
  ringLine: 0.045, // ...and how thick that ring is, in the same fraction
  dot: 0.05,
};

// The prism: short, fat and closed, with the eyepiece flared out at the back.
const PRISM = {
  radius: 25,
  wall: 2.4,
  front: -46,
  back: 46,
  ocular: 29,
  ocularLen: 16,
  ring: 2.6,
};

// ── The open reflex ────────────────────────────────────────────────────────
//
// The sight this game shipped with, drawn off the UTG in the reference photo,
// and the shape the rest of the catalogue is judged against. It is not a tube
// and it does not look like one: what you get behind it is a frame with air in
// it, four straight edges to level the weapon by, and a dot floating on the
// glass.
//
// A real one of these is 33 mm across the glass; this is drawn a half larger,
// because a viewmodel optic at true size is a postage stamp held at arm's
// length. Every figure below was set against the photograph over several
// rounds, and this whole builder is here character for character as it was
// written in weapons.js — moving a sight that is already right is how a
// refactor turns into a regression.
const REFLEX = {
  windowW: 52,     // the opening you look through
  windowH: 40,
  frame: 3.5,      // the bezel around it
  hood: 44,        // how far the roof runs back over the emitter
  wall: 4,         // the cheeks either side of the glass
  roof: 5,
  baseW: 26,       // the mount clamped to the rail
  baseH: 9,
  baseFront: -34,
  baseBack: 46,
  glassAt: -26,    // where the window sits along the sight
};

function buildReflex(group, def, z, scale, h) {
  const { MM, MATS } = h;
  const y = opticHeightFor(def, 'reflex') * MM;
  const R = REFLEX;
  const half = { w: (R.windowW / 2) * MM, h: (R.windowH / 2) * MM };
  const frame = R.frame * MM;
  const block = h.block(group, def, z, y);

  // The bezel: four bars round the opening, which is what makes this a window
  // rather than a hole. Heavier across the top than down the sides, the way
  // the casting in the photograph is.
  const bezelDepth = 9 * MM;
  const top = frame * 1.4;
  const outerW = half.w + frame;
  block(frame, half.h * 2 + frame + top, bezelDepth, -(half.w + frame / 2), 0, R.glassAt);
  block(frame, half.h * 2 + frame + top, bezelDepth, half.w + frame / 2, 0, R.glassAt);
  block(outerW * 2, top, bezelDepth, 0, half.h + top / 2, R.glassAt);
  block(outerW * 2, frame, bezelDepth, 0, -(half.h + frame / 2), R.glassAt);

  // The hood over the top, running back from the window to shade the glass,
  // and the two cheeks that carry it. The back half is open, which is what an
  // open reflex looks like from the side.
  block(outerW * 2, R.roof * MM, R.hood * MM,
    0, half.h + top + (R.roof / 2) * MM, R.glassAt + R.hood / 2);
  const cheekLen = R.hood * 0.55;
  for (const side of [-1, 1]) {
    block(R.wall * MM, half.h * 1.5, cheekLen * MM,
      side * (half.w + frame / 2), half.h * 0.25, R.glassAt + cheekLen / 2);
  }

  // The emitter, tucked under the rear of the hood where it belongs, and the
  // mount under all of it with the thumbscrew that clamps it to the rail.
  block(18 * MM, 12 * MM, 16 * MM, 0, -half.h + 6 * MM, R.glassAt + R.hood * 0.8);
  const baseLen = (R.baseBack - R.baseFront) * MM;
  block(R.baseW * MM, R.baseH * MM, baseLen,
    0, -half.h - frame - (R.baseH / 2) * MM, (R.baseFront + R.baseBack) / 2);

  const screw = new THREE.Mesh(
    new THREE.CylinderGeometry(6 * MM, 6 * MM, 7 * MM, 10),
    MATS.steel,
  );
  screw.rotation.z = Math.PI / 2;
  screw.position.set(
    (R.baseW / 2 + 4) * MM,
    y - half.h - frame - (R.baseH / 2) * MM,
    z(def.sight[0] + R.baseBack - 14),
  );
  group.add(screw);

  // The glass, and the ring of light where it meets the frame. Without the
  // second one a window reads as a hole cut in a black block.
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(half.w * 2, half.h * 2),
    MATS.lens,
  );
  glass.position.set(0, y, z(def.sight[0] + R.glassAt));
  group.add(glass);

  // A thin bright edge, drawn as four slivers round the opening rather than as
  // a plane, so the middle of the window stays clear.
  const lip = 0.7 * MM;
  const edge = (w, hh, dx, dy) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), MATS.edge);
    m.position.set(dx, y + dy, z(def.sight[0] + R.glassAt) + 0.0004);
    group.add(m);
  };
  edge(half.w * 2, lip, 0, half.h - lip / 2);
  edge(half.w * 2, lip, 0, -(half.h - lip / 2));
  edge(lip, half.h * 2, -(half.w - lip / 2), 0);
  edge(lip, half.h * 2, half.w - lip / 2, 0);

  // And the mark: one dot, on the glass where a reflex sight projects it, and
  // sized by that glass rather than by the screen — which is what a mark
  // quoted in minutes of angle actually is. A soft halo under it so it reads
  // as light and not as a red pixel. It sits on the middle of the screen
  // either way: the aiming reference and the glass are both on the axis the
  // camera looks down.
  const on = z(def.sight[0] + R.glassAt);
  const dot = half.h * DOT_OF_GLASS;
  const halo = new THREE.Mesh(new THREE.CircleGeometry(dot * 2.6, 16), MATS.glow);
  halo.position.set(0, y, on + 0.0006);
  group.add(halo);
  const core = new THREE.Mesh(new THREE.CircleGeometry(dot, 16), MATS.dot);
  core.position.set(0, y, on + 0.001);
  group.add(core);
}

// ── The scope ──────────────────────────────────────────────────────────────
//
// The magnified glass on the two marksman rifles, and the one sight that builds
// no body of its own: the drawing already carries the tube, as `sight` parts
// that are skipped for everything else. What a scope looks like from behind is
// not a cross floating in a room, it is a circle of picture with black all
// round it, so the sight picture the player reads is drawn over the screen
// instead — see `#scope` in index.html and `syncScope` in view.js. What is
// built here is what somebody standing beside you would see.
function buildScope(group, def, z, scale, h) {
  const { MM, MATS } = h;
  const tube = def.parts.find((p) => p[0] === 'sight');
  if (!tube) return;
  const inner = tube[3] * MM * 0.92;
  const y = def.sight[1] * MM;
  const at = z(def.sight[0]);
  const s = 1 / scale;

  // Glass across the front of the tube, in front of the mark.
  const lens = new THREE.Mesh(new THREE.CircleGeometry(inner, 24), MATS.lens);
  lens.position.set(0, y, z(tube[1] + 10));
  group.add(lens);

  // ...and the ring of light where the glass meets the housing. It is the one
  // detail that separates "an optic" from "a hole in a black block".
  const rim = new THREE.Mesh(new THREE.RingGeometry(inner * 0.88, inner, 28), MATS.rim);
  rim.position.set(0, y, z(tube[1] + 12));
  group.add(rim);

  // Inside the tube: a plain fine cross, because at this size the tube is a
  // few pixels across and the sight picture the player actually reads is the
  // full-screen one.
  const bar = (w, hh, x, dy) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, 0.0006), MATS.etch);
    m.position.set(x, y + dy, at);
    group.add(m);
  };
  const reach = inner * 0.95;
  const gap = inner * 0.16;
  bar(reach - gap, ETCH_LINE * s, -(gap + (reach - gap) / 2), 0);
  bar(reach - gap, ETCH_LINE * s, gap + (reach - gap) / 2, 0);
  bar(ETCH_LINE * s, reach - gap, 0, gap + (reach - gap) / 2);
  bar(ETCH_LINE * s, reach - gap, 0, -(gap + (reach - gap) / 2));
  const core = new THREE.Mesh(new THREE.CircleGeometry(SCOPE_DOT * s * 0.5, 10), MATS.dot);
  core.position.set(0, y, at + 0.0004);
  group.add(core);
}

// The thumbscrew that holds a unit to the rail. Every sight here is meant to
// come off, and one visible fastener on the right-hand side is what says so.
function clampScrew(group, MATS, MM, y, at) {
  const screw = new THREE.Mesh(
    new THREE.CylinderGeometry(6 * MM, 6 * MM, 7 * MM, 10),
    MATS.steel,
  );
  screw.rotation.z = Math.PI / 2;
  screw.position.set(17 * MM, y, at);
  group.add(screw);
}
