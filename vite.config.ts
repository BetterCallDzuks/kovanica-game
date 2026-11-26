import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  root: ".",
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
