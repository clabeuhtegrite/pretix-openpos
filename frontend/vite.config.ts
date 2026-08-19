import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
// vitest's re-export of vite's defineConfig, so the `test` block typechecks;
// `vite build` reads this file exactly as before.
import { defineConfig } from "vitest/config";

// The version baked into the bundle is the plugin's own, read from the Python
// package: it is what /config/ reports back, and the two being one number is
// what lets a running till detect that the server was upgraded under it. A
// release therefore bumps pretix_openpos/__init__.py and nothing else.
//
// There used to be a fallback to package.json's own version for "a tree that
// moved". Nothing ever moved, and the fallback quietly drifted three releases
// behind — so a build that cannot read the real version now fails here rather
// than shipping a till that will offer an update no reload can ever apply.
const initPy = readFileSync(
  new URL("../pretix_openpos/__init__.py", import.meta.url),
  "utf8",
);
const version = /__version__\s*=\s*"([^"]+)"/.exec(initPy)?.[1];
if (!version) {
  throw new Error(
    "Could not read __version__ from pretix_openpos/__init__.py; the bundle " +
      "would carry a version the server does not recognise.",
  );
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
