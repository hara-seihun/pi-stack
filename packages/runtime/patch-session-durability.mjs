import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_HELPERS = `
function syncSessionDirectory(filePath) {
    const fd = openSync(dirname(filePath), "r");
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
function writeSessionFileDurably(filePath, data, flag) {
    const fd = openSync(filePath, flag, 0o600);
    try {
        writeFileSync(fd, data);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    if (flag === "wx") {
        syncSessionDirectory(filePath);
    }
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
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
`;

const BUNDLE_HELPERS = `function syncSessionDirectory(filePath){let fd=openSync(dirnameSessionPath(filePath),"r");try{fsyncSessionFileSync(fd)}finally{closeSync(fd)}}function writeSessionFileDurably(filePath,data,flag){let fd=openSync(filePath,flag,0o600);try{writeFileSync5(fd,data),fsyncSessionFileSync(fd)}finally{closeSync(fd)}flag==="wx"&&syncSessionDirectory(filePath)}function appendSessionFileDurably(filePath,data){writeSessionFileDurably(filePath,data,"a")}function replaceSessionFileDurably(filePath,data){let temporary=\`\${filePath}.\${process.pid}.\${randomUUID()}.tmp\`;try{writeSessionFileDurably(temporary,data,"wx"),renameSessionFileSync(temporary,filePath),syncSessionDirectory(filePath)}finally{rmSessionFileSync(temporary,{force:!0})}}`;

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Pinned Pi ${label} changed`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patchSdk(source) {
  source = replaceOnce(
    source,
    "import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync, } from \"fs\";",
    "import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, } from \"fs\";",
    "SDK filesystem imports",
  );
  source = replaceOnce(
    source,
    'import { basename, join, resolve } from "path";',
    'import { basename, dirname, join, resolve } from "path";',
    "SDK path imports",
  );
  source = replaceOnce(
    source,
    "/**\n * Manages conversation sessions as append-only trees stored in JSONL files.",
    `${SDK_HELPERS}/**\n * Manages conversation sessions as append-only trees stored in JSONL files.`,
    "SDK durability helpers",
  );
  source = replaceOnce(
    source,
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
    }`,
    "SDK session rewrite",
  );
  source = replaceOnce(
    source,
    `            if (this.flushed) {
                appendFileSync(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
            }`,
    `            if (this.flushed) {
                appendSessionFileDurably(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
            }`,
    "SDK pre-assistant append",
  );
  source = replaceOnce(
    source,
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
            this.flushed = true;`,
    "SDK initial flush",
  );
  source = replaceOnce(
    source,
    `        else {
            appendFileSync(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
        }`,
    `        else {
            appendSessionFileDurably(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
        }`,
    "SDK append",
  );
  source = replaceOnce(
    source,
    `        writeFileSync(newSessionFile, \`\${JSON.stringify(newHeader)}\\n\`, { flag: "wx" });
        // Copy all non-header entries from source
        for (const entry of sourceEntries) {
            if (entry.type !== "session") {
                appendFileSync(newSessionFile, \`\${JSON.stringify(entry)}\\n\`);
            }
        }`,
    `        const forkedEntries = sourceEntries.filter((entry) => entry.type !== "session");
        writeSessionFileDurably(newSessionFile, [newHeader, ...forkedEntries].map((entry) => \`\${JSON.stringify(entry)}\\n\`).join(""), "wx");`,
    "SDK fork write",
  );
  return source;
}

function patchBundle(source) {
  source = replaceOnce(
    source,
    'import{appendFileSync as appendFileSync3,closeSync,createReadStream,existsSync as existsSync10,mkdirSync as mkdirSync5,openSync,readdirSync as readdirSync5,readSync,statSync as statSync6,writeFileSync as writeFileSync5}from"fs";',
    'import{closeSync,createReadStream,existsSync as existsSync10,fsyncSync as fsyncSessionFileSync,mkdirSync as mkdirSync5,openSync,readdirSync as readdirSync5,readSync,renameSync as renameSessionFileSync,rmSync as rmSessionFileSync,statSync as statSync6,writeFileSync as writeFileSync5}from"fs";',
    "bundled filesystem imports",
  );
  source = replaceOnce(
    source,
    'import{basename as basename5,join as join18,resolve as resolve4}from"path";',
    'import{basename as basename5,dirname as dirnameSessionPath,join as join18,resolve as resolve4}from"path";',
    "bundled path imports",
  );
  source = replaceOnce(
    source,
    "var SessionManager=class _SessionManager",
    `${BUNDLE_HELPERS}var SessionManager=class _SessionManager`,
    "bundled durability helpers",
  );
  source = replaceOnce(
    source,
    `_rewriteFile(){if(!this.persist||!this.sessionFile)return;let fd=openSync(this.sessionFile,"w");try{for(let entry of this.fileEntries)writeFileSync5(fd,\`\${JSON.stringify(entry)}
\`)}finally{closeSync(fd)}}`,
    `_rewriteFile(){this.persist&&this.sessionFile&&replaceSessionFileDurably(this.sessionFile,this.fileEntries.map(entry=>\`\${JSON.stringify(entry)}\\n\`).join(""))}`,
    "bundled session rewrite",
  );
  source = replaceOnce(
    source,
    `_persist(entry){if(!this.persist||!this.sessionFile)return;if(!this.fileEntries.some(e=>e.type==="message"&&e.message.role==="assistant")){this.flushed?appendFileSync3(this.sessionFile,\`\${JSON.stringify(entry)}
\`):this.flushed=!1;return}if(this.flushed)appendFileSync3(this.sessionFile,\`\${JSON.stringify(entry)}
\`);else{let fd=openSync(this.sessionFile,"wx");try{for(let e of this.fileEntries)writeFileSync5(fd,\`\${JSON.stringify(e)}
\`)}finally{closeSync(fd)}this.flushed=!0}}`,
    `_persist(entry){if(!this.persist||!this.sessionFile)return;if(!this.fileEntries.some(e=>e.type==="message"&&e.message.role==="assistant")){this.flushed?appendSessionFileDurably(this.sessionFile,\`\${JSON.stringify(entry)}\\n\`):this.flushed=!1;return}this.flushed?appendSessionFileDurably(this.sessionFile,\`\${JSON.stringify(entry)}\\n\`):(writeSessionFileDurably(this.sessionFile,this.fileEntries.map(e=>\`\${JSON.stringify(e)}\\n\`).join(""),"wx"),this.flushed=!0)}`,
    "bundled persistence",
  );
  source = replaceOnce(
    source,
    `writeFileSync5(newSessionFile,\`\${JSON.stringify({type:"session",version:CURRENT_SESSION_VERSION,id:newSessionId,timestamp,cwd:resolvedTargetCwd,parentSession:resolvedSourcePath})}
\`,{flag:"wx"});for(let entry of sourceEntries)entry.type!=="session"&&appendFileSync3(newSessionFile,\`\${JSON.stringify(entry)}
\`);`,
    `writeSessionFileDurably(newSessionFile,[{type:"session",version:CURRENT_SESSION_VERSION,id:newSessionId,timestamp,cwd:resolvedTargetCwd,parentSession:resolvedSourcePath},...sourceEntries.filter(entry=>entry.type!=="session")].map(entry=>\`\${JSON.stringify(entry)}\\n\`).join(""),"wx");`,
    "bundled fork write",
  );
  return source;
}

export function patchSessionDurability(source) {
  // Shared custody rewrites these already-installed write boundaries.
  if (source.startsWith("// PiStack shared filesystem custody\n") && source.includes("function writeSessionFileDurably")) return source;
  if (source.includes("export class SessionManager")) return patchSdk(source);
  if (source.includes("var SessionManager=class _SessionManager")) return patchBundle(source);
  throw new Error("Pinned Pi SessionManager source not found");
}

export function patchSessionCopies(nodeModules) {
  const base = join(nodeModules, "@earendil-works/pi-coding-agent/dist");
  const sdk = join(base, "core/session-manager.js");
  const chunks = join(base, "bundle/chunks");
  const paths = [sdk, ...readdirSync(chunks).filter((name) => name.endsWith(".js")).map((name) => join(chunks, name)).filter((path) => readFileSync(path, "utf8").includes("var SessionManager=class _SessionManager"))];
  if (paths.length < 2) throw new Error("Pinned Pi bundled SessionManager not found");
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    const patched = patchSessionDurability(source);
    if (source !== patched) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-session-durability.mjs NODE_MODULES");
  patchSessionCopies(resolve(process.argv[2]));
}
