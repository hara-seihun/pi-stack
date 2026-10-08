import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{source: string, destination: string, kind: "file"} | {
 *   source: string, destination: string, kind: "tree", dereference?: boolean,
 *   generated?: boolean, required?: string[], entrypoints?: string[], executables?: string[]
 * }} RemoteResource
 */
// Paths inside each copied resource are relative to its release destination.
/** @type {RemoteResource[]} */
export const remoteResources = [
  ...["lib", "release-checkout", "meeting-census", "smoke", "one-kenan-activate"].map(name => ({
    source: `deploy/${name}`, destination: `deploy/${name}`, kind: "file",
  })),
  { source: "apps/remote/package.json", destination: "package.json", kind: "file" },
  { source: "apps/remote/meeting-runtime.json", destination: "meeting-runtime.json", kind: "file" },
  { source: "apps/remote/data-contract.json", destination: "data-contract.json", kind: "file" },
  {
    source: "apps/remote/server", destination: "server", kind: "tree",
    required: ["voice/delegation-policy.md", "meet/transcriber.ts", "write.ts", "file-edit.py", "phone/dist/retell-sdk.js"],
    entrypoints: ["main.ts", "router.ts", "person-cli.ts", "voice/service.ts", "rooms-main.ts", "meet/runtime-main.ts"],
    executables: ["pi-remote", "pi-phone", "pi-room", "pi-calendar", "pi-remote-launch", "pi-remote-supervise"],
  },
  { source: "apps/remote/shared", destination: "shared", kind: "tree" },
  { source: "apps/remote/skills", destination: "skills", kind: "tree", dereference: true, required: ["livedev/SKILL.md"] },
  {
    source: "apps/remote/web/dist", destination: "web/dist", kind: "tree", generated: true,
    required: ["index.html", "meet.html", "meet-adapter.js", "voice.html", "kenan.png"],
  },
  { source: "packages/kenan-root/src", destination: "kenan-root/src", kind: "tree", entrypoints: ["main.ts"] },
  { source: "packages/kenan-root/dist", destination: "kenan-root/dist", kind: "tree", generated: true },
  ...["instructions.md", "package.json"].map(name => ({
    source: `packages/kenan-root/${name}`, destination: `kenan-root/${name}`, kind: "file",
  })),
];

export const remoteEntrypoints = remoteResources.flatMap(resource => resource.kind === "file" ? [] :
  (resource.entrypoints ?? []).map(path => join(resource.destination, path)));
export const remoteExecutables = remoteResources.flatMap(resource => resource.kind === "file" ? [] :
  (resource.executables ?? []).map(path => join(resource.destination, path)));
export const remoteRequiredFiles = remoteResources.flatMap(resource => resource.kind === "file"
  ? [resource.destination]
  : [...(resource.required ?? []), ...(resource.entrypoints ?? []), ...(resource.executables ?? [])]
    .map(path => join(resource.destination, path)));

/** @param {string} root @param {string} release */
export function stageRemoteResources(root, release) {
  for (const resource of remoteResources) {
    const destination = join(release, resource.destination);
    try {
      mkdirSync(resource.kind === "tree" ? destination : dirname(destination), { recursive: true });
    } catch (error) {
      return { ok: false, error: { kind: "filesystem", destination, message: String(error) } };
    }
    const result = spawnSync("rsync", [
      resource.kind === "tree" && resource.dereference === true ? "-aL" : "-a", "--chmod=D755,Fu=rwX,Fgo=rX",
      join(root, resource.source) + (resource.kind === "tree" ? "/" : ""), destination,
    ], { stdio: "inherit" });
    if (result.error) return { ok: false, error: { kind: "spawn", message: result.error.message } };
    if (result.status !== 0) return { ok: false, error: { kind: "copy", source: resource.source, status: result.status, signal: result.signal } };
  }
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) {
    console.error("usage: deploy/remote-resources.mjs CHECKOUT RELEASE");
    process.exit(64);
  }
  const result = stageRemoteResources(resolve(process.argv[2]), resolve(process.argv[3]));
  if (!result.ok) {
    console.error("Pi Remote resource staging failed:", result.error);
    process.exit(1);
  }
}
