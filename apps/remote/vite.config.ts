import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  plugins: [react()],
  define: { __PI_REMOTE_REVISION__: JSON.stringify(execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim()) },
  build: {
    outDir: resolve(import.meta.dirname, "web/dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "web/index.html"),
        voice: resolve(import.meta.dirname, "web/voice.html"),
      },
    },
  },
});
