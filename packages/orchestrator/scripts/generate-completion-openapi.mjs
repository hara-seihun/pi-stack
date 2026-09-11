import { writeFileSync } from "node:fs";
import { COMPLETION_OPENAPI } from "../dist/completion-openapi.js";
writeFileSync(new URL("../docs/completions.openapi.json", import.meta.url), `${JSON.stringify(COMPLETION_OPENAPI, null, 2)}\n`);
