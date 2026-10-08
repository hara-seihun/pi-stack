import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "// PiStack shell output stays in memory\n";

function replace(source, before, after, count = 1) {
  if (source.split(before).length - 1 !== count) {
    throw new Error(`Pinned Pi shell output anchor changed: ${before.slice(0, 100)}`);
  }
  return source.split(before).join(after);
}

function cut(source, start, end, replacement = "") {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last < 0 || source.indexOf(start, first + start.length) >= 0) {
    throw new Error(`Pinned Pi shell output section changed: ${start}`);
  }
  return source.slice(0, first) + replacement + source.slice(last);
}

function patchExecutor(source) {
  for (const line of [
    'import { randomBytes } from "node:crypto";\n',
    'import { createWriteStream } from "node:fs";\n',
    'import { tmpdir } from "node:os";\n',
    'import { join } from "node:path";\n',
  ]) source = replace(source, line, "");
  source = cut(source, "    let tempFilePath;", "    const decoder = new TextDecoder();");
  source = replace(source, "        totalBytes += data.length;\n", "");
  source = cut(source, "        // Start writing to temp file", "        // Keep rolling buffer");
  source = replace(source, `        if (truncationResult.truncated) {
            ensureTempFile();
        }
        if (tempFileStream) {
            tempFileStream.end();
        }
`, "");
  source = replace(source, `            if (truncationResult.truncated) {
                ensureTempFile();
            }
            if (tempFileStream) {
                tempFileStream.end();
            }
`, "");
  source = replace(source, `        if (tempFileStream) {
            tempFileStream.end();
        }
`, "");
  source = source.replace(/^\s*fullOutputPath: tempFilePath,\n/gm, "");
  if (/tempFile|ensureTempFile|totalBytes/.test(source)) throw new Error("Unpatched bash executor spill");
  return source;
}

function patchExecutorTail(source) {
  if (source.includes("const output = new OutputAccumulator();")) return source;
  source = replace(source, 'import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";',
    'import { OutputAccumulator } from "./tools/output-accumulator.js";');
  source = replace(source, `    const outputChunks = [];
    let outputBytes = 0;
    const maxOutputBytes = DEFAULT_MAX_BYTES * 2;`, "    const output = new OutputAccumulator();");
  source = replace(source, "    const onData = (data) => {", "    const onText = (decoded) => {");
  source = replace(source, "stripAnsi(decoder.decode(data, { stream: true }))", "stripAnsi(decoded)");
  source = cut(source, "        // Keep rolling buffer", "        // Stream to callback", "        output.appendDecodedText(text);\n");
  source = replace(source, "    try {\n        const result = await operations.exec", `    const onData = (data) => onText(decoder.decode(data, { stream: true }));
    const finishOutput = () => {
        onText(decoder.decode());
        output.finish();
        return output.snapshot();
    };
    try {
        const result = await operations.exec`);
  source = replace(source, 'const fullOutput = outputChunks.join("");', "const snapshot = finishOutput();", 2);
  source = replace(source, "const truncationResult = truncateTail(fullOutput);", "const truncationResult = snapshot.truncation;", 2);
  return replace(source, "output: truncationResult.truncated ? truncationResult.content : fullOutput,", "output: snapshot.content,", 2);
}

function patchAccumulator(source) {
  source = cut(source, 'import { randomBytes }', 'import { DEFAULT_MAX_BYTES');
  source = cut(source, "function defaultTempFilePath(prefix)", "function byteLength(text)");
  source = replace(source, ` * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.`, " * tail for display snapshots. Discarded output is never persisted.");
  for (const line of [
    "    tempFilePrefix;\n", "    rawChunks = [];\n", "    totalRawBytes = 0;\n",
    "    tempFilePath;\n", "    tempFileStream;\n",
    '        this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";\n',
    "        this.totalRawBytes += data.length;\n",
  ]) source = replace(source, line, "");
  source = cut(source, "        if (this.tempFileStream ||", "    }\n    finish()");
  source = replace(source, `        if (this.shouldUseTempFile()) {
            this.ensureTempFile();
        }
`, "");
  source = replace(source, "    snapshot(options = {}) {", "    snapshot() {");
  source = replace(source, `        if (options.persistIfTruncated && truncation.truncated) {
            this.ensureTempFile();
        }
`, "");
  source = replace(source, "            fullOutputPath: this.tempFilePath,\n", "");
  source = cut(source, "    async closeTempFile()", "    getLastLineBytes()");
  source = cut(source, "    shouldUseTempFile()", "}\n//# sourceMappingURL");
  if (/tempFile|TempFile|rawChunks|totalRawBytes/.test(source)) throw new Error("Unpatched output accumulator spill");
  return source;
}

