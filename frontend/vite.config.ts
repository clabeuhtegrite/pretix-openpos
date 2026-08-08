import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

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
    __APP_VERSION__: JSON.stringify(pkg.version),
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
});
