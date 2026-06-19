import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and serves the built assets from ../dist.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/target/**",
        "**/node_modules/**",
      ],
    },
  },
  build: {
    outDir: "dist",
    target: "es2021",
  },
});
