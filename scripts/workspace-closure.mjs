import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2];
if (!['build', 'check', 'remote-check', 'config-checker'].includes(mode)) throw new Error('usage: node scripts/workspace-closure.mjs build|check|remote-check|config-checker OUTPUT');
const areas = ['orchestrator', 'kenan-memory', 'kenan-root'];
const paths = {};
for (const area of areas) {
  const directory = join(root, 'packages', area);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  for (const [name, exported] of Object.entries(manifest.exports)) {
    const source = typeof exported === 'string' ? exported : exported.bun ?? exported.types;
    if (typeof source !== 'string') throw new Error(`Workspace export needs a source declaration: ${manifest.name}/${name}`);
    paths[name === '.' ? manifest.name : `${manifest.name}/${name.slice(2)}`] = [join(directory, source.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$/, '.ts'))];
  }
}
if (mode === 'config-checker') {
  if (!process.argv[3] || process.argv.length !== 4) throw new Error('config-checker requires an explicit output path');
  const temporary = mkdtempSync(join(tmpdir(), 'pi-config-checker-'));
  try {
    const builder = join(temporary, 'build.mjs');
    const runtimePaths = Object.fromEntries(Object.entries(paths).map(([name, values]) => [name, values.map(path => path.replace(/\.d\.mts$/, '.mjs').replace(/\.d\.cts$/, '.cjs'))]));
    writeFileSync(builder, `const paths = ${JSON.stringify(runtimePaths)};\nconst result = await Bun.build({entrypoints:[${JSON.stringify(join(root, 'deploy/core-check-config.ts'))}],target:'bun',plugins:[{name:'canonical-workspace',setup(build){build.onResolve({filter:/.*/},args=>paths[args.path]?{path:paths[args.path][0]}:undefined)}}]});\nif(!result.success || result.outputs.length!==1){console.error(result.logs);process.exit(1)}\nawait Bun.write(${JSON.stringify(resolve(process.argv[3]))}, result.outputs[0]);\n`);
    const result = spawnSync('bun', [builder], { stdio: 'inherit', timeout: 50000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Canonical config checker build failed: ${result.status}`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  process.exit(0);
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
const sources = areas.flatMap(area => files(join(root, 'packages', area, 'src')));
let inputs = sources.filter(path => /\.(?:ts|mts)$/.test(path));
if (mode === 'check') inputs.push(...files(join(root, 'packages/orchestrator/tests')).filter(path => /\.tsx?$/.test(path)), join(root, 'packages/orchestrator/vitest.config.ts'));
let compilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, skipLibCheck: true, resolveJsonModule: true, declaration: true,
  rootDir: mode === 'check' ? root : join(root, 'packages'), outDir: join(root, 'packages'), noEmit: mode === 'check',
  types: ['node', 'bun'], typeRoots: [join(root, 'node_modules/@types')], paths,
};
if (mode === 'remote-check') {
  const directory = join(root, 'apps/remote');
  const loaded = ts.readConfigFile(join(directory, 'tsconfig.json'), ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, directory);
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  inputs = parsed.fileNames;
  compilerOptions = { ...parsed.options, paths, rootDir: root, noEmit: true };
}
const host = ts.createCompilerHost(compilerOptions);
const program = ts.createProgram(inputs, compilerOptions, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
  process.exit(1);
}
if (mode === 'build') {
  mkdirSync(join(root, 'dist'), { recursive: true });
  const stage = mkdtempSync(join(root, 'dist', '.core-closure-'));
  try {
  const emitted = program.emit(undefined, (filename, text) => {
    const path = relative(join(root, 'packages'), filename);
    const match = /^(orchestrator|kenan-memory|kenan-root)\/src\/(.+)$/.exec(path);
    if (!match) {
      if (/^(orchestrator|kenan-memory|kenan-root)\/package\.json$/.test(path)) return;
      throw new Error(`Undeclared workspace output: ${path}`);
    }
    const destination = join(stage, match[1], match[2]);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, text);
  });
  if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error('Workspace closure emission failed');
  for (const source of sources.filter(path => /\.(?:mjs|cjs|json|d\.mts)$/.test(path))) {
    const path = relative(join(root, 'packages'), source).replace('/src/', '/');
    const destination = join(stage, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  for (const area of areas) {
    mkdirSync(join(stage, area), { recursive: true });
    const destination = join(root, 'packages', area, 'dist');
    rmSync(destination, { recursive: true, force: true });
    renameSync(join(stage, area), destination);
  }
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
console.log(`Pi shared workspace closure ${mode}: ${areas.join(', ')}`);
