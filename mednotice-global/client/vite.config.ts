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
    allowedHosts: ["pv-0d6824cb439b-62f36001-a323-4ac5-a290-257d589fdddd.style.dev", "localhost", "127.0.0.1", "169.254.77.2"],
    proxy: {
      "/api": { target: "http://127.0.0.1:4000", changeOrigin: false },
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
});
