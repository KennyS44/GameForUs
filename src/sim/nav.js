// Where a bot can put its feet.
//
// The flat is a pile of boxes. Nothing in the map data says "room", "doorway"
// or "route", and a bot was never given a way to find out — which is the real
// reason bots used to hold whichever room they spawned in. Their only movement
// order was "walk the way you are looking", and walking the way you are
// looking into a wall is still walking into a wall.
//
// So: once, at load, sample the whole building on a grid, work out every place
// a person could stand, and join up the ones you can walk between. After that
// "get to the far side of the flat" is a list of steps rather than a wish.
//
// Pure like the rest of the simulation: boxes in, numbers out. No engine, no
// clock, no Math.random.

import { PLAYER } from './constants.js?v=9dde13b4';
import { columnHitsBox } from './math.js?v=9dde13b4';

// Fine enough that a 1 m doorway is two or three cells wide, coarse enough
// that the whole building is a few thousand of them.
const CELL = 0.4;
// A standing man plus a little air. Anything lower than this over a spot means
// you cannot stand there — which is exactly what makes door lintels passable
// and the underside of a staircase not.
const HEAD = PLAYER.heightStand + 0.05;
// Whatever you can step over is not an obstacle, and two surfaces this close
// together are one place to stand rather than two.
const STEP = PLAYER.stepHeight;
// Height difference two neighbouring cells may have and still be walkable
// between. A stair tread rises 0.21 m over 0.30 m of tread, so at this cell
// size a diagonal step up a flight is about 0.28 m — under the limit, which is
// what keeps the staircase a route instead of a cliff.
const LINK = 0.45;

const R = PLAYER.radius;

// The eight ways out of a cell. Straights first: a diagonal is only allowed
// when both of the straights beside it are open, so nobody clips a corner.
const NEIGHBOURS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export function buildNav(world) {
  const bounds = world.bounds;
  const minX = bounds.min.x;
  const minZ = bounds.min.z;
  const cols = Math.ceil((bounds.max.x - minX) / CELL);
  const rows = Math.ceil((bounds.max.z - minZ) / CELL);
  // No standing on the roof: there has to be a building's worth of air over a
  // spot before it counts as a floor.
  const ceiling = bounds.max.y - HEAD;

  const boxes = world.boxes;
  const nx = [];
  const ny = [];
  const nz = [];
  // Nodes are generated column by column, so a column's nodes are always a
  // contiguous run and one index array is enough to find them again.
  const colStart = new Int32Array(cols * rows + 1);

  const tops = [];
  const near = [];
  const row = [];
  for (let iz = 0; iz < rows; iz++) {
    const z = minZ + (iz + 0.5) * CELL;
    // Whittle the building down to the strip this row of cells runs through,
    // once per row rather than once per cell. Most of a flat is nowhere near
    // most of a flat.
    row.length = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      // A box turned about its centre covers more ground than its own numbers
      // say, so the cheap passes use the bounds it actually occupies.
      const bb = b.aabb ?? b;
      if (bb.min.z < z + R && bb.max.z > z - R) row.push(b);
    }
    for (let ix = 0; ix < cols; ix++) {
      colStart[iz * cols + ix] = nx.length;
      const x = minX + (ix + 0.5) * CELL;

      // Everything this square of floor could touch. A man is a box 0.56 m
      // across for our purposes, so testing that square is what keeps him from
      // standing with a shoulder inside the wall.
      near.length = 0;
      tops.length = 0;
      for (let i = 0; i < row.length; i++) {
        const b = row[i];
        const bb = b.aabb ?? b;
        if (bb.min.x >= x + R || bb.max.x <= x - R) continue;
        // ...and then the real shape, for the ones standing at an angle: a
        // sofa turned forty degrees leaves the corners of its own bounds walkable.
        if (b.yaw && !columnHitsBox(b, x, z, R)) continue;
        near.push(b);
        if (b.max.y <= ceiling) tops.push(b.max.y);
      }
      if (!tops.length) continue;

      // Highest first, and drop anything within a step of what we already
      // kept: standing on the floor beside a kerb and standing on the kerb are
      // the same place.
      tops.sort((a, b) => b - a);
      let kept = Infinity;
      for (const top of tops) {
        if (top > kept - STEP) continue;
        kept = top;
        let clear = true;
        for (let i = 0; i < near.length; i++) {
          const b = near[i];
          if (b.max.y > top + STEP && b.min.y < top + HEAD) { clear = false; break; }
        }
        if (clear) { nx.push(x); ny.push(top); nz.push(z); }
      }
    }
  }
  colStart[cols * rows] = nx.length;

  const count = nx.length;
  const nav = {
    cell: CELL, cols, rows, minX, minZ, count,
    x: Float32Array.from(nx),
    y: Float32Array.from(ny),
    z: Float32Array.from(nz),
    colStart,
    // How many of the eight ways out are blocked. Zero is the middle of a
    // room; four or five is a corner you can put your back into.
    cover: new Uint8Array(count),
    // Nodes you can actually reach from a spawn. Cupboard shelves and the tops
    // of parapets pass every test above and are still nowhere to send a man.
    live: new Uint8Array(count),
    // A doorway is a place to walk through, never a place to stand and wait.
    doorway: new Uint8Array(count),
  };

  linkNodes(nav);
  markDoorways(nav, world);
  markReachable(nav, world);
  prepareSearch(nav);
  return nav;
}

