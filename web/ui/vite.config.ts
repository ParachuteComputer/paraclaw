import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Per parachute-patterns/patterns/mount-path-convention.md: the canonical
// production deployment is under the Parachute hub at `/claw/`, so the
// build default IS the canonical mount. Override with `VITE_BASE_PATH=/`
// for the legacy stand-alone shape (UI served at the origin root). The
// previous default of `/` silently shipped root-relative asset URLs that
// 404'd under the hub mount — see #25.
const basePath = normalizeBase(process.env.VITE_BASE_PATH ?? "/claw/");

function normalizeBase(input: string): string {
  let b = input.startsWith("/") ? input : `/${input}`;
  if (!b.endsWith("/")) b += "/";
  return b;
}

export default defineConfig({
  base: basePath,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The dev server now serves under `/claw/` to match the production
      // mount; the proxy strips that prefix when forwarding to the Node
      // backend (which sees bare `/api/*` paths).
      "/claw/api": {
        target: process.env.PARACLAW_WEB_SERVER_URL ?? "http://127.0.0.1:1944",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/claw/, ""),
      },
    },
  },
});
