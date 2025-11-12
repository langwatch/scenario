/**
 * Vite configuration for Realtime Agent client
 *
 * Simple dev server for the browser demo.
 * Allows TypeScript imports and proper module resolution.
 */

import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    open: true,
    allowedHosts: true,
    cors: true,
    proxy: {
      "/token": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