// ── Joining the cells up ─────────────────────────────────────────────────

function linkNodes(nav) {
  const count = nav.count;
  // Two passes: count the edges to size the arrays, then fill them. Flat
  // arrays rather than an array of arrays because the search walks them
  // thousands of times a round.
  const start = new Int32Array(count + 1);
  const found = [];
  for (let n = 0; n < count; n++) found.push(neighboursOf(nav, n));
  let total = 0;
  for (let n = 0; n < count; n++) { start[n] = total; total += found[n].length; }
  start[count] = total;
  const list = new Int32Array(total);
  for (let n = 0, at = 0; n < count; n++) for (const m of found[n]) list[at++] = m;

  nav.edgeStart = start;
  nav.edges = list;
  for (let n = 0; n < count; n++) nav.cover[n] = 8 - Math.min(8, found[n].length);
}

function columnOf(nav, ix, iz) {
  if (ix < 0 || iz < 0 || ix >= nav.cols || iz >= nav.rows) return null;
  const c = iz * nav.cols + ix;
  return { from: nav.colStart[c], to: nav.colStart[c + 1] };
}

// The node in this column standing at about this height, or -1.
function nodeInColumn(nav, ix, iz, y, tol = LINK) {
  const col = columnOf(nav, ix, iz);
  if (!col) return -1;
  let best = -1;
  let bestD = tol;
  for (let n = col.from; n < col.to; n++) {
    const d = Math.abs(nav.y[n] - y);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

function neighboursOf(nav, n) {
  const ix = Math.floor((nav.x[n] - nav.minX) / nav.cell);
  const iz = Math.floor((nav.z[n] - nav.minZ) / nav.cell);
  const y = nav.y[n];
  const out = [];
  const straight = [];
  for (let k = 0; k < NEIGHBOURS.length; k++) {
    const [dx, dz] = NEIGHBOURS[k];
    const m = nodeInColumn(nav, ix + dx, iz + dz, y);
    if (m < 0) continue;
    if (k < 4) { straight.push(k); out.push(m); continue; }
    // A diagonal only counts when you could have gone round the corner the
    // long way: no squeezing between a door jamb and a wardrobe.
    const needA = dx > 0 ? 0 : 1;
    const needB = dz > 0 ? 2 : 3;
    if (straight.includes(needA) && straight.includes(needB)) out.push(m);
  }
  return out;
}

// ── Doorways and reachability ────────────────────────────────────────────

const DOOR_NEAR = 1.0;

function markDoorways(nav, world) {
  const reach = Math.ceil(DOOR_NEAR / nav.cell);
  for (const door of world.doors) {
    const y = door.floorY ?? 0;
    const ix0 = Math.floor((door.pos.x - nav.minX) / nav.cell);
    const iz0 = Math.floor((door.pos.z - nav.minZ) / nav.cell);
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const col = columnOf(nav, ix0 + dx, iz0 + dz);
        if (!col) continue;
        for (let n = col.from; n < col.to; n++) {
          if (Math.abs(nav.y[n] - y) > 1.5) continue;
          const ex = nav.x[n] - door.pos.x;
          const ez = nav.z[n] - door.pos.z;
          if (ex * ex + ez * ez < DOOR_NEAR * DOOR_NEAR) nav.doorway[n] = 1;
        }
      }
    }
  }
}

