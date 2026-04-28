/**
 * Static-file handler for the built UI bundle, with optional mount-prefix
 * stripping.
 *
 * When paraclaw is fronted by `parachute expose tailnet` at a path prefix
 * (e.g. `https://<host>/claw/`), tailscale serve forwards the request with
 * the prefix preserved. Combined with a Vite build that bakes the prefix
 * into asset URLs (`VITE_BASE_PATH=/claw/`), the browser asks for
 * `/claw/assets/index-X.js` — which a 1:1 path-to-dist map turns into the
 * non-existent `dist/claw/assets/index-X.js`, falls back to the SPA shell,
 * and ships `text/html` for what should be a JS module. Page never boots.
 *
 * Mirrors `parachute-hub/src/notes-serve.ts:96-115` — strip the mount
 * prefix off the request path before resolving against `dist/`. Standalone
 * paraclaw (`mount=""`) is unchanged: the strip is a no-op when no prefix
 * is configured.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Normalize a mount value to either `""` (no strip) or a prefix without a
 * trailing slash (e.g. `/claw`). `""` and `"/"` both mean "no strip" so
 * standalone deployments at the origin root don't accidentally strip a
 * leading `/`.
 */
export function normalizeMount(raw: string): string {
  if (raw === '' || raw === '/') return '';
  return raw.replace(/\/+$/, '');
}

export interface StaticServeOpts {
  distDir: string;
  /** Mount prefix to strip before resolving against `distDir` (e.g. `/claw`). */
  mount: string;
}

/**
 * Build the static-serve handler closure. The returned function has the
 * same shape as the inline handler that previously lived in server.ts —
 * `(req, res, urlPath)` — but resolves through the configured mount + dist.
 *
 * SPA-fallback behavior matches the prior implementation: any path that
 * doesn't resolve to a real file under `dist/` returns `index.html` so
 * BrowserRouter routes work on hard-refresh. The mount-strip only changes
 * the lookup; missing-file fallback is unchanged.
 */
export function makeServeStatic(opts: StaticServeOpts) {
  const { distDir, mount } = opts;
  return function serveStatic(_req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
    if (!fs.existsSync(distDir)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        'UI bundle not found at ' +
          distDir +
          '\n\nIn dev: run `pnpm --filter @paraclaw/web-ui dev` and open http://localhost:5173/.\n' +
          'In prod: run `pnpm --filter @paraclaw/web-ui build` first.',
      );
      return;
    }

    let pathname = urlPath;
    if (mount && (pathname === mount || pathname.startsWith(`${mount}/`))) {
      pathname = pathname.slice(mount.length) || '/';
    }

    let rel = pathname.replace(/^\/+/, '') || 'index.html';

    if (rel.includes('..')) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }

    let abs = path.join(distDir, rel);
    if (!abs.startsWith(distDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      abs = path.join(distDir, 'index.html');
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    const stream = fs.createReadStream(abs);
    res.writeHead(200, { 'content-type': mime });
    stream.pipe(res);
  };
}
