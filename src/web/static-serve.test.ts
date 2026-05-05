/**
 * Static-serve mount-strip tests. Mirrors the cases in paraclaw#13:
 *   - mount=""  : behavior unchanged from pre-strip implementation
 *   - mount=/X  : prefix stripped before resolving against dist/
 *   - SPA fallback returns dist/index.html with text/html content-type
 *   - Path traversal still 400s
 *   - Absent dist/ → 503
 *
 * Uses a real http server bound to an ephemeral port + a real dist fixture
 * on disk. Faster than spinning up the full paraclaw server (no DB / auth)
 * but still exercises the actual fs + node http stack — same shape as
 * auth.test.ts.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeServeStatic, normalizeMount } from './static-serve.js';

interface FetchResult {
  status: number;
  contentType: string;
  body: string;
}

function fetchPath(baseUrl: string, urlPath: string): Promise<FetchResult> {
  // Use http.request with explicit path so callers can send raw paths like
  // `/../etc/passwd` without the URL parser normalizing `..` away before the
  // request goes on the wire — that matters for the path-traversal test.
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: 'GET',
        path: urlPath,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('normalizeMount', () => {
  it('returns empty for empty + slash', () => {
    expect(normalizeMount('')).toBe('');
    expect(normalizeMount('/')).toBe('');
  });

  it('strips trailing slash', () => {
    expect(normalizeMount('/agent')).toBe('/agent');
    expect(normalizeMount('/agent/')).toBe('/agent');
    expect(normalizeMount('/agent///')).toBe('/agent');
  });
});

describe('makeServeStatic', () => {
  let distDir: string;

  beforeEach(() => {
    distDir = mkdtempSync(join(tmpdir(), 'parachute-agent-static-'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body>shell</body></html>');
    mkdirSync(join(distDir, 'assets'));
    writeFileSync(join(distDir, 'assets', 'index-X.js'), 'export const k = 1;');
    writeFileSync(join(distDir, 'assets', 'index-X.css'), 'body { color: red }');
  });

  afterEach(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  describe('mount=""', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(() => {});

    beforeEach(async () => {
      const handler = makeServeStatic({ distDir, mount: '' });
      const ctx = await startServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        handler(req, res, url.pathname);
      });
      server = ctx.server;
      baseUrl = ctx.baseUrl;
    });

    afterEach(async () => {
      await stopServer(server);
    });

    it('GET / serves index.html as text/html', async () => {
      const r = await fetchPath(baseUrl, '/');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('text/html');
      expect(r.body).toContain('shell');
    });

    it('GET /assets/index-X.js serves the file as application/javascript', async () => {
      const r = await fetchPath(baseUrl, '/assets/index-X.js');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('application/javascript');
      expect(r.body).toBe('export const k = 1;');
    });

    it('GET /unknown/path SPA-falls-back to index.html', async () => {
      const r = await fetchPath(baseUrl, '/unknown/path');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('text/html');
      expect(r.body).toContain('shell');
    });
  });

  describe('mount="/agent"', () => {
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
      const handler = makeServeStatic({ distDir, mount: '/agent' });
      const ctx = await startServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        handler(req, res, url.pathname);
      });
      server = ctx.server;
      baseUrl = ctx.baseUrl;
    });

    afterEach(async () => {
      await stopServer(server);
    });

    it('GET /agent/ serves index.html as text/html (prefix stripped → /)', async () => {
      const r = await fetchPath(baseUrl, '/agent/');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('text/html');
      expect(r.body).toContain('shell');
    });

    it('GET /agent/assets/index-X.js serves the JS bundle correctly (the regression #13 fixed)', async () => {
      const r = await fetchPath(baseUrl, '/agent/assets/index-X.js');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('application/javascript');
      expect(r.body).toBe('export const k = 1;');
    });

    it('GET /agent/assets/index-X.css serves CSS correctly', async () => {
      const r = await fetchPath(baseUrl, '/agent/assets/index-X.css');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('text/css');
      expect(r.body).toBe('body { color: red }');
    });

    it('GET /agent/some/spa/route SPA-falls-back to index.html (BrowserRouter resolves)', async () => {
      const r = await fetchPath(baseUrl, '/agent/some/spa/route');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('text/html');
      expect(r.body).toContain('shell');
    });

    it('GET /assets/index-X.js (no prefix) still serves the file — matches notes-serve behavior', async () => {
      // Defense-in-depth: paths that don't start with the mount aren't 404'd.
      // The real frontend never makes these requests (Vite bakes /agent/ into
      // the bundle's asset URLs), but a direct test from a healthcheck or
      // local-dev curl shouldn't break — same shape as
      // parachute-hub/src/notes-serve.ts at paths-without-prefix.
      const r = await fetchPath(baseUrl, '/assets/index-X.js');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('application/javascript');
      expect(r.body).toBe('export const k = 1;');
    });

    it('GET /agent is a SPA route (no trailing slash) → SPA shell', async () => {
      const r = await fetchPath(baseUrl, '/agent');
      expect(r.status).toBe(200);
      expect(r.contentType).toContain('text/html');
      expect(r.body).toContain('shell');
    });
  });

  describe('safety', () => {
    // The URL constructor in server.ts (and in the http test fixture above)
    // normalizes `..` away before the handler ever sees the path, so the
    // `..` guard inside makeServeStatic is defense-in-depth — tested by
    // calling the handler directly with a synthetic url-path.
    it('handler called with a path containing `..` → 400 bad path', () => {
      const handler = makeServeStatic({ distDir, mount: '' });
      let status = 0;
      let body = '';
      const res = {
        writeHead(s: number) {
          status = s;
        },
        end(chunk?: string) {
          body = chunk ?? '';
        },
      } as unknown as http.ServerResponse;
      handler({} as http.IncomingMessage, res, '/../etc/passwd');
      expect(status).toBe(400);
      expect(body).toContain('bad path');
    });
  });

  describe('missing dist', () => {
    it('returns 503 with a build-instruction body', async () => {
      const handler = makeServeStatic({
        distDir: join(tmpdir(), 'paraclaw-does-not-exist-' + Date.now()),
        mount: '',
      });
      const ctx = await startServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        handler(req, res, url.pathname);
      });
      try {
        const r = await fetchPath(ctx.baseUrl, '/');
        expect(r.status).toBe(503);
        expect(r.body).toContain('UI bundle not found');
      } finally {
        await stopServer(ctx.server);
      }
    });
  });
});
