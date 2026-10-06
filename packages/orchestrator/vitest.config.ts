import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = ["./", "../kenan-memory/"].flatMap(directory => {
  const root = new URL(directory, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  return Object.entries(manifest.exports).flatMap(([subpath, conditions]) => {
    const source = (conditions as { bun?: string }).bun;
    const name = manifest.name + (subpath === "." ? "" : subpath.slice(1));
    return source ? [{ find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), replacement: fileURLToPath(new URL(source, root)) }] : [];
  });
});

export default defineConfig({
  resolve: { alias },
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
});
