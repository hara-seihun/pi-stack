import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { webResponse } from "../server/files";
import { appBase, appPath, appStorage, appStorageKey } from "./src/app-path";
import { RouterAuth } from "./src/router-auth";

test("pages, artwork, and browser state belong to the document's mount", () => {
  for (const prefix of ["", "/pi-stack", "/tools/pi-stack"]) {
    for (const page of ["", "index.html", "meet.html?room=room-1", "voice.html"]) {
      const href = `https://router.test${prefix}/${page}`;
      expect(appBase(href)).toBe(prefix);
      expect(appPath("/kenan.png", href)).toBe(`${prefix}/kenan.png`);
      expect(appPath("meet.html", href)).toBe(`${prefix}/meet.html`);
      expect(appPath("", href)).toBe(`${prefix}/`);
      expect(appStorageKey("pi-remote-person", href)).toBe(prefix ? `${prefix}:pi-remote-person` : "pi-remote-person");
    }
  }
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const root = appStorage(storage, "https://router.test/");
  const mounted = appStorage(storage, "https://router.test/pi-stack/");
  const first = new RouterAuth(root, root, () => {});
  const second = new RouterAuth(mounted, mounted, () => {});
  first.setPerson("kenan"); first.accept("kenan", "root-session");
  second.setPerson("kenan"); second.accept("kenan", "mounted-session");
  expect(new RouterAuth(root, root, () => {}).session).toBe("root-session");
  expect(new RouterAuth(mounted, mounted, () => {}).session).toBe("mounted-session");
  second.clear();
  expect(new RouterAuth(root, root, () => {}).session).toBe("root-session");
});

test("one built frontend serves root and prefix-stripped pages, assets, fonts and manifest", async () => {
  const output = mkdtempSync(resolve(tmpdir(), "pi-remote-web-path-"));
  try {
    const build = Bun.spawnSync([process.execPath, "run", resolve(import.meta.dir, "../node_modules/vite/bin/vite.js"), "build", "--outDir", output], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    expect({ code: build.exitCode, error: build.exitCode ? build.stderr.toString() : "" }).toEqual({ code: 0, error: "" });
    for (const prefix of ["", "/pi-stack"]) {
      const checked = new Set<string>();
      const asset = async (value: string, parent: URL): Promise<void> => {
        if (/^(data:|#)/.test(value)) return;
        const url = new URL(value, parent);
        expect(url.origin).toBe(parent.origin);
        expect(url.pathname.startsWith(`${prefix}/`)).toBe(true);
        if (checked.has(url.pathname)) return;
        checked.add(url.pathname);
        const response = webResponse(output, url.pathname.slice(prefix.length), "GET");
        expect(response?.status).toBe(200);
        if (url.pathname.endsWith(".css")) {
          const css = await response!.text();
          for (const match of css.matchAll(/url\(["']?([^\s"')]+)["']?\)/g)) await asset(match[1]!, url);
        }
      };
      for (const page of ["", "index.html", "meet.html", "voice.html"]) {
        const url = new URL(`https://router.test${prefix}/${page}`);
        const response = webResponse(output, url.pathname.slice(prefix.length), "GET");
        expect(response?.status).toBe(200);
        for (const match of (await response!.text()).matchAll(/(?:src|href)="([^"]+)"/g)) await asset(match[1]!, url);
      }
      // Neither the Markdown renderer nor KaTeX is in the page: markdown-it,
      // texmath and the delimiter shim arrive with the first Markdown block
      // (src/markdown-engine.ts), KaTeX, its stylesheet and that stylesheet's
      // fonts with the first formula (src/math-engine.ts).
      const mount = new URL(`https://router.test${prefix}/`);
      for (const lazy of ["vendor/katex.min.js", "vendor/katex/katex.min.css", "vendor/markdown-it.min.js", "vendor/texmath.js", "vendor/texmath.css", "vendor/pi-markdown-compat.js"]) await asset(lazy, mount);
      const url = new URL(`https://router.test${prefix}/manifest.webmanifest`);
      const manifest = await webResponse(output, "/manifest.webmanifest", "GET")!.json();
      expect(new URL(manifest.start_url, url).pathname).toBe(`${prefix}/`);
      expect(new URL(manifest.scope, url).pathname).toBe(`${prefix}/`);
      for (const icon of manifest.icons) await asset(icon.src, url);
      expect(checked.size).toBeGreaterThan(20);
    }
  } finally { rmSync(output, { recursive: true, force: true }); }
});
