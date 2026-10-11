import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "// PiStack canonical session writer v1\n";
const SDK_HELPERS = `
import { acquireSessionWriter, requireSessionWriter, sessionWriterConfiguration, SessionWriterError, trackSessionWriter, writeSessionBytes } from "./session-writer.mjs";
function acquireNativeSessionWriter(config, filePath, sessionId) {
    const pathOwner = requireSessionWriter(acquireSessionWriter({ ...config, identity: "path:" + basename(filePath) }));
    let idOwner;
    try {
        idOwner = requireSessionWriter(acquireSessionWriter({ ...config, identity: "id:" + sessionId }));
        return {
            filePath, sessionId,
            assertOwned() { requireSessionWriter(pathOwner.assertOwned()); return idOwner.assertOwned(); },
            poison(error) { pathOwner.poison(error); idOwner.poison(error); },
            release() { requireSessionWriter(idOwner.release()); return pathOwner.release(); },
        };
    } catch (error) { requireSessionWriter(pathOwner.release()); throw error; }
}
function readSessionEntriesStrict(filePath) {
    const raw = readFileSync(filePath, "utf8");
    if (!raw || !raw.endsWith("\\n")) throw new SessionWriterError("SESSION_WRITER_FRAGMENT", "Native session has an empty or incomplete record; inspection is required");
    const lines = raw.slice(0, -1).split("\\n");
    let entries;
    try { entries = lines.map((line) => JSON.parse(line)); }
    catch (cause) { throw new SessionWriterError("SESSION_WRITER_FRAGMENT", "Native session has a malformed record; inspection is required", cause); }
    if (entries[0]?.type !== "session" || typeof entries[0].id !== "string" || !entries[0].id) throw new SessionWriterError("SESSION_WRITER_HEADER", "Native session requires its canonical header identity");
    if (entries[0].version !== undefined && ![1, 2, CURRENT_SESSION_VERSION].includes(entries[0].version)) throw new SessionWriterError("SESSION_WRITER_VERSION", "Native session version is unsupported");
    if ([2, CURRENT_SESSION_VERSION].includes(entries[0].version)) {
        const ids = new Set();
        for (const entry of entries.slice(1)) {
            if (!entry || entry.type === "session" || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || !(entry.parentId === null || typeof entry.parentId === "string")) throw new SessionWriterError("SESSION_WRITER_GRAPH", "Native session has invalid or duplicate tree identities");
            if (entry.parentId !== null && !ids.has(entry.parentId)) throw new SessionWriterError("SESSION_WRITER_GRAPH", "Native session has a missing or cyclic parent record; inspection is required");
            ids.add(entry.id);
        }
    }
    return entries;
}
function syncSessionDirectory(filePath) {
    const fd = openSync(dirname(filePath), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeSessionFileDurably(filePath, data, flag, owner) {
    requireSessionWriter(owner.assertOwned());
    let fd;
    try {
        fd = openSync(filePath, flag === "a" ? "a+" : flag, 0o600);
        if (flag === "a") {
            const length = fstatSync(fd).size;
            const tail = Buffer.alloc(1);
            if (!length || readSync(fd, tail, 0, 1, length - 1) !== 1 || tail[0] !== 10) throw new SessionWriterError("SESSION_WRITER_FRAGMENT", "Session append requires a complete native record boundary");
        }
        writeSessionBytes(fd, data, { write: writeSync, sync: fsyncSync });
        if (flag === "wx") syncSessionDirectory(filePath);
    } catch (error) { owner.poison(error); throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
}
function appendSessionFileDurably(filePath, data, owner) {
    writeSessionFileDurably(filePath, data, "a", owner);
}
function replaceSessionFileDurably(filePath, data, owner) {
    requireSessionWriter(owner.assertOwned());
    if (!existsSync(filePath)) { writeSessionFileDurably(filePath, data, "wx", owner); return; }
    const temporary = \`\${filePath}.\${process.pid}.\${randomUUID()}.tmp\`;
    try {
        writeSessionFileDurably(temporary, data, "wx", owner);
        renameSync(temporary, filePath);
        syncSessionDirectory(filePath);
    } catch (error) { owner.poison(error); throw error; }
    finally { rmSync(temporary, { force: true }); }
}
`;

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw new Error(`Pinned Pi ${label} changed`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchSessionDurability(source) {
  if (source.includes(marker)) return source;
  if (source.includes("function writeSessionFileDurably")) throw new Error("Rebuild the immutable Pi tree before upgrading session writer custody");
  source = replaceOnce(source,
    'import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync, } from "fs";',
    'import { closeSync, createReadStream, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync, } from "fs";', "SDK filesystem imports");
  source = replaceOnce(source, 'import { basename, join, resolve } from "path";',
    'import { basename, dirname, join, resolve } from "path";', "SDK path imports");
  source = replaceOnce(source, "/**\n * Manages conversation sessions as append-only trees stored in JSONL files.",
    `${marker}${SDK_HELPERS}/**\n * Manages conversation sessions as append-only trees stored in JSONL files.`, "SDK durability helpers");
  source = replaceOnce(source, '    sessionId = "";', `    _sessionWriter;
    _sessionWriterClosed = false;
    _sessionWriterConfig = sessionWriterConfiguration();
    _assertSessionWriter() {
        if (this._sessionWriterClosed) throw new SessionWriterError("SESSION_WRITER_RELEASED", "Session manager has been disposed");
        if (this.persist) {
            if (!this._sessionWriter) throw new SessionWriterError("SESSION_WRITER_UNOWNED", "Native session has no writer custody");
            requireSessionWriter(this._sessionWriter.assertOwned());
        }
    }
    _adoptSessionWriter(filePath, sessionId) {
        if (!this.persist) return;
        if (this._sessionWriterClosed) throw new SessionWriterError("SESSION_WRITER_RELEASED", "Session manager has been disposed");
        if (this._sessionWriter?.filePath === filePath && this._sessionWriter?.sessionId === sessionId) { this._assertSessionWriter(); return; }
        const next = acquireNativeSessionWriter(this._sessionWriterConfig, filePath, sessionId);
        const previous = this._sessionWriter;
        this._sessionWriter = next;
        if (previous) requireSessionWriter(previous.release());
    }
    dispose() {
        if (!this.persist || this._sessionWriterClosed) return;
        if (this._sessionWriter) requireSessionWriter(this._sessionWriter.release());
        this._sessionWriter = undefined;
        this._sessionWriterClosed = true;
    }
    sessionId = "";`, "SDK writer lifetime");
  source = replaceOnce(source, "constructor(cwd, sessionDir, sessionFile, persist, newSessionOptions, preloadedFileEntries) {", "constructor(cwd, sessionDir, sessionFile, persist, newSessionOptions, preloadedFileEntries, preloadedWriter) {", "SDK imported writer transfer");
  source = replaceOnce(source, `        if (sessionFile) {
            this._setSessionFile(sessionFile, preloadedFileEntries);
        }
        else if (preloadedFileEntries?.length) {
            this._loadEntries(preloadedFileEntries, newSessionOptions);
        }
        else {
            this.newSession(newSessionOptions);
        }`, `        try {
            if (preloadedWriter) { this._sessionWriter = preloadedWriter; this.sessionId = preloadedWriter.sessionId; }
            if (sessionFile) this._setSessionFile(sessionFile, preloadedFileEntries);
            else if (preloadedFileEntries?.length) {
                if (persist) throw new SessionWriterError("SESSION_WRITER_CONFIGURATION", "Persisted preloaded entries require an explicit session file");
                this._loadEntries(preloadedFileEntries, newSessionOptions);
            }
            else this.newSession(newSessionOptions);
        } catch (error) { this.dispose(); throw error; }
        trackSessionWriter(this);`, "SDK constructor cleanup");
  const setStart = source.indexOf("    _setSessionFile(sessionFile, preloadedFileEntries) {");
  const setEnd = source.indexOf("    newSession(options) {", setStart);
  if (setStart < 0 || setEnd < 0) throw new Error("Pinned Pi session loading changed");
  source = source.slice(0, setStart) + `    _setSessionFile(sessionFile, _preloadedFileEntries) {
        if (this._sessionWriterClosed) throw new SessionWriterError("SESSION_WRITER_RELEASED", "Session manager has been disposed");
        const filePath = resolvePath(sessionFile);
        if (filePath === this._sessionWriter?.filePath) {
            this._assertSessionWriter();
            const entries = readSessionEntriesStrict(filePath);
            if (entries[0].id !== this.sessionId) throw new SessionWriterError("SESSION_WRITER_HEADER", "Owned session identity changed");
            this.sessionFile = filePath;
            this._loadEntries(entries);
            this.flushed = true;
            return;
        }
        const pathOwner = requireSessionWriter(acquireSessionWriter({ ...this._sessionWriterConfig, identity: "path:" + basename(filePath) }));
        let next;
        try {
            const entries = existsSync(filePath) ? readSessionEntriesStrict(filePath) : undefined;
            const sessionId = entries ? entries[0].id : createSessionId();
            const idOwner = requireSessionWriter(acquireSessionWriter({ ...this._sessionWriterConfig, identity: "id:" + sessionId }));
            next = { filePath, sessionId,
                assertOwned() { requireSessionWriter(pathOwner.assertOwned()); return idOwner.assertOwned(); },
                poison(error) { pathOwner.poison(error); idOwner.poison(error); },
                release() { requireSessionWriter(idOwner.release()); return pathOwner.release(); } };
            // Re-read after identity custody: another mount can have a different alias.
            const ownedEntries = entries ? readSessionEntriesStrict(filePath) : undefined;
            if (ownedEntries && ownedEntries[0].id !== sessionId) throw new SessionWriterError("SESSION_WRITER_HEADER", "Session identity changed while acquiring custody");
            const previous = this._sessionWriter;
            this._sessionWriter = next;
            next = undefined;
            if (previous) requireSessionWriter(previous.release());
            this.sessionFile = filePath;
            if (ownedEntries) { this._loadEntries(ownedEntries); this.flushed = true; }
            else {
                this.sessionId = sessionId;
                this.fileEntries = [{ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: new Date().toISOString(), cwd: this.cwd }];
                this._buildIndex();
                this.flushed = false;
            }
        } catch (error) {
            if (next) requireSessionWriter(next.release());
            else if (this._sessionWriter?.filePath !== filePath) requireSessionWriter(pathOwner.release());
            throw error;
        }
    }
` + source.slice(setEnd);
  source = replaceOnce(source, `        this.sessionId = options?.id ?? createSessionId();
        const timestamp = new Date().toISOString();`, `        const nextId = options?.id ?? createSessionId();
        const timestamp = new Date().toISOString();
        const nextFile = this.persist ? join(this.getSessionDir(), \`\${timestamp.replace(/[:.]/g, "-")}_\${nextId}.jsonl\`) : undefined;
        this._adoptSessionWriter(nextFile, nextId);
        this.sessionId = nextId;`, "SDK new session custody");
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
        this._assertSessionWriter();
        if (!this.persist || !this.sessionFile) return;
        replaceSessionFileDurably(this.sessionFile, this.fileEntries.map((entry) => \`\${JSON.stringify(entry)}\\n\`).join(""), this._sessionWriter);
    }`, "SDK session rewrite");
  source = replaceOnce(source, `    _persist(entry) {
        if (!this.persist || !this.sessionFile)`, `    _persist(entry) {
        this._assertSessionWriter();
        if (!this.persist || !this.sessionFile)`, "SDK persist assertion");
  source = replaceOnce(source,
    `            if (this.flushed) {
                appendFileSync(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
            }`,
    `            if (this.flushed) {
                appendSessionFileDurably(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`, this._sessionWriter);
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
    `            writeSessionFileDurably(this.sessionFile, this.fileEntries.map((e) => \`\${JSON.stringify(e)}\\n\`).join(""), "wx", this._sessionWriter);
            this.flushed = true;`, "SDK initial flush");
  source = replaceOnce(source,
    `        else {
            appendFileSync(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`);
        }`,
    `        else {
            appendSessionFileDurably(this.sessionFile, \`\${JSON.stringify(entry)}\\n\`, this._sessionWriter);
        }`, "SDK append");
  source = replaceOnce(source, `    _appendEntry(entry) {
        this.fileEntries.push(entry);`, `    _appendEntry(entry) {
        this._assertSessionWriter();
        this.fileEntries.push(entry);`, "SDK append admission");
  source = replaceOnce(source, `        this._persist(entry);
    }
    /** Append a message`, `        try { this._persist(entry); }
        catch (error) { this.fileEntries.pop(); this._buildIndex(); throw error; }
    }
    /** Append a message`, "SDK failed append rollback");
  source = replaceOnce(source, `            this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];`, `            this._adoptSessionWriter(newSessionFile, newSessionId);
            this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];`, "SDK branch ownership");
  source = replaceOnce(source, "        const sourceEntries = loadEntriesFromFile(resolvedSourcePath);", "        const sourceEntries = readSessionEntriesStrict(resolvedSourcePath);", "SDK strict fork source");
  source = replaceOnce(source,
    `        writeFileSync(newSessionFile, \`\${JSON.stringify(newHeader)}\\n\`, { flag: "wx" });
        // Copy all non-header entries from source
        for (const entry of sourceEntries) {
            if (entry.type !== "session") {
                appendFileSync(newSessionFile, \`\${JSON.stringify(entry)}\\n\`);
            }
        }`,
    `        const forkedEntries = sourceEntries.filter((entry) => entry.type !== "session");
        const owner = acquireNativeSessionWriter(sessionWriterConfiguration(), newSessionFile, newSessionId);
        try { writeSessionFileDurably(newSessionFile, [newHeader, ...forkedEntries].map((entry) => \`\${JSON.stringify(entry)}\\n\`).join(""), "wx", owner); }
        finally { requireSessionWriter(owner.release()); }`, "SDK fork write");
  source = replaceOnce(source, "    static create(cwd, sessionDir, options) {", `    static importFile(sourcePath, destinationPath, sessionDir, cwdOverride) {
        const entries = readSessionEntriesStrict(sourcePath);
        const owner = acquireNativeSessionWriter(sessionWriterConfiguration(), destinationPath, entries[0].id);
        try {
            const ownedEntries = readSessionEntriesStrict(sourcePath);
            if (ownedEntries[0].id !== entries[0].id) throw new SessionWriterError("SESSION_WRITER_HEADER", "Imported session identity changed while acquiring custody");
            writeSessionFileDurably(destinationPath, readFileSync(sourcePath, "utf8"), "wx", owner);
            return new SessionManager(cwdOverride ?? getSessionHeaderCwd(ownedEntries[0]), sessionDir, destinationPath, true, undefined, undefined, owner);
        } catch (error) { requireSessionWriter(owner.release()); throw error; }
    }
    static branchFrom(manager, leafId) {
        manager._assertSessionWriter();
        const branch = SessionManager.inMemory(manager.cwd, undefined, structuredClone(manager.fileEntries));
        branch.persist = manager.persist;
        branch.sessionDir = manager.sessionDir;
        branch.sessionFile = manager.sessionFile;
        branch._sessionWriterConfig = manager._sessionWriterConfig;
        try { branch.createBranchedSession(leafId); return branch; }
        catch (error) { branch.dispose(); throw error; }
    }
    static create(cwd, sessionDir, options) {`, "SDK detached fork custody");
  return source;
}

export function patchAgentSessionWriterDisposal(source) {
  return replaceOnce(source, "        cleanupSessionResources(this.sessionId);", "        cleanupSessionResources(this.sessionId);\n        this.sessionManager.dispose();", "SDK writer disposal");
}

export function patchSessionRuntimeWriter(source) {
  if (source.startsWith("// PiStack canonical writer runtime v1\n")) return source;
  source = replaceOnce(source, 'import { SessionManager } from "./session-manager.js";', 'import { SessionManager } from "./session-manager.js";\nimport { withSessionWriterConfiguration, withSessionWriterScope } from "./session-writer.mjs";', "SDK runtime scope import");
  for (const method of ["switchSession", "newSession", "fork", "importFromJsonl"]) {
    source = replaceOnce(source, `    async ${method}(`, `    async _owned_${method}(`, `SDK runtime ${method} scope`);
  }
  source = replaceOnce(source, `    apply(result) {`, `    _replaceSessionWriter(callback) {
        return withSessionWriterConfiguration(this.session.sessionManager._sessionWriterConfig,
            () => withSessionWriterScope(callback, manager => manager === this.session.sessionManager));
    }
    async switchSession(...args) { return this._replaceSessionWriter(() => this._owned_switchSession(...args)); }
    async newSession(...args) { return this._replaceSessionWriter(() => this._owned_newSession(...args)); }
    async fork(...args) { return this._replaceSessionWriter(() => this._owned_fork(...args)); }
    async importFromJsonl(...args) { return this._replaceSessionWriter(() => this._owned_importFromJsonl(...args)); }
    apply(result) {`, "SDK runtime replacement scope");
  source = replaceOnce(source, `            const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
            const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);`, `            const sessionManager = SessionManager.branchFrom(this.session.sessionManager, targetLeafId);
            const forkedSessionPath = sessionManager.getSessionFile();`, "SDK runtime fork custody");
  source = replaceOnce(source, `    apply(result) {`, `    async _createOwnedRuntime(options) {
        try { return await this.createRuntime(options); }
        catch (error) { options.sessionManager.dispose(); throw error; }
    }
    apply(result) {`, "SDK runtime failed factory cleanup");
  source = source.replaceAll("this.apply(await this.createRuntime({", "this.apply(await this._createOwnedRuntime({");
  source = source.replaceAll("        this.session.dispose();", "        await this.session.dispose();");
  source = replaceOnce(source, `        const previousSessionFile = this.session.sessionFile;
        const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);`, `        const previousSessionFile = this.session.sessionFile;
        const resumingCurrent = resolvePath(sessionPath) === previousSessionFile;
        if (resumingCurrent) await this.teardownCurrent("resume", sessionPath);
        const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);`, "SDK same-session reacquisition");
  source = replaceOnce(source, `        await this.teardownCurrent("resume", sessionManager.getSessionFile());
        this.apply(await this._createOwnedRuntime({
            cwd: sessionManager.getCwd(),
            agentDir: this.services.agentDir,
            sessionManager,
            sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
            projectTrustContext:`, `        if (!resumingCurrent) await this.teardownCurrent("resume", sessionManager.getSessionFile());
        this.apply(await this._createOwnedRuntime({
            cwd: sessionManager.getCwd(),
            agentDir: this.services.agentDir,
            sessionManager,
            sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
            projectTrustContext:`, "SDK same-session teardown");
  source = replaceOnce(source, `        if (!sourceAlreadyStored) {
            copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
        }
        const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);`, `        const sessionManager = sourceAlreadyStored ? SessionManager.open(destinationPath, sessionDir, cwdOverride)
            : SessionManager.importFile(resolvedPath, destinationPath, sessionDir, cwdOverride);`, "SDK runtime imported file custody");
  return "// PiStack canonical writer runtime v1\n" + source;
}

export function patchSessionFactoryWriter(source) {
  if (source.includes("async function createOwnedAgentSession(")) return source;
  source = replaceOnce(source, "export async function createAgentSession(options = {}) {", `import { withSessionWriterScope } from "./session-writer.mjs";
export async function createAgentSession(options = {}) {
    let created;
    try {
        return await withSessionWriterScope(async () => { created = await createOwnedAgentSession(options); return created; }, manager => manager === created?.session.sessionManager);
    } catch (error) { options.sessionManager?.dispose(); throw error; }
}
async function createOwnedAgentSession(options = {}) {`, "SDK factory writer cleanup");
  return source;
}

export function patchSessionCopies(nodeModules) {
  const base = join(nodeModules, "@earendil-works/pi-coding-agent/dist/core");
  writeFileSync(join(base, "session-writer.mjs"), readFileSync(new URL("./session-writer.mjs", import.meta.url)));
  for (const [name, patch] of [["session-manager", patchSessionDurability], ["agent-session", patchAgentSessionWriterDisposal], ["agent-session-runtime", patchSessionRuntimeWriter], ["sdk", patchSessionFactoryWriter]]) {
    const path = join(base, `${name}.js`);
    const source = readFileSync(path, "utf8"), patched = patch(source);
    if (source !== patched) writeFileSync(path, patched);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-session-durability.mjs NODE_MODULES");
  patchSessionCopies(resolve(process.argv[2]));
}
