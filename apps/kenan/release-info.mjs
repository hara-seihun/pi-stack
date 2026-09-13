#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

export function releaseInfo() {
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", timeout: 10_000 }).trim();
  if (git("rev-parse", "--is-shallow-repository") !== "false") {
    throw new Error("Android release identity needs complete Git history. Run git fetch --unshallow before building or publishing.");
  }
  const revision = git("rev-parse", "HEAD");
  const count = Number(git("rev-list", "--count", revision));
  const versionCode = 1000 + count;
  if (!/^[a-f0-9]{40}$/.test(revision) || !Number.isSafeInteger(count) || count < 1 || versionCode > 2_100_000_000) {
    throw new Error("Git history cannot produce a valid Android release identity.");
  }
  const { appId: applicationId } = JSON.parse(readFileSync(resolve(directory, "capacitor.config.json"), "utf8"));
  if (applicationId !== "works.kenan.piremote.kenan") throw new Error("Android application ID must keep matching the installed Kenan app.");
  return { revision, versionCode, applicationId };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(releaseInfo()));
}
