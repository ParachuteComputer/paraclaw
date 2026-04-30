/**
 * Vitest config for the paraclaw web UI.
 *
 * Kept separate from vite.config.ts so the production bundle config (mount
 * path, dev proxy) doesn't co-mingle with test concerns. jsdom is the only
 * environment that loads the React rendering paths under @testing-library —
 * happy-dom skips parts of <dialog> that the vault detail page uses.
 *
 * `setupFiles` extends `expect` with @testing-library/jest-dom matchers and
 * resets every test's localStorage / fetch mocks so the hub-OAuth state
 * from one test doesn't leak into the next.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