function patchTool(source) {
  source = replace(source, "If truncated, full output is saved to a temp file.", "Truncated output is discarded; shell output is kept in memory only.");
  source = replace(source, "new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix })", "new OutputAccumulator()");
  source = replace(source, "output.snapshot({ persistIfTruncated: true })", "output.snapshot()", 2);
  source = replace(source, "await output.closeTempFile();", "");
  source = replace(source, "fullOutputPath: snapshot.fullOutputPath,", "");
  source = replace(source, "{ truncation, fullOutputPath: snapshot.fullOutputPath }", "{ truncation }");
  source = replace(source, ". Full output: ${snapshot.fullOutputPath}", ". Output truncated", 3);
  source = replace(source, '    tempFilePrefix: "pi-bash",\n', "");
  return source;
}

function patchMessages(source) {
  return replace(source, `    if (msg.truncated && msg.fullOutputPath) {
        text += \`\\n\\n[Output truncated. Full output: \${msg.fullOutputPath}]\`;
    }`, `    if (msg.truncated) {
        text += "\\n\\n[Output truncated]";
    }`);
}

function patchInteractive(source) {
  return replace(source, `            if (wasTruncated && this.fullOutputPath) {
                statusParts.push(theme.fg("warning", \`Output truncated. Full output: \${this.fullOutputPath}\`));
            }`, `            if (wasTruncated) {
                statusParts.push(theme.fg("warning", "Output truncated"));
            }`);
}

function patchHarnessTool(source) {
  source = replace(source, "If truncated, full output is saved to a temp file.", "Truncated output is discarded; shell output is kept in memory only.");
  source = replace(source, "spill: true,", "spill: false,");
  source = replace(source, "                            fullOutputPath: view.spillPath,\n", "");
  source = replace(source, "{ truncation: capture.truncation, fullOutputPath: capture.spillPath }", "{ truncation: capture.truncation }");
  return replace(source, ". Full output: ${capture.spillPath}", ". Output truncated", 3);
}

function patchHarnessCollector(source) {
  source = replace(source, "spill: true,", "spill: false,");
  return replace(source, "        ...(output.spillPath === undefined ? {} : { fullOutputPath: output.spillPath }),\n", "");
}

export function patchBashSpillCopies(nodeModules) {
  const base = join(nodeModules, "@earendil-works/pi-coding-agent/dist");
  const changes = [
    ["core/bash-executor.js", patchExecutor],
    ["core/tools/output-accumulator.js", patchAccumulator],
    ["core/tools/bash.js", patchTool],
    ["core/messages.js", patchMessages],
    ["core/agent-session.js", s => replace(s, "            fullOutputPath: result.fullOutputPath,\n", "")],
    ["modes/interactive/components/bash-execution.js", patchInteractive],
  ];
  const pending = new Map();
  for (const [name, patch] of changes) {
    const path = join(base, name);
    const source = readFileSync(path, "utf8");
    let patched = source.includes(MARKER) ? source : MARKER + patch(source);
    if (name === "core/bash-executor.js") patched = patchExecutorTail(patched);
    pending.set(path, patched);
  }
  for (const [name, patch] of [["tools/bash.js", patchHarnessTool], ["utils/shell-output.js", patchHarnessCollector], ["messages.js", patchMessages]]) {
    const path = join(nodeModules, "@earendil-works/pi-agent-core/dist/harness", name);
    const source = readFileSync(path, "utf8");
    pending.set(path, source.includes(MARKER) ? source : MARKER + patch(source));
  }
  for (const [path, source] of pending) {
    if (readFileSync(path, "utf8") !== source) writeFileSync(path, source);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-bash-spill.mjs NODE_MODULES");
  patchBashSpillCopies(resolve(process.argv[2]));
}