function markReachable(nav, world) {
  const spawns = [
    ...(world.map.spawns?.attackers ?? []),
    ...(world.map.spawns?.defenders ?? []),
  ];
  const queue = [];
  for (const s of spawns) {
    const n = nearestNode(nav, { x: s.x, y: s.y ?? 0, z: s.z }, 3, false);
    if (n >= 0 && !nav.live[n]) { nav.live[n] = 1; queue.push(n); }
  }
  for (let head = 0; head < queue.length; head++) {
    const n = queue[head];
    for (let e = nav.edgeStart[n]; e < nav.edgeStart[n + 1]; e++) {
      const m = nav.edges[e];
      if (nav.live[m]) continue;
      nav.live[m] = 1;
      queue.push(m);
    }
  }
  nav.liveList = Int32Array.from(queue);
  nav.liveCount = queue.length;
}

// ── Lookup ───────────────────────────────────────────────────────────────

// The node nearest this position, searching outward in rings. `liveOnly` is
// what callers want in play; the reachability pass itself cannot use it.
export function nearestNode(nav, pos, maxMetres = 4, liveOnly = true) {
  const ix0 = Math.floor((pos.x - nav.minX) / nav.cell);
  const iz0 = Math.floor((pos.z - nav.minZ) / nav.cell);
  const rings = Math.max(1, Math.ceil(maxMetres / nav.cell));
  let best = -1;
  let bestScore = Infinity;
  for (let r = 0; r <= rings; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        // Only the shell of each ring — the inside was done last time round.
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const col = columnOf(nav, ix0 + dx, iz0 + dz);
        if (!col) continue;
        for (let n = col.from; n < col.to; n++) {
          if (liveOnly && !nav.live[n]) continue;
          const ex = nav.x[n] - pos.x;
          const ez = nav.z[n] - pos.z;
          // Height counts for more than distance: the man on the floor below
          // is further away than the far corner of your own room.
          const score = ex * ex + ez * ez + Math.abs(nav.y[n] - pos.y) * 9;
          if (score < bestScore) { bestScore = score; best = n; }
        }
      }
    }
    // Found something and finished a ring wider than it: nothing further out
    // can beat it.
    if (best >= 0 && r * nav.cell > Math.sqrt(bestScore)) break;
  }
  return best;
}

export function nodePos(nav, n) {
  return { x: nav.x[n], y: nav.y[n], z: nav.z[n] };
}

// ── A* ───────────────────────────────────────────────────────────────────
//
// Scratch space lives on the nav and is reused: a round is a few hundred
// searches over a few thousand nodes, and allocating that each time is the
// kind of rubbish that shows up as a stutter.

function prepareSearch(nav) {
  const n = nav.count;
  nav.scratch = {
    g: new Float32Array(n),
    from: new Int32Array(n),
    stamp: new Int32Array(n),
    closed: new Int32Array(n),
    era: 0,
    heapNode: new Int32Array(n + 1),
    heapCost: new Float64Array(n + 1),
    size: 0,
  };
}

function heapPush(s, node, cost) {
  let i = ++s.size;
  s.heapNode[i] = node;
  s.heapCost[i] = cost;
  while (i > 1) {
    const p = i >> 1;
    if (s.heapCost[p] <= s.heapCost[i]) break;
    swapHeap(s, p, i);
    i = p;
  }
}

function heapPop(s) {
  const top = s.heapNode[1];
  s.heapNode[1] = s.heapNode[s.size];
  s.heapCost[1] = s.heapCost[s.size];
  s.size--;
  let i = 1;
  for (;;) {
    const l = i * 2;
    const r = l + 1;
    let m = i;
    if (l <= s.size && s.heapCost[l] < s.heapCost[m]) m = l;
    if (r <= s.size && s.heapCost[r] < s.heapCost[m]) m = r;
    if (m === i) break;
    swapHeap(s, i, m);
    i = m;
  }
  return top;
}

