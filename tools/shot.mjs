// Take a picture of the game, from the command line.
//
// This replaces the throwaway script that used to get written before every
// visual check — launch a browser, click through the menu, wait out the setup
// clock, paste some hooks in, hope the weapon was not mid-sway, screenshot.
// Seventy-odd of those had piled up in /tmp. They are all this one command.
//
//   node tools/shot.mjs --weapon=ar-545-piston --ads
//   node tools/shot.mjs --weapon=all --out=docs/shots/{weapon}.png
//   node tools/shot.mjs --at=kitchen --face=dining --seconds=2
//   node tools/shot.mjs --list
//
// Options
//   --weapon=ID[,ID…|all]  what to hold. Several, or `all`, means one picture
//                          each from a single browser launch — which is where
//                          nearly all the time goes, so eleven weapons cost
//                          barely more than one.
//   --gadget=ID            what is in the other hand
//   --ads                  bring the sights up
//   --fire                 hold the trigger down
//   --at=ROOM|X,Z          where to stand — a room id, or coordinates
//   --y=N                  storey height, if the room's own is not wanted
//   --face=ROOM|X,Z        what to point at
//   --look=YAW[,PITCH]     ...or point by angle, in radians
//   --ticks=N              run this many simulation ticks before the picture
//   --seconds=N            ...or this long. Both are run on the spot, so a
//                          minute into a round costs no waiting.
//   --phase=live|prep      live is a real round, and the default. prep cannot
//                          be won or lost, but it also holds each side on its
//                          own half of the flat, so --at will not stick
//   --bots=N               how many opponents exist at all (default 1)
//   --hud                  keep the crosshair and health bar in shot
//   --wobble               let the weapon breathe and sway (default: held still)
//   --size=WxH             default 1280x720
//   --out=PATH             where to write. {weapon} and {n} are filled in.
//   --list                 print the room and weapon names and stop
//
// Everything it drives is behind ?debug=1 — see src/util/debug.js.

// Playwright lives in the machine's global modules, not the project's — this
// is a static site with no package.json and no dependencies, and it stays that
// way. Only the tools reach outside.
import playwright from '/usr/local/lib/node_modules/playwright/index.js';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const { chromium } = playwright;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// This account owns 20300-20319 and nothing else. 20300 and 20301 are usually
// somebody's dev server, so the tool starts looking above them and takes the
// first free one — two screenshot runs at once must not collide.
const PORTS = [20302, 20303, 20304, 20305, 20306, 20307, 20308, 20309];

// ── Arguments ─────────────────────────────────────────────────────────────

const args = {};
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (!m) {
    console.error(`не понял аргумент: ${raw}`);
    process.exit(2);
  }
  args[m[1]] = m[2] ?? true;
}

const num = (v, fallback) => (v === undefined ? fallback : Number(v));

// A place is either a room id or a pair of coordinates. Both spellings reach
// the page unchanged; the debug handle knows what to do with either.
function place(v) {
  if (v === undefined || v === true) return null;
  if (!v.includes(',')) return v;
  const [x, z] = v.split(',').map(Number);
  return { x, z };
}

const opts = {
  gadget: typeof args.gadget === 'string' ? args.gadget : null,
  ads: !!args.ads,
  fire: !!args.fire,
  at: place(args.at),
  y: args.y === undefined ? null : Number(args.y),
  face: place(args.face),
  look: typeof args.look === 'string' ? args.look.split(',').map(Number) : null,
  phase: typeof args.phase === 'string' ? args.phase : 'live',
  hud: !!args.hud,
  ticks: args.seconds !== undefined
    ? Math.round(Number(args.seconds) * 60)
    : num(args.ticks, 60),
};

const bots = num(args.bots, 1);
const still = !args.wobble;
const [width, height] = (typeof args.size === 'string' ? args.size : '1280x720')
  .split('x').map(Number);

// ── The roster, read straight off the map ─────────────────────────────────
//
// No browser needed: the map and the weapon table are plain data that runs in
// Node, which is the same property the simulation tests rely on.

const { WEAPONS } = await import(new URL('../src/sim/constants.js', import.meta.url));
const { APARTMENT } = await import(new URL('../src/maps/apartment.js', import.meta.url));

if (args.list) {
  console.log('Оружие:');
  for (const [id, def] of Object.entries(WEAPONS)) {
    console.log(`  ${id.padEnd(16)} ${def.name} — ${def.blurb}`);
  }
  console.log('\nКомнаты (--at / --face):');
  for (const r of APARTMENT.rooms) {
    const x = ((r.min.x + r.max.x) / 2).toFixed(1);
    const z = ((r.min.z + r.max.z) / 2).toFixed(1);
    console.log(`  ${r.id.padEnd(14)} эт.${r.floor}  ${String(x).padStart(6)},${String(z).padStart(6)}  ${r.name}`);
  }
  process.exit(0);
}

const weapons = args.weapon === 'all'
  ? Object.keys(WEAPONS)
  : (typeof args.weapon === 'string' ? args.weapon.split(',') : [null]);

