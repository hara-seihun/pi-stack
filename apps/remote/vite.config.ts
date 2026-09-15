import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    allowedHosts: ["gmktec.taild09774.ts.net"],
    proxy: { "/v1": { target: "http://127.0.0.1:8788", changeOrigin: true } },
  },
  define: { __PI_REMOTE_REVISION__: JSON.stringify(execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim()) },
  build: {
    outDir: resolve(import.meta.dirname, "web/dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "web/index.html"),
        voice: resolve(import.meta.dirname, "web/voice.html"),
        meet: resolve(import.meta.dirname, "web/meet.html"),
      },
    },
  },
});
