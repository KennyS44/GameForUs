// Draws a floor plan of each storey straight from the map data.
//
//   node tools/floorplan.mjs
//
// The point is that nothing here is hand-drawn: walls, doorways, door swings,
// stair treads and spawns are read from the same file the game loads, so the
// plan cannot quietly disagree with the level. Redraw it after every change to
// the map and the picture stays true.
//
// Writes docs/plan-ground.svg and docs/plan-upper.svg.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildWorld, doorFrame, localToWorld } from '../src/sim/world.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Which map to draw, and what to call the files. Defaults to the live one.
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const mapPath = arg('map', '../src/maps/apartment.js');
const outName = arg('out', 'plan');
const module = await import(mapPath.startsWith('.') ? mapPath : `../${mapPath}`);
const APARTMENT = Object.values(module).find((v) => v && v.geometry && v.rooms);
const world = buildWorld(APARTMENT);

const F2 = APARTMENT.upperFloorY ?? 3.3;
const SCALE = 26; // pixels per metre
const PAD = { left: 64, top: 92, right: 24, bottom: 76 };

// Plan extents: the flat plus the landing outside the front door.
const X0 = -16.6;
const X1 = 16.6;
const Z0 = -18.6;
const Z1 = 10.1;

const px = (x) => PAD.left + (x - X0) * SCALE;
const pz = (z) => PAD.top + (z - Z0) * SCALE;
const W = PAD.left + (X1 - X0) * SCALE + PAD.right;
const H = PAD.top + (Z1 - Z0) * SCALE + PAD.bottom;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const n = (v) => Math.round(v * 10) / 10;

// A box belongs to a storey if it occupies the air a player stands in there.
function onFloor(b, floor) {
  const lo = floor === 0 ? 0.2 : F2 + 0.2;
  const hi = floor === 0 ? 2.6 : F2 + 2.6;
  return b.max.y > lo && b.min.y < hi;
}

function grid() {
  const out = [];
  for (let x = Math.ceil(X0 / 2) * 2; x <= X1; x += 2) {
    out.push(`<line x1="${n(px(x))}" y1="${n(pz(Z0))}" x2="${n(px(x))}" y2="${n(pz(Z1))}" class="grid"/>`);
    if (x % 4 === 0) {
      out.push(`<text x="${n(px(x))}" y="${n(pz(Z0)) - 8}" class="tick">${x}</text>`);
    }
  }
  for (let z = Math.ceil(Z0 / 2) * 2; z <= Z1; z += 2) {
    out.push(`<line x1="${n(px(X0))}" y1="${n(pz(z))}" x2="${n(px(X1))}" y2="${n(pz(z))}" class="grid"/>`);
    if (z % 4 === 0) {
      out.push(`<text x="${n(px(X0)) - 10}" y="${n(pz(z)) + 4}" class="tick" text-anchor="end">${z}</text>`);
    }
  }
  return out.join('\n');
}

function roomShapes(floor) {
  const out = [];
  for (const r of APARTMENT.rooms) {
    if (r.floor !== floor) continue;
    const w = (r.max.x - r.min.x) * SCALE;
    const h = (r.max.z - r.min.z) * SCALE;
    const cls = r.hole ? 'void' : r.shaft ? 'shaft' : r.open ? 'open' : r.outside ? 'outside' : 'room';
    out.push(`<rect x="${n(px(r.min.x))}" y="${n(pz(r.min.z))}" width="${n(w)}" height="${n(h)}" class="${cls}"/>`);
  }
  return out.join('\n');
}

function roomLabels(floor) {
  const out = [];
  for (const r of APARTMENT.rooms) {
    if (r.floor !== floor) continue;
    const cx = px((r.min.x + r.max.x) / 2);
    const cy = pz((r.min.z + r.max.z) / 2);
    const size = `${n(r.max.x - r.min.x)} × ${n(r.max.z - r.min.z)} м · ${r.id}`;
    if (r.shaft) {
      // Above the flight, not across it: the arrow lives in the middle.
      out.push(`<text x="${n(cx)}" y="${n(pz(r.min.z)) + 18}" class="shaft-label">${esc(r.name)}</text>`);
      out.push(`<text x="${n(cx)}" y="${n(pz(r.max.z)) - 8}" class="room-size">${r.id}</text>`);
      continue;
    }
    out.push(`<text x="${n(cx)}" y="${n(cy) - 4}" class="room-name">${esc(r.name)}</text>`);
    out.push(`<text x="${n(cx)}" y="${n(cy) + 13}" class="room-size">${size}</text>`);
  }
  return out.join('\n');
}

