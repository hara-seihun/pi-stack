import { readFileSync } from "node:fs";
import { providerSelection, loadProvider } from "./provider";

let config;
try { config = JSON.parse(readFileSync(process.argv[2] ?? "/etc/pi-stack/phone.json", "utf8")); }
catch { console.error("Phone configuration could not be read or parsed"); process.exit(1); }
if (!config || typeof config !== "object" || Array.isArray(config)) { console.error("Phone configuration object required"); process.exit(1); }
const selected = providerSelection(config);
if (!selected.ok) { console.error(selected.error); process.exit(1); }
if (selected.value !== null) {
  const provider = loadProvider(selected.value, config);
  if (!provider.ok) { console.error(provider.error); process.exit(1); }
}
