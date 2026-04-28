import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Production runs under Bun where `bun:sqlite` is native. For the vitest
      // test path (Node), alias to a thin shim around better-sqlite3 that
      // mirrors the `bun:sqlite` surface. See src/db/_bun-sqlite-shim.ts.
      'bun:sqlite': fileURLToPath(new URL('./src/db/_bun-sqlite-shim.ts', import.meta.url)),
    },
  },
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    include: ['src/**/*.test.ts'],
  },
});
