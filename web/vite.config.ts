import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// App servita da FastAPI (StaticFiles su "/"), niente CDN a runtime:
// asset con path relativi cosi' funzionano da qualunque mount point.
// Porta backend per il proxy di sviluppo: override con BACKEND_PORT (default 8000).
const backendPort = process.env.BACKEND_PORT || "8000";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
  },
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${backendPort}`,
      "/ws": { target: `ws://127.0.0.1:${backendPort}`, ws: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
