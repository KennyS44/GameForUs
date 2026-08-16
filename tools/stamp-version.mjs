// Stamp a content version onto every module URL, so a new build arrives whole.
//
//   node tools/stamp-version.mjs
//
// GitHub Pages serves everything with `Cache-Control: max-age=600` and gives us
// no way to change that. Without a version in the URL, a returning player can
// end up with a fresh index.html and ten-minute-old modules — the new code
// running the old map. Putting the same hash on every import makes the whole
// graph one atomic set: either the browser has all of the new files or none of
// them.
//
// The hash is taken from the files with their existing stamps removed, so
// running this twice in a row changes nothing.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STAMP = /\?v=[0-9a-f]{8}/g;

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const VERSION_META = /(<meta name="gameforus-version" content=")[^"]*(")/;

const sources = [...jsFiles(join(ROOT, 'src')), join(ROOT, 'index.html'), join(ROOT, 'styles.css')].sort();
// Both the URL stamps and the version meta tag are outputs, not inputs: strip
// them before hashing, or every run would hash the previous run's answer.
const clean = new Map(sources.map((p) => [
  p,
  readFileSync(p, 'utf8').replace(STAMP, '').replace(VERSION_META, '$1$2'),
]));

const hash = createHash('sha1');
for (const p of sources) hash.update(relative(ROOT, p)).update(clean.get(p));
const version = hash.digest('hex').slice(0, 8);

// Relative module specifiers: './x.js', '../sim/sim.js', '../../vendor/three.module.js'.
const IMPORT = /(from\s+|import\s*\(\s*)(['"])(\.[^'"]+\.js)\2/g;

let touched = 0;
for (const p of sources) {
  let text = clean.get(p);
  if (p.endsWith('.js')) {
    text = text.replace(IMPORT, (_, lead, q, spec) => `${lead}${q}${spec}?v=${version}${q}`);
  } else if (p.endsWith('index.html')) {
    text = text
      .replace('href="styles.css"', `href="styles.css?v=${version}"`)
      .replace('src="src/main.js"', `src="src/main.js?v=${version}"`)
      .replace(VERSION_META, `$1${version}$2`);
  }
  if (text !== readFileSync(p, 'utf8')) {
    writeFileSync(p, text);
    touched++;
  }
}

// The running page compares this against its own stamp to notice a new build.
writeFileSync(join(ROOT, 'version.txt'), `${version}\n`);

console.log(`version ${version} — ${touched} file(s) rewritten`);
