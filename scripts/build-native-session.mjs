import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 3 || !process.argv[2]) {
  console.error('usage: node scripts/build-native-session.mjs OUTPUT_FILE');
  process.exit(64);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2]);
const result = buildSync({
  entryPoints: [join(root, 'packages/orchestrator/src/threads/native-session.ts')],
  outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: {
    'pi-orchestrator/history': join(root, 'packages/orchestrator/src/threads/history.mjs'),
    'pi-orchestrator/anthropic-narration': join(root, 'packages/orchestrator/src/threads/anthropic-narration.mjs'),
  },
  metafile: true, write: false,
});
const missing = Object.values(result.metafile.outputs).flatMap(item => item.imports)
  .filter(item => item.external && /^pi-(?:orchestrator|remote)(?:\/|$)/.test(item.path));
if (missing.length) throw new Error(`Native session closure has external workspace imports: ${missing.map(item => item.path).join(', ')}`);
for (const file of result.outputFiles) {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.contents);
}
