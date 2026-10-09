import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_HELPERS = `
function syncSessionDirectory(filePath) {
    const fd = openSync(dirname(filePath), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeSessionFileDurably(filePath, data, flag) {
    const fd = openSync(filePath, flag, 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    if (flag === "wx") syncSessionDirectory(filePath);
}
function appendSessionFileDurably(filePath, data) {
    writeSessionFileDurably(filePath, data, "a");
}
function replaceSessionFileDurably(filePath, data) {
    const temporary = \`\${filePath}.\${process.pid}.\${randomUUID()}.tmp\`;
    try {
        writeSessionFileDurably(temporary, data, "wx");
        renameSync(temporary, filePath);
        syncSessionDirectory(filePath);
    } finally { rmSync(temporary, { force: true }); }
}
`;

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw new Error(`Pinned Pi ${label} changed`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchSessionDurability(source) {
  if (source.startsWith("// PiStack shared filesystem custody\n") && source.includes("function writeSessionFileDurably")) return source;
  source = replaceOnce(source,
    'import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync, } from "fs";',
    'import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, } from "fs";', "SDK filesystem imports");
  source = replaceOnce(source, 'import { basename, join, resolve } from "path";',
    'import { basename, dirname, join, resolve } from "path";', "SDK path imports");
  source = replaceOnce(source, "/**\n * Manages conversation sessions as append-only trees stored in JSONL files.",
    `${SDK_HELPERS}/**\n * Manages conversation sessions as append-only trees stored in JSONL files.`, "SDK durability helpers");
  source = replaceOnce(source,
    `    _rewriteFile() {
        if (!this.persist || !this.sessionFile)
            return;
        const fd = openSync(this.sessionFile, "w");
        try {
            for (const entry of this.fileEntries) {
                writeFileSync(fd, \`\${JSON.stringify(entry)}\\n\`);
            }
        }
        finally {
            closeSync(fd);
        }
    }`,
    `    _rewriteFile() {
        if (!this.persist || !this.sessionFile)
            return;
        replaceSessionFileDurably(this.sessionFile, this.fileEntries.map((entry) => \`\${JSON.stringify(entry)}\\n\`).join(""));
    }`, "SDK session rewrite");
  source = replaceOnce(source,
    `            if (this.flushed) {
                appendFileSync(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
            }`,
    `            if (this.flushed) {
                appendSessionFileDurably(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
            }`, "SDK pre-assistant append");
  source = replaceOnce(source,
    `            const fd = openSync(this.sessionFile, "wx");
            try {
                for (const e of this.fileEntries) {
                    writeFileSync(fd, \`\${JSON.stringify(e)}\\n\`);
                }
            }
            finally {
                closeSync(fd);
            }
            this.flushed = true;`,
    `            writeSessionFileDurably(this.sessionFile, this.fileEntries.map((e) => \`\${JSON.stringify(e)}\\n\`).join(""), "wx");
            this.flushed = true;`, "SDK initial flush");
  source = replaceOnce(source,
    `        else {
            appendFileSync(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
        }`,
    `        else {
            appendSessionFileDurably(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
        }`, "SDK append");
  source = replaceOnce(source,
    `        writeFileSync(newSessionFile, \`\${JSON.stringify(newHeader)}\\n\`, { flag: "wx" });
        // Copy all non-header entries from source
        for (const entry of sourceEntries) {
            if (entry.type !== "session") {
                appendFileSync(newSessionFile, \`\${JSON.stringify(entry)}\\n\`);
            }
        }`,
    `        const forkedEntries = sourceEntries.filter((entry) => entry.type !== "session");
        writeSessionFileDurably(newSessionFile, [newHeader, ...forkedEntries].map((entry) => \`\${JSON.stringify(entry)}\\n\`).join(""), "wx");`, "SDK fork write");
  return source;
}

export function patchSessionCopies(nodeModules) {
  const path = join(nodeModules, "@earendil-works/pi-coding-agent/dist/core/session-manager.js");
  const source = readFileSync(path, "utf8"), patched = patchSessionDurability(source);
  if (source !== patched) writeFileSync(path, patched);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-session-durability.mjs NODE_MODULES");
  patchSessionCopies(resolve(process.argv[2]));
}
