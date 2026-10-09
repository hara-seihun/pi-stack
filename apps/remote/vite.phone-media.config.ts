import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, "server/phone/dist"),
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "server/phone/retell-sdk.ts"),
      formats: ["es"],
      fileName: () => "retell-sdk.js",
    },
  },
});
