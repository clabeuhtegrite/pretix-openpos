import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
// vitest's re-export of vite's defineConfig, so the `test` block typechecks;
// `vite build` reads this file exactly as before.
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// The version baked into the bundle is the plugin's own, read from the Python
// package: it is what /config/ reports back, and the two being one number is
// what lets a running till detect that the server was upgraded under it. A
// release therefore bumps pretix_openpos/__init__.py and nothing else;
// package.json only serves as a fallback for a tree that moved.
let version = pkg.version;
try {
  const initPy = readFileSync(
    new URL("../pretix_openpos/__init__.py", import.meta.url),
    "utf8",
  );
  version = /__version__\s*=\s*"([^"]+)"/.exec(initPy)?.[1] ?? pkg.version;
} catch {
  // Building outside the plugin checkout: keep the package.json version.
}

// The bundle is served by Django as a static file and referenced from a
// hand-written template with {% static %} tags. That means filenames have to be
// stable rather than content-hashed: cache busting is pretix' job, through its
// ManifestStaticFilesStorage, and letting Django own it keeps the template from
// having to be regenerated on every build.
export default defineConfig({
  plugins: [react()],
  base: "/static/pretix_openpos/pwa/",
  // Reported to pretix when the device pairs, so the organizer can see which
  // till is running which build from the device list.
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: "../pretix_openpos/static/pretix_openpos/pwa",
    emptyOutDir: true,
    // A till has a handful of screens; splitting them costs a round trip on a
    // venue wifi and saves nothing.
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "app-[name].js",
        assetFileNames: "app.[ext]",
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
  test: {
    // Plain Node plus a localStorage shim: the tested modules are pure logic,
    // and the one browser API they touch is the Storage contract.
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
  },
});
