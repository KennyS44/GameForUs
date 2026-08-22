// Everything that can say "this is broken", in one command.
//
//   node tools/check.mjs          the lot
//   node tools/check.mjs --fast   skip the browser, keep the rest
//
// There were four things to remember to run and an order to run them in, and
// the one that mattered most — stamping the version — was the easiest to
// forget, because forgetting it breaks nothing locally and serves half of the
// old build to the player. So: one command, and it reports rather than asks.
//
// What it does, and why each one earns its seconds:
//
//   geometry  every room reachable, no spawn inside a wall, stairs climbable
//   rules     the simulation, in pure Node — the same code the browser runs
//   version   stamps the build, and says so if something was left unstamped
//   boot      loads the real page in a real browser and watches it start
//
// The last one is the only one that catches a broken import path, because
// nothing else here loads the game the way a visitor does. It also stands
// guard over the debug handle: `window.__gfu` must not exist on a plain load,
// and a check is worth more than remembering.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import playwright from '/usr/local/lib/node_modules/playwright/index.js';
import { serve } from './serve.mjs';

const { chromium } = playwright;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fast = process.argv.includes('--fast');

// One free port from the block this account owns, above the two a dev server
// usually sits on.
const PORT = 20310;

const results = [];

// ── Arm the commit hook ───────────────────────────────────────────────────
//
// `.githooks/pre-commit` is committed, but the setting that points git at it
// is local to a clone — so a fresh checkout has the hook on disk and switched
// off, which is the worst of both. Setting it here means running the checks
// once is enough, and doing it every run costs nothing because git only
// rewrites the config if the value actually differs.
{
  const cfg = spawn('git', ['config', 'core.hooksPath'], { cwd: ROOT });
  let current = '';
  cfg.stdout.on('data', (d) => { current += d; });
  await new Promise((done) => cfg.on('close', done));
  if (current.trim() !== '.githooks') {
    await new Promise((done) => {
      spawn('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT }).on('close', done);
    });
    console.log('ok    хук      включил проверку версии перед коммитом');
  }
}

function note(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'СБОЙ'}  ${name.padEnd(9)} ${detail}`);
}

// ── Running another tool ──────────────────────────────────────────────────

function runTool(script, args = []) {
  return new Promise((done) => {
    const p = spawn('node', [`${ROOT}tools/${script}`, ...args], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => done({ code, out }));
  });
}

// The two that only need Node run side by side: one takes two seconds and the
// other nineteen, and there is no reason to spend twenty-one.
const [geometry, rules] = await Promise.all([
  runTool('map-check.mjs'),
  runTool('sim-smoke.mjs'),
]);

note('geometry', geometry.code === 0,
  geometry.code === 0
    ? `${(geometry.out.match(/ok /g) ?? []).length} проверок`
    : 'см. вывод ниже');

note('rules', rules.code === 0,
  rules.code === 0
    ? `${(rules.out.match(/^ {2}ok/gm) ?? []).length} проверок`
    : 'см. вывод ниже');

// ── The version stamp ─────────────────────────────────────────────────────
//
// Rewriting nothing is the good answer: it means every module URL already
// carries the hash of what is actually in the files.

const stamp = await runTool('stamp-version.mjs');
const rewritten = Number(/— (\d+) file/.exec(stamp.out)?.[1] ?? -1);
const version = readFileSync(`${ROOT}version.txt`, 'utf8').trim();
note('version', stamp.code === 0 && rewritten === 0,
  rewritten === 0
    ? version
    : `${version} — правки не были проштампованы, поправил ${rewritten} файл(ов)`);

// ── The page, in a browser ────────────────────────────────────────────────

if (!fast) {
  const server = await serve(PORT);
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const errors = [];
  const failed = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => failed.push(r.url()));

  let booted = false;
  let leaked = 'undefined';
  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__gameforusReady === true, null, { timeout: 120000 });
    booted = true;
    leaked = await page.evaluate(() => typeof window.__gfu);
  } catch (e) {
    errors.push(String(e));
  }
  await browser.close();
  server.close();

  const clean = booted && !errors.length && !failed.length && leaked === 'undefined';
  note('boot', clean, clean
    ? 'страница поднялась, ошибок нет, __gfu отсутствует'
    : [
      booted ? null : 'не загрузилась',
      errors.length ? `${errors.length} ошибок` : null,
      failed.length ? `${failed.length} файлов не загрузилось` : null,
      leaked === 'undefined' ? null : `__gfu виден на обычной загрузке (${leaked})`,
    ].filter(Boolean).join(', '));

  for (const e of errors) console.error(`      ${e}`);
  for (const f of failed) console.error(`      не загрузилось: ${f}`);
}

// ── The verdict ───────────────────────────────────────────────────────────

const bad = results.filter((r) => !r.ok);
if (!bad.length) {
  console.log(`\nВсё чисто. Версия ${version}${fast ? ' (браузер пропущен)' : ''}.`);
  process.exit(0);
}

console.log(`\nНе прошло: ${bad.map((r) => r.name).join(', ')}\n`);
if (geometry.code !== 0) console.log(geometry.out.split('\n').slice(-25).join('\n'));
if (rules.code !== 0) console.log(rules.out.split('\n').slice(-25).join('\n'));
process.exit(1);
