import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { recoverNativeSessionOwners } from "./managed-agent.mjs";
const [environment, unit] = process.argv.slice(2);
if (!environment || !/^pi-native-[a-f0-9-]+\.service$/.test(unit)) throw new Error("Invalid native recovery owner");
const recovered = await recoverNativeSessionOwners(dirname(environment), { unit, requireAbsent: true });
if (!recovered.ok) throw Object.assign(new Error(recovered.error.message), { code: recovered.error.code });
rmSync(environment, { force: true });
console.log(JSON.stringify({ unit, nativeCustody: "settled" }));