for (const id of weapons) {
  if (id && !WEAPONS[id]) {
    console.error(`нет такого оружия: ${id}\nсписок: node tools/shot.mjs --list`);
    process.exit(2);
  }
}

const outPattern = typeof args.out === 'string'
  ? args.out
  : `docs/shots/${weapons.length > 1 ? '{weapon}' : 'shot'}.png`;

// ── What happens inside the page ──────────────────────────────────────────
//
// One round trip per picture: set the scene, run the clock forward by hand,
// then wait for a frame to be drawn. Running the ticks here rather than letting
// the browser pace itself is what makes this quick — under a software renderer
// the animation clock crawls, and a round second costs twenty real ones.

async function compose(page, shot) {
  return page.evaluate(async (o) => {
    const g = window.__gfu;
    g.pause();
    if (o.weapon) g.weapon(o.weapon);
    if (o.gadget) g.gadget(o.gadget);

    // Skipping the setup clock only takes effect once the round has been run
    // for a tick — that is what tells the menus to get out of the way.
    g.phase(o.phase);
    g.tick(1);

    const asked = o.at ? g.at(o.at, o.y ?? undefined) : null;
    if (o.face) g.face(o.face);
    else if (o.look) g.look(o.look[0], o.look[1] ?? 0);

    g.release();
    const held = {};
    if (o.ads) held.aim = true;
    if (o.fire) held.fire = true;
    g.hold(held);

    g.tick(Math.max(1, o.ticks));
    g.hud(o.hud);
    await g.frame();
    // Where he was put, as well as where he ended up: the two come apart more
    // often than you would think, and silently. See the check below.
    return { ...g.info(), asked };
  }, shot);
}

// ── Run ───────────────────────────────────────────────────────────────────

let server = null;
let port = 0;
for (const p of PORTS) {
  try {
    server = await serve(p);
    port = p;
    break;
  } catch {
    /* somebody else has it; try the next */
  }
}
if (!server) {
  console.error(`все порты заняты: ${PORTS.join(', ')}`);
  process.exit(1);
}

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width, height } });

const problems = [];
page.on('pageerror', (e) => problems.push(String(e)));
page.on('requestfailed', (r) => problems.push(`не загрузилось: ${r.url()}`));

const query = new URLSearchParams({ debug: '1', solo: '1' });
if (still) query.set('still', '1');
// Bots are a knob because they are the only thing in an empty flat that can
// move while the picture is being set up. One is the floor, not zero: with
// nobody defending, the round is won the moment it starts and the screen
// becomes a scoreboard.
query.set('bots', String(bots));

await page.goto(`http://localhost:${port}/?${query}`, { waitUntil: 'domcontentloaded' });
// The match is built behind a loading screen, and under a software renderer
// building it is the slowest thing that happens all run.
await page.waitForFunction(() => window.__gfu?.info().running === true, null, { timeout: 180000 });

await mkdir(resolve(ROOT, dirname(outPattern.replace(/\{[^}]+\}/g, 'x'))), { recursive: true });

let n = 0;
for (const weapon of weapons) {
  n += 1;
  const out = outPattern
    .replace('{weapon}', weapon ?? 'shot')
    .replace('{n}', String(n));
  const path = resolve(ROOT, out);
  await mkdir(dirname(path), { recursive: true });

  const info = await compose(page, { ...opts, weapon });
  await page.screenshot({ path });

  const where = info.me
    ? `${info.me.pos.x},${info.me.pos.z} эт.${info.me.pos.y > 1.65 ? 2 : 1}`
    : 'нет игрока';
  console.log(`${out}  ${weapon ?? '(по умолчанию)'}  ${info.phase}  ${where}${opts.ads ? `  прицел ${info.me?.aim}` : ''}`);

  // A round that has already been decided is a scoreboard, not a picture.
  if (info.phase === 'over') {
    console.error('  ! раунд закончился — картинка снята после конца боя');
  }

  // Being put somewhere and staying there are different things, and the game is
  // within its rights to disagree. During prep it holds each side on its own
  // half and quietly walks anyone else back, so --at looks like it did nothing;
  // a spot inside a wall gets pushed out; a spot in mid-air is fallen out of.
  // Saying so beats staring at a picture of the wrong room.
  if (info.asked && info.me) {
    const drift = Math.hypot(
      info.me.pos.x - info.asked.x, info.me.pos.z - info.asked.z,
    );
    if (drift > 0.5) {
      console.error(
        `  ! игрок не остался там, куда поставлен: просили ${info.asked.x.toFixed(1)},${info.asked.z.toFixed(1)}`
        + `, он в ${info.me.pos.x},${info.me.pos.z} (${drift.toFixed(1)} м)`
        + (info.phase === 'prep' ? ' — в фазе prep каждую сторону держат на своей половине, снимай в live' : ''),
      );
    }
  }
  if (opts.ads && info.me && info.me.aim < 0.99) {
    console.error(`  ! прицел поднят не до конца (${info.me.aim}) — добавь тиков`);
  }
}

await browser.close();
server.close();

if (problems.length) {
  console.error(`\nошибки страницы:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
