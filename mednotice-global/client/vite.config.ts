import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "."),
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: ["pv-6dacb6ad6961-a8532833-2aa5-491b-8f3c-05f00c0857da.style.dev", "localhost", "127.0.0.1"],
    proxy: {
      "/api": { target: "http://127.0.0.1:4000", changeOrigin: false },
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
});
