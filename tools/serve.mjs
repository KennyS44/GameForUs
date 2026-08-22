// Minimal static file server for local testing only.
//
// The published site is served as plain static files by the platform; this just
// reproduces that locally so the game can be opened in a browser during
// development. It is not part of the deliverable.
//
//   node tools/serve.mjs [port]
//
// tools/shot.mjs imports serve() instead of running this as a command, so the
// screenshot tool brings up its own server and takes it down again rather than
// depending on one somebody remembered to start.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    // Keep requests inside the project directory.
    const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');

    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
};

// Returns the running server, so a caller can close it when it is done.
export function serve(port) {
  const server = createServer(handler);
  return new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(port, () => ready(server));
  });
}

// Run as a command, keep serving until interrupted.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] || process.env.PORT || 20300);
  await serve(port);
  console.log(`serving ${ROOT} at http://localhost:${port}`);
}
