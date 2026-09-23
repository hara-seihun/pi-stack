import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { devAllowedHosts } from "./dev-hosts";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    allowedHosts: devAllowedHosts(process.env.PI_REMOTE_DEV_ALLOWED_HOSTS),
    proxy: { "/v1": { target: "http://127.0.0.1:8788", changeOrigin: true } },
  },
  define: { __PI_REMOTE_REVISION__: JSON.stringify(execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim()) },
  build: {
    outDir: resolve(import.meta.dirname, "web/dist"),
    emptyOutDir: true,
    // `rollupOptions` is Vite 8's alias for `rolldownOptions`, and the only
    // spelling Vite 7 understands: web/app-path.test.ts builds this config with
    // the Vite that vitest pulls into the repo root, not the app's own Vite 8.
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "web/index.html"),
        voice: resolve(import.meta.dirname, "web/voice.html"),
        meet: resolve(import.meta.dirname, "web/meet.html"),
      },
      output: {
        // Three HTML entries share React, so Rolldown hoists it into a shared
        // chunk and names that chunk after whichever component it happened to
        // pick, which made the React bundle read as `SignInDialog-*.js`. Name it
        // for what it holds: the runtime stays cached across app deploys.
        codeSplitting: {
          groups: [{ name: "react", test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler|use-sync-external-store)[\\/]/ }],
        },
      },
    },
  },
});
