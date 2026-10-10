import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { devAllowedHosts } from "./dev-hosts";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  base: "./",
  plugins: [react(), {
    name: 'pi-release-revision',
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { src: './release-revision.js' }, injectTo: 'head-prepend' }];
    },
    generateBundle() {
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
      this.emitFile({ type: 'asset', fileName: 'release-revision.js', source: `globalThis.__PI_STACK_RELEASE_REVISION__=${JSON.stringify(revision)};\n` });
    },
    configureServer(server) {
      server.middlewares.use('/release-revision.js', (_request, response) => {
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
        response.setHeader('Content-Type', 'application/javascript');
        response.setHeader('Cache-Control', 'no-store');
        response.end(`globalThis.__PI_STACK_RELEASE_REVISION__=${JSON.stringify(revision)};\n`);
      });
    },
  }],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    allowedHosts: devAllowedHosts(process.env.PI_REMOTE_DEV_ALLOWED_HOSTS),
    proxy: { "/v1": { target: "http://127.0.0.1:8788", changeOrigin: true } },
  },
  define: { __PI_REMOTE_REVISION__: 'globalThis.__PI_STACK_RELEASE_REVISION__' },
  build: {
    outDir: resolve(import.meta.dirname, "web/dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "web/index.html"),
        voice: resolve(import.meta.dirname, "web/voice.html"),
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
