// The projection the floor plans are drawn with — one copy, two readers.
//
// `tools/floorplan.mjs` draws the sheets; `src/main.js` puts a mark for each
// team-mate on top of them during the planning screen. A mark lands in the
// right room only if both agree to the pixel about where the metre grid sits,
// and until now they agreed by hand: the tool worked the sheet size out from
// its own padding, and the game carried the answer — `w: 951.2, h: 914.2` —
// copied in as a literal under a comment asking the next person to keep it in
// step.
//
// It was in step. That is not the same as being safe: moving an outside wall
// changes the map's bounds, which changes the sheet, and nothing would have
// said so. The marks would simply have drifted into the neighbouring room.
//
// So it is worked out once, from the map's own bounds, and both sides read it.

import { APARTMENT } from './apartment.js?v=9dde13b4';

// Enough air around the flat that a wall on the boundary still has paper
// outside it.
const MARGIN = 0.4;

const SCALE = 26; // pixels per metre
// Room for the title block above and the legend below.
const PAD = { left: 64, top: 92, right: 24, bottom: 76 };

// The edge of the paper, in whole tenths of a metre.
//
// Rounded rather than taken raw, because -16.2 - 0.4 is -16.599999999999998 in
// binary and that fraction of a micron travels all the way into the drawing:
// every coordinate on the sheet shifts by a tenth of a pixel, which is enough
// to change the rounded output and make a redraw look like a change to the map.
const edge = (v) => Math.round(v * 10) / 10;

// Any map, because the drawing tool can be pointed at one with --map.
export function planFor(map) {
  const x0 = edge(map.bounds.min.x - MARGIN);
  const x1 = edge(map.bounds.max.x + MARGIN);
  const z0 = edge(map.bounds.min.z - MARGIN);
  const z1 = edge(map.bounds.max.z + MARGIN);
  return {
    scale: SCALE,
    left: PAD.left,
    top: PAD.top,
    right: PAD.right,
    bottom: PAD.bottom,
    x0,
    x1,
    z0,
    z1,
    // The whole sheet, in pixels.
    w: PAD.left + (x1 - x0) * SCALE + PAD.right,
    h: PAD.top + (z1 - z0) * SCALE + PAD.bottom,
    // A point in the flat, in pixels on the sheet.
    px: (x) => PAD.left + (x - x0) * SCALE,
    pz: (z) => PAD.top + (z - z0) * SCALE,
  };
}

// The live one, which is what the game draws its marks on.
export const PLAN = planFor(APARTMENT);

// Above this and a man is on the second floor, so his mark belongs on the
// other sheet.
export const UPPER_FROM = 1.65;
