#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

// Tracked inputs that change the native shell. A web bundle built from a commit
// with the same shell identity runs on an installed app built from any other
// such commit, so it can be delivered over the air instead of as a new APK.
// Unit tests are excluded: they never ship in the package.
const SHELL_PATHS = ["apps/kenan/android", "apps/kenan/capacitor.config.json", "apps/kenan/package.json"];
const SHELL_EXCLUDED = /^apps\/kenan\/android\/app\/src\/test\//;

export const VERSION_CODE_BASE = 10_000;

export function versionCodeFromCommitCount(count) {
  const versionCode = VERSION_CODE_BASE + count;
  if (!Number.isSafeInteger(count) || count < 1 || versionCode > 2_100_000_000) {
    throw new Error("Git history cannot produce a valid Android release identity.");
  }
  return versionCode;
}

// The compiled router URLs are native fields too: changing them must reach
// installed apps as an APK, never as a web bundle that leaves the old URL in place.
export function bootstrapConfiguration(properties) {
  const value = key => (properties.match(new RegExp(`^[ \\t]*${key}[ \\t]*[=:][ \\t]*(.*)$`, "m"))?.[1] ?? "")
    .replace(/\\(.)/g, "$1").trim().replace(/\/+$/, "");
  return `router=${value("piRemoteRouterUrl")}\npublic=${value("piRemotePublicRouterUrl")}`;
}

export function nativeDependencyClosure(git, revision) {
  const { packages } = JSON.parse(git("show", `${revision}:package-lock.json`));
  const app = packages?.["apps/kenan"];
  if (!app) throw new Error("Android dependency lock is missing the Kenan workspace.");
  const entries = new Map();
  const visit = (from, name, optional) => {
    let directory = from;
    let path;
    for (;;) {
      const candidate = posix.join(directory, "node_modules", name);
      if (packages[candidate]) { path = candidate; break; }
      if (!directory) break;
      directory = posix.dirname(directory);
      if (directory === ".") directory = "";
    }
    if (!path) {
      if (optional) return;
      throw new Error(`Android dependency lock cannot resolve ${name} from ${from}`);
    }
    if (entries.has(path)) return;
    const dependency = packages[path];
    if (dependency.link) throw new Error(`Android dependency is not immutable: ${path}`);
    entries.set(path, dependency);
    const optionalDependencies = dependency.optionalDependencies ?? {};
    for (const child of Object.keys({ ...dependency.dependencies, ...optionalDependencies }).sort()) {
      visit(path, child, Object.hasOwn(optionalDependencies, child));
    }
  };
  for (const name of Object.keys({ ...app.dependencies, ...app.devDependencies }).sort()) visit("apps/kenan", name, false);
  return JSON.stringify([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

export function shellIdentity(git, revision, bootstrap = "") {
  const entries = git("ls-tree", "-r", "--full-tree", revision, "--", ...SHELL_PATHS).split("\n").filter(Boolean)
    .filter(line => !SHELL_EXCLUDED.test(line.split("\t")[1] ?? ""));
  if (!entries.length) throw new Error("Android shell sources are missing from the revision.");
  return createHash("sha256").update(entries.join("\n")).update(`\n${nativeDependencyClosure(git, revision)}\n${bootstrap}`).digest("hex").slice(0, 16);
}

export function releaseInfo() {
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", timeout: 10_000 }).trim();
  if (git("rev-parse", "--is-shallow-repository") !== "false") {
    throw new Error("Android release identity needs complete Git history. Run git fetch --unshallow before building or publishing.");
  }
  const revision = git("rev-parse", "HEAD");
  const count = Number(git("rev-list", "--count", revision));
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Git history cannot produce a valid Android release identity.");
  const versionCode = versionCodeFromCommitCount(count);
  const { appId: applicationId } = JSON.parse(readFileSync(resolve(directory, "capacitor.config.json"), "utf8"));
  if (applicationId !== "works.kenan.piremote.kenan") throw new Error("Android application ID must keep matching the installed Kenan app.");
  const properties = resolve(directory, "android/local.properties");
  const bootstrap = bootstrapConfiguration(existsSync(properties) ? readFileSync(properties, "utf8") : "");
  return { revision, versionCode, applicationId, shellId: shellIdentity(git, revision, bootstrap) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(releaseInfo()));
}
