import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import { repairRetellLifecycle } from "./server/phone/retell-lifecycle.mjs";

const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve("retell-client-js-sdk/package.json"));
const lifecycle = resolve(sdkRoot, "src/session/base-session.ts");

export default defineConfig({
  publicDir: false,
  resolve: { alias: { "retell-client-js-sdk": resolve(sdkRoot, "src/index.ts") } },
  plugins: [{
    name: "retell-gateway-lifecycle",
    enforce: "pre",
    transform(source, id) { return id === lifecycle ? repairRetellLifecycle(source) : null; },
  }],
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