function walls(floor) {
  return world.boxes
    .filter((b) => b.axis && onFloor(b, floor))
    .map((b) => {
      const w = (b.max.x - b.min.x) * SCALE;
      const h = (b.max.z - b.min.z) * SCALE;
      // A lintel is wall above a doorway: on a plan that is a hole, not a wall.
      const lintel = b.min.y > (floor === 0 ? 1.5 : F2 + 1.5);
      if (lintel) return '';
      const low = b.tag === 'parapet' || b.tag === 'railing';
      return `<rect x="${n(px(b.min.x))}" y="${n(pz(b.min.z))}" width="${n(w)}" height="${n(h)}" class="wall ${b.material.name}${low ? ' low' : ''}"/>`;
    })
    .join('\n');
}

// Each door as it is actually hung: the leaf at its open angle plus the arc it
// sweeps, drawn from the same hinge and swing the simulation uses.
function doors(floor) {
  const out = [];
  for (const d of world.doors) {
    if ((d.floorY > 0 ? 1 : 0) !== floor) continue;
    const shut = doorFrame(d, 0);
    const open = doorFrame(d, 1);
    const tipShut = localToWorld(shut, { x: d.width, y: 0, z: 0 });
    const tipOpen = localToWorld(open, { x: d.width, y: 0, z: 0 });
    const r = d.width * SCALE;
    const sweep = d.swingSign > 0 ? 1 : 0;

    out.push(`<path d="M ${n(px(d.hinge.x))} ${n(pz(d.hinge.z))} L ${n(px(tipShut.x))} ${n(pz(tipShut.z))}" class="door-shut"/>`);
    out.push(`<path d="M ${n(px(tipShut.x))} ${n(pz(tipShut.z))} A ${n(r)} ${n(r)} 0 0 ${sweep} ${n(px(tipOpen.x))} ${n(pz(tipOpen.z))}" class="door-arc"/>`);
    out.push(`<path d="M ${n(px(d.hinge.x))} ${n(pz(d.hinge.z))} L ${n(px(tipOpen.x))} ${n(pz(tipOpen.z))}" class="door-open"/>`);
    out.push(`<circle cx="${n(px(d.hinge.x))}" cy="${n(pz(d.hinge.z))}" r="3" class="hinge"/>`);
    const forced = d.startsForced;
    if (forced) {
      out.push(`<text x="${n(px(d.pos.x))}" y="${n(pz(d.pos.z)) + 16}" class="note">выбита заранее</text>`);
    }

    // Sit the label clear of the swing, on the other side of the wall.
    const away = -Math.sign(tipOpen[d.axis === 'x' ? 'z' : 'x'] - d.pos[d.axis === 'x' ? 'z' : 'x']) || 1;
    const lx = px(d.pos.x + (d.axis === 'x' ? 0 : away * 0.75));
    const ly = pz(d.pos.z + (d.axis === 'x' ? away * 0.75 : 0)) + 4;
    const spec = APARTMENT.doors.find((x) => x.id === d.id);
    if (spec?.pair === 'double') {
      // Two leaves in one opening get one label, on the left-hand leaf only.
      if (d.id.endsWith('-L')) {
        out.push(`<text x="${n(px(d.pos.x + 0.5))}" y="${n(ly)}" class="door-id">${esc(d.id.replace(/-L$/, ''))} (двойная)</text>`);
      }
    } else {
      out.push(`<text x="${n(lx)}" y="${n(ly)}" class="door-id">${esc(d.id)}</text>`);
    }
  }
  return out.join('\n');
}