function swapHeap(s, a, b) {
  const n = s.heapNode[a]; s.heapNode[a] = s.heapNode[b]; s.heapNode[b] = n;
  const c = s.heapCost[a]; s.heapCost[a] = s.heapCost[b]; s.heapCost[b] = c;
}

function edgeCost(nav, a, b) {
  const dx = nav.x[a] - nav.x[b];
  const dz = nav.z[a] - nav.z[b];
  const dy = nav.y[a] - nav.y[b];
  // Stairs cost more than flat ground, doorways cost a little more than open
  // floor: given two ways round, take the one that does not funnel you.
  return Math.sqrt(dx * dx + dz * dz) + Math.abs(dy) * 1.5 + (nav.doorway[b] ? 0.25 : 0);
}

function heuristic(nav, a, goal) {
  const dx = nav.x[a] - nav.x[goal];
  const dz = nav.z[a] - nav.z[goal];
  const dy = nav.y[a] - nav.y[goal];
  return Math.sqrt(dx * dx + dz * dz) + Math.abs(dy);
}

// The list of nodes from `start` to `goal`, start included, or null. A search
// that has looked at every standing place in the building has answered the
// question — there is no way there — so that is the bound.
export function findPath(nav, start, goal) {
  if (start < 0 || goal < 0) return null;
  if (start === goal) return [start];
  const s = nav.scratch;
  const era = ++s.era;
  s.size = 0;
  s.g[start] = 0;
  s.from[start] = -1;
  s.stamp[start] = era;
  heapPush(s, start, heuristic(nav, start, goal));

  let visits = 0;
  while (s.size > 0) {
    const cur = heapPop(s);
    if (s.closed[cur] === era) continue;
    s.closed[cur] = era;
    if (cur === goal) return unwind(s, start, goal);
    if (++visits > nav.count) return null;
    for (let e = nav.edgeStart[cur]; e < nav.edgeStart[cur + 1]; e++) {
      const next = nav.edges[e];
      if (s.closed[next] === era) continue;
      const g = s.g[cur] + edgeCost(nav, cur, next);
      if (s.stamp[next] === era && g >= s.g[next]) continue;
      s.stamp[next] = era;
      s.g[next] = g;
      s.from[next] = cur;
      heapPush(s, next, g + heuristic(nav, next, goal));
    }
  }
  return null;
}

function unwind(s, start, goal) {
  const out = [];
  let n = goal;
  while (n !== -1 && n !== start) { out.push(n); n = s.from[n]; }
  out.push(start);
  out.reverse();
  return out;
}

// Can you walk from here to there without turning? Used to straighten the
// staircase of grid steps A* returns into the line a person would take.
export function walkableLine(nav, from, to) {
  const dx = nav.x[to] - nav.x[from];
  const dz = nav.z[to] - nav.z[from];
  const len = Math.hypot(dx, dz);
  const steps = Math.ceil(len / (nav.cell * 0.7));
  if (steps <= 1) return true;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = nav.x[from] + dx * t;
    const z = nav.z[from] + dz * t;
    const y = nav.y[from] + (nav.y[to] - nav.y[from]) * t;
    const ix = Math.floor((x - nav.minX) / nav.cell);
    const iz = Math.floor((z - nav.minZ) / nav.cell);
    const n = nodeInColumn(nav, ix, iz, y, LINK);
    if (n < 0 || !nav.live[n]) return false;
  }
  return true;
}

// Turn a path into the few corners that matter, so a bot walks a room in one
// straight line instead of shuffling along a grid.
export function smoothPath(nav, path) {
  if (!path || path.length < 3) return path;
  const out = [path[0]];
  let at = 0;
  while (at < path.length - 1) {
    // Never straighten past a doorway. The line between two rooms shaves the
    // jamb, and a straight line knows nothing about the door panel hanging in
    // it — which is how you get a man walking on the spot against a wall with
    // an open doorway half a metre to his left.
    let limit = path.length - 1;
    for (let j = at + 1; j <= limit; j++) {
      if (nav.doorway[path[j]]) { limit = j; break; }
    }
    let next = at + 1;
    for (let j = limit; j > at + 1; j--) {
      if (walkableLine(nav, path[at], path[j])) { next = j; break; }
    }
    out.push(path[next]);
    at = next;
  }
  return out;
}
