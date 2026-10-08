import { readFileSync, statSync, accessSync, constants } from "node:fs";
import { providerSelection, loadProvider } from "./provider";

function fail(error: string): never { console.error(error); process.exit(1); }
if (process.argv.length !== 3 || !process.argv[2].startsWith("/")) fail("One absolute Phone configuration path is required");
let config;
try { config = JSON.parse(readFileSync(process.argv[2], "utf8")); }
catch { fail("Phone configuration could not be read or parsed"); }
if (!config || typeof config !== "object" || Array.isArray(config)) fail("Phone configuration object required");
if (typeof config.owner !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(config.owner)) fail("An explicit Phone owner is required");
for (const field of ["localPort", "publicPort"]) if (!Number.isInteger(config[field]) || config[field] < 1 || config[field] > 65535) fail("Explicit valid Phone listener ports are required");
if (config.localPort === config.publicPort) fail("Phone listeners require distinct ports");
for (const field of ["voiceUrl", "dispatcherUrl"]) {
  try {
    const url = new URL(config[field]);
    if (typeof config[field] !== "string" || url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("Voice and dispatcher must have explicit loopback HTTP origins");
  } catch { fail("Voice and dispatcher must have explicit loopback HTTP origins"); }
}
try {
  if (typeof config.chromium !== "string" || !config.chromium.startsWith("/") || !statSync(config.chromium).isFile()) fail("An absolute Chromium executable is required");
  accessSync(config.chromium, constants.X_OK);
} catch { fail("Configured Chromium executable is unavailable"); }
let adminToken = "", silentToken = "";
for (const field of ["adminTokenFile", "silentTokenFile"]) {
  try {
    if (typeof config[field] !== "string" || !config[field].startsWith("/")) fail("Absolute owner-only Phone token files are required");
    const stat = statSync(config[field]);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) fail("Phone token files must be owner-only regular files");
    const token = readFileSync(config[field], "utf8").trim();
    if (field === "silentTokenFile") silentToken = token; else adminToken = token;
  } catch { fail("Phone token files could not be read"); }
}
if (adminToken.length < 32 || !/^[a-f0-9]{64}$/.test(silentToken) || adminToken === silentToken) fail("Distinct administrative and 256-bit silent transport capabilities are required");
const selected = providerSelection(config);
if (!selected.ok) fail(selected.error);
const provider = loadProvider("retell-takeover", config);
if (!provider.ok) fail(provider.error);
if (config.callingEnabled) {
  const ready = await provider.value.client.verify();
  if (!ready.ok) fail(ready.error);
}
