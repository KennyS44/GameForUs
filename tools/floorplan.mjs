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
import { APARTMENT } from '../src/maps/apartment.js';
import { buildWorld, doorFrame, localToWorld } from '../src/sim/world.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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
    const cls = r.shaft ? 'shaft' : r.outside ? 'outside' : 'room';
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
      return `<rect x="${n(px(b.min.x))}" y="${n(pz(b.min.z))}" width="${n(w)}" height="${n(h)}" class="wall ${b.material.name}"/>`;
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

    // Sit the label clear of the swing, on the other side of the wall.
    const away = -Math.sign(tipOpen[d.axis === 'x' ? 'z' : 'x'] - d.pos[d.axis === 'x' ? 'z' : 'x']) || 1;
    const lx = px(d.pos.x + (d.axis === 'x' ? 0 : away * 0.75));
    const ly = pz(d.pos.z + (d.axis === 'x' ? away * 0.75 : 0)) + 4;
    out.push(`<text x="${n(lx)}" y="${n(ly)}" class="door-id">${esc(d.id)}</text>`);
  }
  return out.join('\n');
}

// Stair treads, read back out of the geometry, with an arrow pointing up.
function stairs(floor) {
  const treads = world.boxes.filter((b) =>
    !b.axis && b.material.name === 'floor' && b.min.y === 0 && b.max.y > 0.1 && b.max.y <= F2 + 0.01);
  const out = [];
  const shafts = APARTMENT.rooms.filter((r) => r.shaft && r.floor === floor);
  for (const s of shafts) {
    const mine = treads.filter((t) =>
      t.min.x >= s.min.x - 0.5 && t.max.x <= s.max.x + 0.5 && t.min.z >= s.min.z - 0.5 && t.max.z <= s.max.z + 0.5);
    if (!mine.length) continue;
    for (const t of mine) {
      out.push(`<rect x="${n(px(t.min.x))}" y="${n(pz(t.min.z))}" width="${n((t.max.x - t.min.x) * SCALE)}" height="${n((t.max.z - t.min.z) * SCALE)}" class="tread"/>`);
    }
    // Which way is up: from the lowest tread to the highest.
    const low = mine.reduce((a, b) => (a.max.y < b.max.y ? a : b));
    const high = mine.reduce((a, b) => (a.max.y > b.max.y ? a : b));
    const cx = px((s.min.x + s.max.x) / 2);
    const z1 = pz((low.min.z + low.max.z) / 2);
    const z2 = pz((high.min.z + high.max.z) / 2);
    out.push(`<path d="M ${n(cx)} ${n(z1)} L ${n(cx)} ${n(z2)}" class="up-arrow" marker-end="url(#arrow)"/>`);
    out.push(`<text x="${n(cx)}" y="${n((z1 + z2) / 2) - 6}" class="up-label" transform="rotate(-90 ${n(cx)} ${n((z1 + z2) / 2) - 6})">вверх</text>`);
  }
  return out.join('\n');
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
${doors(floor)}
${spawns(floor)}
${roomLabels(floor)}
</svg>
`;
}

mkdirSync(join(ROOT, 'docs'), { recursive: true });
const ground = plan(0, 'Пентхаус — первый этаж (y = 0)',
  'Вход снизу по плану: площадка за входной дверью — спавн штурма. Мебели нет.');
const upper = plan(1, `Пентхаус — второй этаж (y = ${F2})`,
  'Связь между этажами — только две лестницы по краям. Мебели нет.');
writeFileSync(join(ROOT, 'docs/plan-ground.svg'), ground);
writeFileSync(join(ROOT, 'docs/plan-upper.svg'), upper);
console.log(`docs/plan-ground.svg and docs/plan-upper.svg — ${n(W)} × ${n(H)} px, ${APARTMENT.rooms.length} rooms, ${world.doors.length} doors`);
