#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const heading = "## Pi Stack sensitive form outputs";
const policy = `${heading}

The matched native executable redacts sensitive form values before returning observations to this wrapper. Snapshot, value, text and HTML reads use classification markers such as \`[redacted: cc-number]\`. Protection includes cross-origin frames and shadow roots. Card number, expiry/month/year, CVC/CVV/security code, password and one-time-code inputs are sensitive; cardholder names (\`cc-name\`) remain readable. Live form values are not cleared or changed.

Arbitrary evaluation and screenshot/PDF capture on tabs containing detected sensitive controls are refused with \`SENSITIVE_OUTPUT_UNSUPPORTED\` before execution or artifact creation. Known sensitive tab state remains protected after controls disappear. Ordinary evaluation and captures on non-sensitive tabs remain supported. Continuous recording, tracing, profiling, HAR, streaming, inspect/expose and init-script routes are refused because future fills cannot be protected by a one-time check. Sensitive tabs additionally refuse state export, downloads, raw network/console/clipboard/storage observations and other unstructured page-data routes; use safe snapshots and typed getters. Protected native responses also protect this wrapper's \`outputPath\` saved results.

This is protection for DOM form controls, not a general secret scanner for caller-supplied code, arbitrary page data or downloaded files. Input arguments are still caller-visible. Use the private credential-fill transport for secret entry, not plaintext tool arguments. A running Pi process retains its executable generation: settle/reload the process to select an updated matched pair.
`;
const suffix = " Sensitive form values are redacted (including cross-origin frames); eval and screenshot/PDF on sensitive tabs, and continuous capture, return SENSITIVE_OUTPUT_UNSUPPORTED. Cardholder names remain readable. Use private credential fill for secret entry.";
const descriptionEnd = 'experimental `sourceLookup` / `networkSourceLookup` for candidates only.';

export function patchBrowserSensitivePolicy(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.name !== "pi-agent-browser-native" || manifest.version !== "0.6.6") throw new Error("Unsupported native browser wrapper for sensitive-output policy");
  const entry = join(root, "dist/extensions/agent-browser/index.js");
  const original = readFileSync(entry, "utf8");
  if (!original.includes(descriptionEnd + suffix)) {
    const needle = descriptionEnd + '",';
    if (original.split(needle).length !== 2) throw new Error("Native browser tool description anchor changed");
    writeFileSync(entry, original.replace(needle, descriptionEnd + suffix + '",'));
  }
  for (const relative of ["README.md", "docs/TOOL_CONTRACT.md", "docs/COMMAND_REFERENCE.md"]) {
    const path = join(root, relative);
    const source = readFileSync(path, "utf8");
    if (!source.includes(heading)) writeFileSync(path, `${source.trimEnd()}\n\n${policy}`);
    else if (!source.includes(policy)) throw new Error(`Sensitive-output policy differs in ${relative}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("usage: patch-browser-sensitive-policy.mjs NATIVE_PACKAGE_ROOT");
  patchBrowserSensitivePolicy(process.argv[2]);
}
