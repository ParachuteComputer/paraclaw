// Regression check for parachute-patterns/patterns/mount-path-convention.md:
// the canonical-mount default build must produce asset URLs prefixed with
// `/agent/`. If `vite.config.ts`'s `base` ever drifts back to `/`, the bundle
// HTML loses the prefix and 404s under the hub mount — exactly the silent
// failure that motivated paraclaw#25.
//
// Skipped when VITE_BASE_PATH is set explicitly (legitimate override for
// stand-alone or alternate-mount builds).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const override = process.env.VITE_BASE_PATH;
if (override && override !== "/agent/") {
  console.log(`verify-base: VITE_BASE_PATH=${override} (override) — skipping default-mount check.`);
  process.exit(0);
}

const html = readFileSync(resolve("dist/index.html"), "utf8");
const wantPrefix = '/agent/assets/';
const hasMounted = html.includes(`src="${wantPrefix}`) || html.includes(`href="${wantPrefix}`);
if (!hasMounted) {
  console.error(
    "✖ verify-base: dist/index.html is missing /agent/-prefixed asset URLs.\n" +
      "  This means vite's `base` resolved to something other than `/agent/`.\n" +
      "  Check web/ui/vite.config.ts (default should be `/agent/`) and any\n" +
      "  VITE_BASE_PATH env var leaking into the build environment.",
  );
  process.exit(1);
}
console.log("verify-base: ✓ dist/index.html references /agent/-prefixed assets.");
