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
    // jsdom rather than plain Node. Most of this app is screens, and a till's
    // worst bugs have been in what a cashier could actually press — so the
    // suite has to be able to render one. The pure-logic modules do not care
    // which environment they run in.
    //
    // jsdom is pinned to 26 in package.json: from 27 it is ESM-only, and
    // `require`-ing it fails on Node 20.18, which is what this is developed on
    // even though CI runs 22. A suite that only runs in CI is not a suite.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Call history is dropped between tests. Without it a test that counts
    // presses inherits the previous one's, which is a failure that looks like
    // a bug in the component and is not.
    clearMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Measured over the whole app, not only the files a test happened to
      // import: a component nobody tests must show up as the zero it is.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/vite-env.d.ts",
        // Three lines of createRoot, and mounting it under test would prove
        // nothing that rendering App directly does not.
        "src/main.tsx",
        // Type declarations only.
        "src/types.ts",
      ],
      // A floor, set just under what the suite actually reaches, so an
      // ordinary refactor does not fail the build but deleting a test's worth
      // of coverage does. Raise it when the real number rises; never lower it
      // to make a run go green.
      thresholds: {
        statements: 96,
        branches: 92,
        functions: 94,
        lines: 98,
      },
    },
  },
});