// Stair treads, read back out of the geometry, with an arrow pointing up.
// Flights are found by their shape rather than by which room they sit in, so
// an open stair standing in a court is drawn like any other.
function stairs(floor) {
  if (floor !== 0) return ''; // both flights start on the ground floor
  const treads = world.boxes.filter((b) =>
    !b.axis && !b.tag && b.material.name === 'floor' && b.min.y === 0 &&
    b.max.y > 0.1 && b.max.y <= F2 + 0.01 &&
    (b.max.x - b.min.x) < 3.5 && (b.max.z - b.min.z) < 1.2);
  if (!treads.length) return '';

  // Group them into flights: treads of one flight share their x range.
  const groups = new Map();
  for (const t of treads) {
    const key = `${n(t.min.x)}:${n(t.max.x)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const out = [];
  for (const mine of groups.values()) {
    for (const t of mine) {
      out.push(`<rect x="${n(px(t.min.x))}" y="${n(pz(t.min.z))}" width="${n((t.max.x - t.min.x) * SCALE)}" height="${n((t.max.z - t.min.z) * SCALE)}" class="tread"/>`);
    }
    const low = mine.reduce((a, b) => (a.max.y < b.max.y ? a : b));
    const high = mine.reduce((a, b) => (a.max.y > b.max.y ? a : b));
    const cx = px((mine[0].min.x + mine[0].max.x) / 2);
    const z1 = pz((low.min.z + low.max.z) / 2);
    const z2 = pz((high.min.z + high.max.z) / 2);
    out.push(`<path d="M ${n(cx)} ${n(z1)} L ${n(cx)} ${n(z2)}" class="up-arrow" marker-end="url(#arrow)"/>`);
    out.push(`<text x="${n(cx)}" y="${n((z1 + z2) / 2) - 6}" class="up-label" transform="rotate(-90 ${n(cx)} ${n((z1 + z2) / 2) - 6})">вверх</text>`);
  }
  return out.join('\n');
}

// Things that are not walls but change how a room plays: the bar-height
// barrier, the column, the wardrobe across a doorway.
function blockers(floor) {
  const out = [];
  for (const b of world.boxes) {
    if (!b.tag || b.axis) continue;
    if (!['barrier', 'column', 'blocked', 'rubble', 'furniture'].includes(b.tag)) continue;
    const onThis = floor === 0 ? b.min.y < 2.6 : b.min.y >= F2 - 0.01;
    if (!onThis) continue;
    // A piece standing at an angle is drawn at that angle. The sheet turns
    // the other way round from the world — down the page is +z — so the sign
    // of the angle flips on its way onto the paper.
    const spin = b.yaw
      ? ` transform="rotate(${n((-b.yaw * 180) / Math.PI)} ${n(px((b.min.x + b.max.x) / 2))} ${n(pz((b.min.z + b.max.z) / 2))})"`
      : '';
    out.push(`<rect x="${n(px(b.min.x))}" y="${n(pz(b.min.z))}" width="${n((b.max.x - b.min.x) * SCALE)}" height="${n((b.max.z - b.min.z) * SCALE)}" class="blocker ${b.tag}"${spin}/>`);
    if (b.note) {
      out.push(`<text x="${n(px((b.min.x + b.max.x) / 2))}" y="${n(pz(b.max.z)) + 14}" class="note">${esc(b.note)}</text>`);
    }
  }
  return out.join('\n');
}

// A hole in a floor is drawn on the storey it is cut into, and marked on the
// one below as the place you land.
function holes(floor) {
  const out = [];
  for (const h of APARTMENT.holes ?? []) {
    const here = h.floor === floor;
    const below = h.floor === floor + 1;
    if (!here && !below) continue;
    out.push(`<circle cx="${n(px(h.x))}" cy="${n(pz(h.z))}" r="${n(h.r * SCALE)}" class="hole ${here ? 'cut' : 'under'}"/>`);
    out.push(`<text x="${n(px(h.x))}" y="${n(pz(h.z + h.r)) + 15}" class="note">${esc(here ? h.note : 'сюда падают из кладовой сверху')}</text>`);
  }
  return out.join('\n');
}

// The consumer unit. Not a way through and not a room — but it is the one
// thing on the plan that changes every other thing on it, so it is marked.
function switches(floor) {
  return (APARTMENT.switches ?? [])
    .filter((s) => (s.floor ?? 0) === floor)
    .map((s) => {
      const x = px(s.pos.x);
      const y = pz(s.pos.z);
      // Above the marker: below it is the wall the doorway labels sit under.
      return `<rect x="${n(x - 8)}" y="${n(y - 8)}" width="16" height="16" class="switch"/>
<text x="${n(x)}" y="${n(y) - 14}" class="note">${esc(s.name)}</text>`;
    })
    .join('\n');
}

// Ways through a wall that are not doors: a punched hole, an open passage.
function openings(floor) {
  return (APARTMENT.openings ?? [])
    .filter((o) => (o.floor ?? 0) === floor)
    .map((o) => {
      const horizontal = o.w >= (o.h ?? 0);
      const half = o.w / 2;
      const x1 = px(o.x - (horizontal ? half : 0.2));
      const x2 = px(o.x + (horizontal ? half : 0.2));
      const z1 = pz(o.z - (horizontal ? 0.2 : half));
      const z2 = pz(o.z + (horizontal ? 0.2 : half));
      return `<rect x="${n(Math.min(x1, x2))}" y="${n(Math.min(z1, z2))}" width="${n(Math.abs(x2 - x1))}" height="${n(Math.abs(z2 - z1))}" class="opening"/>
<text x="${n(px(o.x))}" y="${n(pz(o.z)) + (horizontal ? 20 : 0)}" class="note">${esc(o.note)}</text>`;
    })
    .join('\n');
}

function spawns(floor) {
  const out = [];
  for (const [team, list] of Object.entries(APARTMENT.spawns)) {
    for (const s of list) {
      const sFloor = (s.y ?? 0) > 0.1 ? 1 : 0;
      if (sFloor !== floor) continue;
      out.push(`<circle cx="${n(px(s.x))}" cy="${n(pz(s.z))}" r="5" class="spawn ${team}"/>`);
    }
  }
  return out.join('\n');
}

const STYLE = `
  .bg { fill: #f7f5f1; }
  .grid { stroke: #dcd8d0; stroke-width: 1; }
  .tick { fill: #8d8880; font: 11px ui-monospace, monospace; text-anchor: middle; }
  /* Every label is drawn with the page colour behind its own strokes, so a
     door id that lands on a wall or a room name is still readable. */
  text { paint-order: stroke; stroke: #f7f5f1; stroke-width: 3px; stroke-linejoin: round; }
  .room { fill: #ffffff; stroke: #e4e0d8; stroke-width: 1; }
  .open { fill: #eef4ec; stroke: #cadbc8; stroke-width: 1; }
  .void { fill: #e2e6ec; stroke: #b6bcc6; stroke-width: 1.5; stroke-dasharray: 6 4; }
  .wall.low { fill: #a09a90; }
  .wall.glass.low { fill: #7fa8bd; }
  .blocker { fill: #d8c9a8; stroke: #9b8a63; stroke-width: 1; }
  .blocker.blocked { fill: #d9b8a0; stroke: #a5744f; }
  .blocker.rubble { fill: #b9b2a6; stroke: #6f6a61; stroke-width: 1.5; }
  .blocker.furniture { fill: #e8e0d2; stroke: #b3a892; stroke-width: 1; }
  .hole { fill: none; stroke: #2f6f4f; stroke-width: 2.5; stroke-dasharray: 5 4; }
  .opening { fill: #d7e6dc; stroke: #2f6f4f; stroke-width: 1.5; stroke-dasharray: 4 3; }
  .switch { fill: #f2d24b; stroke: #7a5f05; stroke-width: 2; }
  .hole.under { stroke: #7fa39a; stroke-width: 1.5; }
  .note { font: 10px system-ui, sans-serif; fill: #4d6a5c; text-anchor: middle; }
  .shaft { fill: #eceef3; stroke: #c9cdd6; stroke-width: 1; }
  .outside { fill: #f0ece4; stroke: #ddd8ce; stroke-dasharray: 4 3; }
  .wall { fill: #2f3136; }
  .wall.drywall { fill: #7c766c; }
  .wall.glass { fill: #7fa8bd; }
  .room-name { font: 600 13px system-ui, sans-serif; fill: #22242a; text-anchor: middle; }
  .room-size { font: 11px ui-monospace, monospace; fill: #8d8880; text-anchor: middle; }
  .shaft-label { font: 600 12px system-ui, sans-serif; fill: #4a5568; text-anchor: middle; }
  .door-shut { stroke: #c8531f; stroke-width: 3; fill: none; }
  .door-open { stroke: #c8531f; stroke-width: 3; fill: none; opacity: 0.35; }
  .door-arc { stroke: #c8531f; stroke-width: 1; fill: none; stroke-dasharray: 3 3; opacity: 0.7; }
  .hinge { fill: #c8531f; }
  .door-id { font: 9px ui-monospace, monospace; fill: #a8511f; text-anchor: middle; }
  .tread { fill: #ded5c6; stroke: #b9ac97; stroke-width: 0.8; }
  .up-arrow { stroke: #4a5568; stroke-width: 1.5; fill: none; }
  .up-label { font: 10px system-ui, sans-serif; fill: #4a5568; text-anchor: middle; }
  .spawn { stroke: #ffffff; stroke-width: 1.5; }
  .spawn.attackers { fill: #2e6fbf; }
  .spawn.defenders { fill: #c2452f; }
  .title { font: 600 22px system-ui, sans-serif; fill: #22242a; }
  .subtitle { font: 13px system-ui, sans-serif; fill: #6b6660; }
  .legend { font: 12px system-ui, sans-serif; fill: #3d3f45; }
`;

function plan(floor, title, subtitle) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}" height="${n(H)}" viewBox="0 0 ${n(W)} ${n(H)}">
<style>${STYLE}</style>
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="#4a5568"/>
  </marker>
</defs>
<rect class="bg" width="${n(W)}" height="${n(H)}"/>
<text x="${PAD.left}" y="34" class="title">${esc(title)}</text>
<text x="${PAD.left}" y="54" class="subtitle">${esc(subtitle)}</text>
<text x="${PAD.left}" y="${n(H) - 42}" class="legend">Сетка 2 м. Оси в метрах: +X вправо, +Z вниз. Под названием комнаты — размер и её id в коде.</text>
<text x="${PAD.left}" y="${n(H) - 24}" class="legend">Оранжевым — двери: сплошная створка закрыта, пунктир — куда открывается, точка — петля. Синие точки — спавн штурма, красные — обороны.</text>
<text x="${PAD.left}" y="${n(H) - 6}" class="legend">Стены: тёмные — бетон (не простреливается), серые — гипсокартон (простреливается), голубые — стекло (бьётся с двух попаданий).</text>
${grid()}
${roomShapes(floor)}
${stairs(floor)}
${walls(floor)}
${blockers(floor)}
${openings(floor)}
${switches(floor)}
${holes(floor)}
${doors(floor)}
${spawns(floor)}
${roomLabels(floor)}
</svg>
`;
}

mkdirSync(join(ROOT, 'docs'), { recursive: true });
const tag = APARTMENT.draft ? ' — ПРОЕКТ, в игру не внесён' : '';
const ground = plan(0, `${APARTMENT.name}: первый этаж (y = 0)${tag}`,
  'Вход снизу по плану: площадка за входной дверью — спавн штурма. Бежевым — мебель.');
const upper = plan(1, `${APARTMENT.name}: второй этаж (y = ${F2})${tag}`,
  'Зелёным — то, что открыто небу; штриховкой — проём вниз; бежевым — мебель. Жёлтым — электрощит.');
writeFileSync(join(ROOT, `docs/${outName}-ground.svg`), ground);
writeFileSync(join(ROOT, `docs/${outName}-upper.svg`), upper);
console.log(`docs/${outName}-{ground,upper}.svg — ${n(W)} × ${n(H)} px, ${APARTMENT.rooms.length} rooms, ${world.doors.length} doors`);
