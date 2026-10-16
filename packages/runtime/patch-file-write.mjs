import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const marker = "// PiStack file-write-guard-v1\n";
const overwriteSchema = 'overwrite: Type.Optional(Type.Object({ expectedBytes: Type.Integer({ minimum: 0 }), reason: Type.String({ minLength: 1 }) })),\n';
const bundleOverride = 'overwrite:typebox_exports.Optional(typebox_exports.Object({expectedBytes:typebox_exports.Integer({minimum:0}),reason:typebox_exports.String({minLength:1})})),';
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Pinned file tool anchor changed: ${before.slice(0, 120)}`);
  return source.replace(before, after);
}

export function patchSdkWrite(source) {
  if (source.startsWith(marker)) return source;
  source = replace(source, '    content: Type.String({ description: "Content to write to the file" }),', '    content: Type.String({ description: "Content to write to the file" }),\n    ' + overwriteSchema);
  source = replace(source, '    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),', '    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),\n    fileSize: localFileSize,');
  source = replace(source, '{ path, content }, signal', '{ path, content, overwrite }, signal');
  source = replace(source, '                // Write the file contents.\n                await ops.writeFile(absolutePath, content);', '                const inspection = await inspectWrite(absolutePath, content, overwrite, ops.fileSize);\n                throwIfAborted();\n                requireWriteInspection(inspection);\n                await ops.writeFile(absolutePath, content);');
  source = source.replace('Automatically creates parent directories.', 'Automatically creates parent directories. Refuses blanking existing nonempty files or shrinking by at least 4096 bytes to half or less; deliberate overwrite requires overwrite:{expectedBytes,reason}. Use append to add bytes.');
  return marker + 'import { inspectWrite, localFileSize, requireWriteInspection } from "../../file-write-guard.mjs";\n' + source;
}

export function patchHarnessWrite(source) {
  if (source.startsWith(marker)) return source;
  source = replace(source, '    content: Type.String({ description: "Content to write to the file" }),', '    content: Type.String({ description: "Content to write to the file" }),\n    ' + overwriteSchema);
  source = replace(source, '{ path, content }, _onUpdate', '{ path, content, overwrite }, _onUpdate');
  source = replace(source, '                getOrThrow(await env.writeFile(absolutePath, content, context));', '                const inspection = await inspectWrite(absolutePath, content, overwrite, path => environmentFileSize(env, path, context));\n                if (context.abortSignal?.aborted) throw new Error("Operation aborted");\n                requireWriteInspection(inspection);\n                getOrThrow(await env.writeFile(absolutePath, content, context));');
  return marker + 'import { inspectWrite, environmentFileSize, requireWriteInspection } from "../../file-write-guard.mjs";\n' + source;
}

const appendSource = `import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";
import { resolveToCwd } from "./path-utils.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
const appendSchema = Type.Object({ path: Type.String({ description: "File to append to (relative or absolute)" }), content: Type.String({ description: "Exact bytes to append as UTF-8; no newline is inserted" }) });
const local = { mkdir: dir => mkdir(dir, { recursive: true }), appendFile: (path, content) => appendFile(path, content, "utf8") };
export function createAppendToolDefinition(cwd, options) {
  const ops = options?.operations ?? local;
  return { name: "append", label: "append", description: "Append exact UTF-8 content without reading or replacing existing bytes. Creates file and parents if missing. Inserts no newline. Same-process file mutations are queued; cross-process appends use O_APPEND.", promptSnippet: "Append content to files without replacing existing bytes", promptGuidelines: ["Use append for log entries and additions; include any desired newline in content."], parameters: appendSchema,
    async execute(_id, { path, content }, signal, _onUpdate, ctx) {
      const absolute = resolveToCwd(path, ctx?.cwd || cwd);
      return withFileMutationQueue(absolute, async () => {
        const check = () => { if (signal?.aborted) throw new Error("Operation aborted"); };
        check();
        if (typeof ops.appendFile !== "function") throw Object.assign(new Error("APPEND_UNSUPPORTED: Operations must provide appendFile"), { code: "APPEND_UNSUPPORTED" });
        await ops.mkdir(dirname(absolute)); check();
        await ops.appendFile(absolute, content); check();
        return { content: [{ type: "text", text: \`Successfully appended to \${path}\` }], details: undefined };
      });
    }
  };
}
export function createAppendTool(cwd, options) { return wrapToolDefinition(createAppendToolDefinition(cwd, options)); }
`;
const appendDeclaration = `import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
declare const appendSchema: Type.TObject<{ path: Type.TString; content: Type.TString }>;
export type AppendToolInput = Static<typeof appendSchema>;
export interface AppendOperations { mkdir: (dir: string) => Promise<unknown>; appendFile: (path: string, content: string) => Promise<void>; }
export interface AppendToolOptions { operations?: AppendOperations; }
export declare function createAppendToolDefinition(cwd: string, options?: AppendToolOptions): ToolDefinition<typeof appendSchema, undefined>;
export declare function createAppendTool(cwd: string, options?: AppendToolOptions): AgentTool<typeof appendSchema>;
`;

function sdkIndex(source) {
  source = replace(source, '    "write",', '    "write",\n    "append",');
  source = source.replaceAll('        case "write":\n            return createWriteToolDefinition(cwd, options?.write);', '        case "append":\n            return createAppendToolDefinition(cwd, options?.append);\n        case "write":\n            return createWriteToolDefinition(cwd, options?.write);');
  source = source.replaceAll('        case "write":\n            return createWriteTool(cwd, options?.write);', '        case "append":\n            return createAppendTool(cwd, options?.append);\n        case "write":\n            return createWriteTool(cwd, options?.write);');
  source = source.replaceAll('        createWriteToolDefinition(cwd, options?.write),', '        createWriteToolDefinition(cwd, options?.write),\n        createAppendToolDefinition(cwd, options?.append),');
  source = source.replaceAll('        createWriteTool(cwd, options?.write),', '        createWriteTool(cwd, options?.write),\n        createAppendTool(cwd, options?.append),');
  source = source.replaceAll('        write: createWriteToolDefinition(cwd, options?.write),', '        write: createWriteToolDefinition(cwd, options?.write),\n        append: createAppendToolDefinition(cwd, options?.append),');
  source = source.replaceAll('        write: createWriteTool(cwd, options?.write),', '        write: createWriteTool(cwd, options?.write),\n        append: createAppendTool(cwd, options?.append),');
  return marker + 'export { createAppendTool, createAppendToolDefinition } from "./append.js";\nimport { createAppendTool, createAppendToolDefinition } from "./append.js";\n' + source;
}

function bundled(source) {
  source = replace(source, 'var writeSchema=typebox_exports.Object({', 'var writeSchema=typebox_exports.Object({' + bundleOverride);
  source = replace(source, 'var writeSchema2=typebox_exports.Object({', 'var writeSchema2=typebox_exports.Object({' + bundleOverride);
  source = replace(source, '{path:path14,content},_onUpdate,{env:env2},_invocation,context)', '{path:path14,content,overwrite},_onUpdate,{env:env2},_invocation,context)');
  source = replace(source, 'if(getOrThrow(await env2.writeFile(absolutePath,content,context)),context.abortSignal?.aborted)', 'let inspection=await piInspectWrite(absolutePath,content,overwrite,path=>piEnvironmentFileSize(env2,path,context));if(context.abortSignal?.aborted)throw new Error("Operation aborted");piRequireWriteInspection(inspection);if(getOrThrow(await env2.writeFile(absolutePath,content,context)),context.abortSignal?.aborted)');
  source = replace(source, '{path:path14,content},signal,_onUpdate,ctx)', '{path:path14,content,overwrite},signal,_onUpdate,ctx)');
  source = replace(source, 'await ops.writeFile(absolutePath,content),throwIfAborted()', 'await piGuardBundledWrite(ops,defaultWriteOperations,absolutePath,content,overwrite,throwIfAborted),throwIfAborted()');
  source = replace(source, 'write:createWriteToolDefinition(cwd,options?.write),', 'write:createWriteToolDefinition(cwd,options?.write),append:piBundledAppend(cwd,options?.append),');
  source = replace(source, 'createWriteTool2(cwd,options?.write)]', 'createWriteTool2(cwd,options?.write),wrapToolDefinition(piBundledAppend(cwd,options?.append))]');
  source = replace(source, 'defaultActiveToolNames=["read","bash","edit","write"]', 'defaultActiveToolNames=["read","bash","edit","write","append"]');
  source = replace(source, 'Object.keys(this._baseToolsOverride):["read","bash","edit","write"]', 'Object.keys(this._baseToolsOverride):["read","bash","edit","write","append"]');
  const extra = `\nasync function piGuardBundledWrite(ops,local,path,content,overwrite,check){const inspected=await piInspectWrite(path,content,overwrite,ops===local?piLocalFileSize:ops.fileSize);check();piRequireWriteInspection(inspected);await ops.writeFile(path,content)}
function piBundledAppend(cwd,options){const tool=piCreateAppendToolDefinition(cwd,options);const execute=tool.execute;return {...tool,execute:async function(id,args,signal,onUpdate,ctx){return withFileMutationQueue2(resolveToCwd(args.path,ctx?.cwd||cwd),()=>execute(id,args,signal,onUpdate,ctx))}}}
`;
  return marker + 'import { inspectWrite as piInspectWrite, localFileSize as piLocalFileSize, environmentFileSize as piEnvironmentFileSize, requireWriteInspection as piRequireWriteInspection } from "../../file-write-guard.mjs";\nimport { createAppendToolDefinition as piCreateAppendToolDefinition } from "../../core/tools/append.js";\n' + source + extra;
}

export function patchFileWriteCopies(nodeModules) {
  const coding = join(nodeModules, "@earendil-works/pi-coding-agent/dist");
  const core = join(nodeModules, "@earendil-works/pi-agent-core/dist");
  const pending = new Map();
  const apply = (path, transform) => { const source = readFileSync(path, "utf8"); pending.set(path, source.startsWith(marker) ? source : transform(source)); };
  apply(join(coding, "core/tools/write.js"), patchSdkWrite);
  apply(join(core, "harness/tools/write.js"), patchHarnessWrite);
  apply(join(coding, "core/tools/index.js"), sdkIndex);
  apply(join(coding, "core/agent-session.js"), source => marker + replace(source, ': ["read", "bash", "edit", "write"];', ': ["read", "bash", "edit", "write", "append"];'));
  apply(join(coding, "core/sdk.js"), source => marker + 'export { createAppendTool } from "./tools/append.js";\n' + replace(source, 'const defaultActiveToolNames = ["read", "bash", "edit", "write"];', 'const defaultActiveToolNames = ["read", "bash", "edit", "write", "append"];'));
  apply(join(coding, "index.js"), source => marker + 'export { createAppendTool, createAppendToolDefinition } from "./core/tools/append.js";\n' + source);
  pending.set(join(coding, "core/tools/append.js"), appendSource);
  pending.set(join(coding, "core/tools/append.d.ts"), appendDeclaration);
  const originalHarness = readFileSync(join(core, "harness/tools/write.js"), "utf8");
  pending.set(join(core, "harness/tools/append.js"), originalHarness.startsWith(marker)
    ? readFileSync(join(core, "harness/tools/append.js"), "utf8")
    : originalHarness.replaceAll('writeSchema', 'appendSchema').replaceAll('createWriteTool', 'createAppendTool').replaceAll('"write"', '"append"').replaceAll('env.writeFile', 'env.appendFile').replace('Write content', 'Append content').replace('overwrites if it does', 'preserves existing bytes if it does').replace('Successfully wrote', 'Successfully appended'));
  apply(join(core, "harness/tools/index.js"), source => marker + 'export { createAppendTool } from "./append.js";\n' + source);
  const harnessDeclaration = readFileSync(join(core, "harness/tools/write.d.ts"), "utf8");
  pending.set(join(core, "harness/tools/append.d.ts"), harnessDeclaration.startsWith(marker)
    ? readFileSync(join(core, "harness/tools/append.d.ts"), "utf8")
    : harnessDeclaration.replaceAll('writeSchema', 'appendSchema').replaceAll('WriteToolInput', 'AppendToolInput').replaceAll('createWriteTool', 'createAppendTool'));
  apply(join(core, "harness/tools/write.d.ts"), source => marker + source.replace('    content: Type.TString;', '    content: Type.TString;\n    overwrite: Type.TOptional<Type.TObject<{ expectedBytes: Type.TInteger; reason: Type.TString }>>;'));
  apply(join(core, "harness/tools/index.d.ts"), source => marker + 'export { createAppendTool, type AppendToolInput } from "./append.js";\n' + source);
  apply(join(coding, "core/tools/write.d.ts"), source => marker + source.replace('    content: Type.TString;', '    content: Type.TString;\n    overwrite: Type.TOptional<Type.TObject<{ expectedBytes: Type.TInteger; reason: Type.TString }>>;').replace('export interface WriteOperations {', 'export interface WriteOperations {\n    fileSize: (path: string) => Promise<{ ok: true; value: number | null } | { ok: false; error: { code: string; message: string } }>;'));
  for (const name of ["index.d.ts", "core/sdk.d.ts", "core/tools/index.d.ts"]) apply(join(coding, name), source => {
    if (name === "core/tools/index.d.ts") source = source.replace('"write" | "grep"', '"write" | "append" | "grep"').replace('    write?: WriteToolOptions;', '    write?: WriteToolOptions;\n    append?: AppendToolOptions;');
    return marker + `export { createAppendTool, createAppendToolDefinition, type AppendToolInput, type AppendToolOptions, type AppendOperations } from "${name === "index.d.ts" ? "./core/tools" : name === "core/sdk.d.ts" ? "./tools" : "."}/append.js";\n` + (name === "core/tools/index.d.ts" ? 'import type { AppendToolOptions } from "./append.js";\n' : '') + source;
  });
  const chunks = join(coding, "bundle/chunks");
  const targets = readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes('function createWriteToolDefinition(cwd,options)'));
  if (targets.length !== 1) throw new Error(`Pinned CLI write consumer count changed: ${targets.length}`);
  for (const path of targets) apply(path, bundled);
  for (const base of [coding, core]) for (const name of ["file-write-guard.mjs", "resident-write-adoption.mjs"]) pending.set(join(base, name), readFileSync(join(here, name), "utf8"));
  for (const [path, content] of pending) if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-file-write.mjs NODE_MODULES");
  patchFileWriteCopies(resolve(process.argv[2]));
}
