import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  define: {
    __MEET_AVATAR__: JSON.stringify(`data:image/png;base64,${readFileSync(resolve(import.meta.dirname, "web/public/kenan.png")).toString("base64")}`),
  },
  build: {
    outDir: resolve(import.meta.dirname, "web/dist"),
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, "web/src/meet/adapter.ts"),
      formats: ["es"],
      fileName: () => "meet-adapter.js",
    },
  },
});
