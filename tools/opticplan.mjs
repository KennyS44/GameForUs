// Draw the sight catalogue: one picture per optic, through the sights, plus
// the page that puts them side by side.
//
//   node tools/opticplan.mjs
//   node tools/opticplan.mjs --weapon=ar-545-piston --at=cinema --face=gallery
//
// Writes docs/ref/optics/<id>.png and docs/optics.html.
//
// This is a reference sheet in the same sense as docs/weapons.html: nothing on
// it is drawn by hand or written twice. The pictures are the game, taken
// through the sights at a fixed spot, and the figures beside them are read out
// of the same table the simulation uses — so the sheet cannot quietly disagree
// with what a player gets when they fit one.
//
// One weapon carries every 1× sight and one carries the magnified pair,
// because the allow-list forbids a submachine gun from wearing a marksman
// tube. Which weapon a sight is photographed on is written under the picture,
// since the housing looks different against a different receiver.

import playwright from '/usr/local/lib/node_modules/playwright/index.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const { chromium } = playwright;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 20312;

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const { OPTICS, OPTICS_BY_CLASS, WEAPONS } = await import(
  new URL('../src/sim/constants.js', import.meta.url)
);

// Where each sight gets photographed, and on what. A rifle takes everything
// that is not magnified past its class; the marksman rifle takes the rest.
const CARRIER = arg('weapon', 'ar-545-piston');
const HEAVY = 'dmr-762';

function carrierFor(opticId) {
  const rifle = OPTICS_BY_CLASS[WEAPONS[CARRIER].cls] ?? [];
  return rifle.includes(opticId) ? CARRIER : HEAVY;
}

const AT = arg('at', 'cinema');
const FACE = arg('face', 'gallery');
const SIZE = (arg('size', '900x506')).split('x').map(Number);

// ── Take the pictures ─────────────────────────────────────────────────────

const server = await serve(PORT);
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: SIZE[0], height: SIZE[1] } });
const problems = [];
page.on('pageerror', (e) => problems.push(String(e)));

await page.goto(
  `http://localhost:${PORT}/?debug=1&solo=1&still=1&bots=1&mates=0`,
  { waitUntil: 'domcontentloaded' },
);
await page.waitForFunction(() => window.__gfu?.info().running === true, null, { timeout: 180000 });

await mkdir(resolve(ROOT, 'docs/ref/optics'), { recursive: true });

const shot = [];
for (const id of Object.keys(OPTICS)) {
  const weapon = carrierFor(id);
  const info = await page.evaluate(async (o) => {
    const g = window.__gfu;
    g.pause();
    g.optic(o.weapon, o.id);
    g.weapon(o.weapon);
    g.phase('live');
    g.tick(1);
    g.at(o.at);
    g.face(o.face);
    g.release();
    g.hold({ aim: true });
    // Long enough for the slowest glass here to be all the way up: a
    // marksman tube takes half again as long as a red dot, and a picture of a
    // sight halfway to the eye is a picture of nothing.
    g.tick(140);
    g.hud(false);
    g.redraw(4);
    await g.frame();
    return g.info();
  }, { id, weapon, at: AT, face: FACE });

  const out = `docs/ref/optics/${id}.png`;
  await page.screenshot({ path: resolve(ROOT, out), timeout: 180000, animations: 'disabled' });
  if (info.me?.aim < 0.99) {
    console.error(`  ! ${id}: прицел поднят не до конца (${info.me.aim})`);
  }
  shot.push({ id, weapon, out });
  console.log(`${out}  ${OPTICS[id].name}  на ${WEAPONS[weapon].name}`);
}

await browser.close();
server.close();

// ── Write the sheet ───────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const aimWord = (scale) => {
  if (scale < 1) return `вскидка быстрее на ${Math.round((1 - scale) * 100)}%`;
  if (scale > 1) return `вскидка дольше на ${Math.round((scale - 1) * 100)}%`;
  return 'вскидка обычная';
};

const rows = shot.map(({ id, weapon, out }) => {
  const o = OPTICS[id];
  const classes = Object.entries(OPTICS_BY_CLASS)
    .filter(([, list]) => list.includes(id))
    .map(([cls]) => ({
      smg: 'ПП', rifle: 'автоматы', shotgun: 'дробовики', heavy: 'крупный калибр',
    }[cls] ?? cls));
  return `<figure class="optic">
  <img src="${esc(out.replace('docs/', ''))}" alt="${esc(o.name)} — вид через прицел" loading="lazy">
  <figcaption>
    <h2>${esc(o.name)}</h2>
    <p class="blurb">${esc(o.blurb)}</p>
    <dl>
      <div><dt>Увеличение</dt><dd>${o.zoom > 1 ? `${String(o.zoom).replace('.', ',')}×` : '1× (без увеличения)'}</dd></div>
      <div><dt>Вскидка</dt><dd>${esc(aimWord(o.aimScale))}</dd></div>
      <div><dt>Ставится на</dt><dd>${esc(classes.join(', '))}</dd></div>
      <div><dt>На снимке</dt><dd>${esc(WEAPONS[weapon].name)}</dd></div>
    </dl>
  </figcaption>
</figure>`;
}).join('\n');

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GameForUs — прицелы</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 32px 16px 64px;
    background: #0a0b0d; color: #e8e6e3;
    font: 16px/1.6 system-ui, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 66rem; margin: 0 auto; }
  h1 { font-size: 32px; letter-spacing: 0.06em; margin: 0 0 8px; text-transform: uppercase; }
  .lead { color: #a5a29c; margin: 0 0 32px; max-width: 44rem; }
  .optic {
    margin: 0 0 32px; padding: 0 0 32px;
    border-bottom: 1px solid #24262b;
    display: grid; gap: 16px;
  }
  @media (min-width: 60rem) { .optic { grid-template-columns: 3fr 2fr; align-items: start; } }
  .optic img { width: 100%; height: auto; display: block; border-radius: 4px; background: #000; }
  .optic h2 { font-size: 24px; margin: 0 0 8px; }
  .blurb { color: #a5a29c; margin: 0 0 16px; }
  dl { margin: 0; display: grid; gap: 8px; }
  dl div { display: flex; gap: 8px; }
  dt { color: #a5a29c; min-width: 9.5rem; }
  dd { margin: 0; }
  footer { color: #a5a29c; font-size: 14px; margin-top: 32px; }
  a { color: #e08b3c; }
</style>
</head>
<body>
<div class="wrap">
<h1>Прицелы</h1>
<p class="lead">
  Что можно поставить на планку и как это выглядит через прицельное окно.
  Снимки сделаны в самой игре с одного и того же места, при полностью поднятом
  прицеле. Ни одна цифра здесь не написана руками: они читаются из той же
  таблицы, по которой работает игра.
</p>
<p class="lead">
  Прицел не меняет ни урона, ни разброса, ни отдачи. Он решает, что вы видите
  и сколько времени уходит на вскидку — увеличение стоит времени, механика
  экономит его.
</p>
${rows}
<footer>
  Собрано <code>node tools/opticplan.mjs</code>. Обратно в
  <a href="../README.md">README</a>.
</footer>
</div>
</body>
</html>
`;

await writeFile(resolve(ROOT, 'docs/optics.html'), html);
console.log(`\ndocs/optics.html — ${shot.length} прицел(ов)`);

if (problems.length) {
  console.error(`\nошибки страницы:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
