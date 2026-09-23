import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_USAGE, COMMANDS } from "../dist/commands.js";
import { SCHEMA } from "../dist/store.js";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const tables=[...SCHEMA.matchAll(/CREATE TABLE ([a-z_]+)/g)].map((match)=>match[1]);
const text=`# Generated reference

Run \`npm run docs --workspace=pi-orchestrator\` after changing commands or durable tables.

## Commands

${COMMANDS.map(([name,summary])=>`- \`${name}\`: ${summary}.`).join("\n")}

## Account operations

\`\`\`text
${ACCOUNT_USAGE}
\`\`\`

## Durable tables

${tables.map((table)=>`- \`${table}\``).join("\n")}
`;
writeFileSync(resolve(root,"docs/reference.md"),text);
