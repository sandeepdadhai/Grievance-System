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
    port: 3001,
    strictPort: true,
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "pv-0d6824cb439b-4c365483-b8d9-4cb8-8121-180e5dee5e87.style.dev",
      "pv-0d6824cb439b-37793b5c-889f-4531-9929-0158ec023a2b.style.dev",
      "pv-0d6824cb439b-5e32cac3-d968-49b5-b0b3-924da5d6b9d9.style.dev",
    ],
    proxy: {
      "/api": { target: "http://127.0.0.1:4100", changeOrigin: false },
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
});
