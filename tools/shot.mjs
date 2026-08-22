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
//   --mates=N              ...and how many are on your side (default 0)
//   --dead                 take yourself out of the round first, which is how
//                          to photograph what a dead player is shown
//   --hud                  keep the crosshair and health bar in shot
//   --wobble               let the weapon breathe and sway (default: held still)
//   --size=WxH             default 1280x720
//   --out=PATH             where to write. {weapon} and {n} are filled in.
//   --diff=PATH            compare against an earlier picture: prints how much
//                          moved and where, and writes a three-panel sheet
//                          (before, after, what changed) next to --out
//   --list                 print the room and weapon names and stop
//
// Everything it drives is behind ?debug=1 — see src/util/debug.js.

// Playwright lives in the machine's global modules, not the project's — this
// is a static site with no package.json and no dependencies, and it stays that
// way. Only the tools reach outside.
import playwright from '/usr/local/lib/node_modules/playwright/index.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  dead: !!args.dead,
  ticks: args.seconds !== undefined
    ? Math.round(Number(args.seconds) * 60)
    : num(args.ticks, 60),
};

const bots = num(args.bots, 1);
const mates = num(args.mates, 0);
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

const diffPattern = typeof args.diff === 'string' ? args.diff : null;

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

    // Dying is done before the clock runs, so the picture is of the round
    // carrying on without you rather than of the moment you fell.
    if (o.dead) g.kill();

    g.release();
    const held = {};
    if (o.ads) held.aim = true;
    if (o.fire) held.fire = true;
    g.hold(held);

    g.tick(Math.max(1, o.ticks));
    g.hud(o.hud);
    // Let the lighting finish arriving before the shutter — see redraw().
    g.redraw(4);
    await g.frame();
    // Where he was put, as well as where he ended up: the two come apart more
    // often than you would think, and silently. See the check below.
    return { ...g.info(), asked };
  }, shot);
}

// ── Comparing two pictures ────────────────────────────────────────────────
//
// The whole reason the frames are held still: two shots either side of an edit
// differ only where the edit did, so the difference between them is a direct
// readout of what the change actually touched. Eyeballing that was the slow
// part of every carry-position round — "is the stock lower, or do I want it to
// be?" — and a percentage with a bounding box answers it in one line.
//
// Done in the browser because it already has a PNG decoder and a canvas, and
// this project has no image library and is not getting one for this.
async function diffImages(page, beforeBuf, afterBuf) {
  return page.evaluate(async ([a64, b64]) => {
    const load = (b64) => new Promise((done, fail) => {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => fail(new Error('картинка не читается'));
      img.src = `data:image/png;base64,${b64}`;
    });
    const [before, after] = await Promise.all([load(a64), load(b64)]);
    if (before.width !== after.width || before.height !== after.height) {
      return { sizeMismatch: `${before.width}x${before.height} против ${after.width}x${after.height}` };
    }

    const { width: w, height: h } = after;
    const grab = (img) => {
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, w, h).data;
    };
    const A = grab(before);
    const B = grab(after);

    // A threshold, not equality: two runs of the same code are byte-identical,
    // so anything above the noise floor is a real change rather than dither.
    const THRESHOLD = 8;
    let changed = 0;
    let minX = w; let minY = h; let maxX = -1; let maxY = -1;
    const mask = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < A.length; i += 4) {
      const d = Math.max(
        Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]),
      );
      if (d <= THRESHOLD) { mask[i + 3] = 255; continue; }
      changed++;
      const p = i / 4;
      const x = p % w; const y = (p / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      mask[i] = 255;
      mask[i + 1] = 40;
      mask[i + 2] = 40;
      mask[i + 3] = 255;
    }

    // Three panels: what it was, what it is, and only what moved.
    const sheet = new OffscreenCanvas(w * 3 + 8, h);
    const g = sheet.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, sheet.width, h);
    g.drawImage(before, 0, 0);
    g.drawImage(after, w + 4, 0);
    const maskCanvas = new OffscreenCanvas(w, h);
    maskCanvas.getContext('2d').putImageData(new ImageData(mask, w, h), 0, 0);
    g.drawImage(maskCanvas, w * 2 + 8, 0);

    const blob = await sheet.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (const byte of buf) bin += String.fromCharCode(byte);

    return {
      changed,
      total: w * h,
      percent: +((changed / (w * h)) * 100).toFixed(2),
      box: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      sheet: btoa(bin),
    };
  }, [beforeBuf.toString('base64'), afterBuf.toString('base64')]);
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
query.set('mates', String(mates));

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
  // Thirty seconds is Playwright's default and this scene outgrew it: under a
  // software renderer a single frame of a lit two-storey flat can take longer
  // than that when the machine is busy.
  const png = await page.screenshot({ path, timeout: 180000, animations: 'disabled' });

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

  if (diffPattern) {
    const beforePath = resolve(ROOT, diffPattern
      .replace('{weapon}', weapon ?? 'shot')
      .replace('{n}', String(n)));
    let before = null;
    try {
      before = await readFile(beforePath);
    } catch {
      console.error(`  ! не с чем сравнивать: нет ${beforePath.slice(ROOT.length)}`);
    }
    if (before) {
      const d = await diffImages(page, before, png);
      if (d.sizeMismatch) {
        console.error(`  ! кадры разного размера (${d.sizeMismatch}) — сравнивать нечего`);
      } else {
        const sheet = path.replace(/\.png$/, '-diff.png');
        await writeFile(sheet, Buffer.from(d.sheet, 'base64'));
        console.log(
          `  ${d.percent}% пикселей изменилось`
          + (d.box ? `, всё в области ${d.box.w}×${d.box.h} от ${d.box.x},${d.box.y}` : ', кадры совпадают')
          + ` → ${sheet.slice(ROOT.length)}`,
        );
      }
    }
  }
}

await browser.close();
server.close();

if (problems.length) {
  console.error(`\nошибки страницы:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
