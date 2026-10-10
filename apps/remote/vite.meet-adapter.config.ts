import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  define: {
    __MEET_LOGO__: JSON.stringify(`data:image/svg+xml;base64,${readFileSync(resolve(import.meta.dirname, "web/public/liminal-logo.svg")).toString("base64")}`),
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
