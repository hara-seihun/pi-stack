import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { custodyReplaceFileSync } from "../shared-custody.js";
import { seedPiSession } from "./pi-session-file.js";
import type { Result } from "./contracts.js";

type Row = Record<string, any>;
export interface ProvenanceThread { id: string; sessionFile: string; cwd?: string; metadata?: Record<string, unknown> }
export interface ImportProvenanceOptions {
  threads: ProvenanceThread[];
  stateDirs?: { threadId: string; path: string }[];
  nativeFiles?: string[];
}
export interface ImportProvenanceMetadata {
  workspace?: unknown;
  executionError?: unknown;
  importProvenance: { stateDirs: string[] };
}
export interface ImportProvenanceResult { removedFiles: string[]; metadata: Record<string, ImportProvenanceMetadata> }
type Source = { path: string; owner: string; hash: string; format: string; header: Row };
type Native = { path: string; hash: string; records: Row[] };
type Match = { value: Row; path: string; entryId: string };
const names = new Set(["pi-tree.json", "agents.json", "conversation.jsonl", "activity.jsonl", "transfer.json", "codex-session.json"]);
const signature = /^(thinkingSignature|textSignature|encrypted_content|encryptedContent|thoughtSignature)$/;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function content(value: any): any {
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0]?.type === "text" && Object.keys(value[0]).every(key => key === "type" || key === "text" || signature.test(key))) return value[0].text;
    return value.map(content);
  }
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !signature.test(key)).map(([key, item]) => [key, content(item)])) : value;
}
function fingerprint(value: any): any {
  if (typeof value === "string") return hash(value);
  if (Array.isArray(value)) return value.map(fingerprint);
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fingerprint(key === "content" ? content(item) : item)])) : value;
}
function messageKey(message: Row) { return hash(canonical({ role: message.role, content: content(message.content), toolCallId: message.toolCallId, toolName: message.toolName })); }
function subset(source: any, target: any): boolean {
  if (source === target) return true;
  if (Array.isArray(source)) return Array.isArray(target) && source.length === target.length && source.every((value, index) => subset(value, target[index]));
  if (!source || typeof source !== "object" || !target || typeof target !== "object") return false;
  return Object.entries(source).every(([key, value]) => key === "content" ? subset(content(value), content(target[key])) : subset(value, target[key]));
}
function jsonl(text: string, path: string, partial = false): Row[] {
  const lines = text.split("\n"), records: Row[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try { const entry = JSON.parse(lines[index]); if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Expected object"); records.push(entry); }
    catch (error) {
      if (partial && index === lines.length - 1 && !text.endsWith("\n")) { records.push({ type: "incomplete_source_record", line: index + 1, raw: lines[index] }); continue; }
      throw new Error(`Invalid source record ${path}:${index + 1}: ${String(error)}`);
    }
  }
  return records;
}
function sourceRecords(source: Source): Row[] {
  const text = readFileSync(source.path, "utf8");
  const records = source.format.endsWith(".jsonl") ? jsonl(text, source.path, true) : [JSON.parse(text)];
  return source.format === "activity.jsonl" ? records.filter(record => !["context_update", "message_update", "tool_execution_update"].includes(record.type)) : records;
}
function nativeHeader(records: Row[]) { const header = records[0]; return header?.type === "session" && typeof header.id === "string" && header.representation === undefined && (!header.core || header.core === "pi"); }
function syncDirectory(path: string) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }

/** Call only after thread/work import commits and while its execution owners are drained. */
export function adoptImportProvenance(options: ImportProvenanceOptions): Result<ImportProvenanceResult> {
  try {
    const threads = new Map(options.threads.map(thread => [thread.id, thread]));
    const metadata: Record<string, ImportProvenanceMetadata> = {};
    const directories = new Map<string, string>();
    const sources: Source[] = [], natives = new Map<string, Native>(), scanned = new Set<string>();
    const nativePaths = new Set<string>(), messageKeys = new Set<string>();
    let indexingNative = false;
    const candidates = new Map<string, Match[]>(), receipts = new Set<string>();
    const knownAgents: Row[] = [];
    const directoryPaths = new Set<string>();
    function patch(id: string): ImportProvenanceMetadata { return metadata[id] ??= { importProvenance: { stateDirs: [] } }; }
    function addDirectory(id: string, path: unknown) {
      if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`Invalid provenance directory for thread ${id}: ${String(path)}`);
      const resolved = resolve(path), prior = directories.get(resolved);
      if (prior && prior !== id) throw new Error(`Provenance directory ${resolved} has two thread owners`);
      if (!threads.has(id)) throw new Error(`Provenance directory ${resolved} has no imported thread ${id}`);
      directories.set(resolved, id);
      if (!patch(id).importProvenance.stateDirs.includes(resolved)) patch(id).importProvenance.stateDirs.push(resolved);
    }
    function addMessage(value: Row, path: string, entryId: string) {
      if (typeof value.role !== "string") return;
      const key = messageKey(value);
      if (!messageKeys.has(key)) return;
      const list = candidates.get(key) ?? [];
      list.push({ value: fingerprint(value), path, entryId }); candidates.set(key, list);
    }
    function matched(message: Row): Match | undefined {
      const list = candidates.get(messageKey(message));
      if (!list) return undefined;
      const value = fingerprint(message);
      return list.find(candidate => subset(value, candidate.value));
    }
    function references(value: any): void {
      if (!value || typeof value !== "object") return;
      if (!indexingNative && typeof value.role === "string" && value.content !== undefined) messageKeys.add(messageKey(value));
      if (!indexingNative && value.type === "custom_message") messageKeys.add(messageKey({ role: "custom", content: value.content, customType: value.customType, details: value.details, timestamp: Date.parse(value.timestamp) }));
      for (const [key, item] of Object.entries(value)) {
        if (["sessionFile", "nativeSessionFile", "sessionPath", "parentSession"].includes(key) && typeof item === "string" && isAbsolute(item) && existsSync(item)) { if (indexingNative) addNative(item, false); else nativePaths.add(item); }
        else if (item && typeof item === "object") references(item);
      }
    }
    function addNative(path: string, required: boolean): void {
      if (!existsSync(path)) { if (required) throw new Error(`Required native history is missing: ${path}`); return; }
      const real = realpathSync(path);
      if (scanned.has(real)) { if (required && !natives.has(real)) throw new Error(`Not native Pi history: ${path}`); return; }
      scanned.add(real);
      const text = readFileSync(real, "utf8");
      const first = text.split("\n", 1)[0];
      let header: Row;
      try { header = JSON.parse(first); } catch { if (required) throw new Error(`Invalid native history header: ${path}`); return; }
      if (!nativeHeader([header])) { if (required) throw new Error(`Not native Pi history: ${path}`); return; }
      const records = jsonl(text, real);
      const native: Native = { path: real, hash: hash(text), records: [header, ...records.length > 1 ? [{ id: records.at(-1)!.id }] : []] }; natives.set(real, native);
      for (const entry of records) {
        if (entry.type === "message" && entry.message) addMessage(entry.message, real, entry.id);
        if (entry.type === "custom_message") {
          addMessage({ role: "custom", content: entry.content, customType: entry.customType, details: entry.details, timestamp: Date.parse(entry.timestamp) }, real, entry.id);
          if (entry.customType === "core_transfer_message" && entry.details?.message) addMessage(entry.details.message, real, entry.id);
        }
        if (entry.message?.customType === "core_transfer_message" && entry.message.details?.message) addMessage(entry.message.details.message, real, entry.id);
        if (entry.type === "custom" && entry.customType === "core_transfer" && Array.isArray(entry.data?.agents)) knownAgents.push(...entry.data.agents);
        if (entry.type === "custom" && entry.customType === "thread_import_provenance") {
          const data = entry.data;
          if (data?.source?.path && data.source.sha256) receipts.add(`${data.source.path}:${data.source.sha256}`);
          for (const fact of data?.facts ?? []) if (fact.kind === "message") addMessage(fact.message, real, entry.id);
          for (const [id, saved] of Object.entries(data?.metadata ?? {}) as [string, ImportProvenanceMetadata][]) {
            if (!threads.has(id)) continue;
            Object.assign(patch(id), saved, { importProvenance: { stateDirs: [...new Set([...patch(id).importProvenance.stateDirs, ...saved.importProvenance.stateDirs])] } });
            for (const path of saved.importProvenance.stateDirs) addDirectory(id, path);
          }
        }
      }
      references(header);
      for (const entry of records) if (entry.type === "custom" || entry.type === "custom_message") references(entry);
    }
    function scan(directory: string, owner: string): void {
      if (!existsSync(directory) || directoryPaths.has(directory)) return;
      directoryPaths.add(directory);
      const journal = join(directory, "conversation.jsonl");
      if (existsSync(journal)) {
        const header = jsonl(readFileSync(journal, "utf8"), journal, true)[0];
        if (typeof header?.id === "string" && threads.has(header.id)) owner = header.id;
      }
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) {
          if (item.name === "children" || /^[a-f0-9]{64}$/.test(item.name)) scan(path, owner);
          continue;
        }
        if (!item.isFile()) continue;
        const format = names.has(item.name) ? item.name : [...names].find(name => item.name === `${name}.next` || item.name.startsWith(`${name}.`) && item.name.endsWith(".tmp"));
        if (!format) { if (item.name.endsWith(".jsonl")) nativePaths.add(path); continue; }
        const text = readFileSync(path, "utf8");
        const parsed = format.endsWith(".jsonl") ? jsonl(text, path, true) : [JSON.parse(text)];
        const records = format === "activity.jsonl" ? parsed.filter(record => !["context_update", "message_update"].includes(record.type)) : parsed;
        let sourceOwner = owner;
        const header = records[0];
        if (format === "conversation.jsonl" && typeof header?.id === "string" && threads.has(header.id)) sourceOwner = header.id;
        sources.push({ path, owner: sourceOwner, hash: hash(text), format, header: header?.type === "session" ? header : {} });
        references(records);
      }
    }
    for (const thread of options.threads) {
      const imported = thread.metadata?.importedFrom as Row | undefined;
      if (imported?.nativeStateDirectory) addDirectory(thread.id, imported.nativeStateDirectory);
      const saved = thread.metadata?.importProvenance as Row | undefined;
      for (const path of saved?.stateDirs ?? []) addDirectory(thread.id, path);
    }
    for (const directory of options.stateDirs ?? []) addDirectory(directory.threadId, directory.path);
    for (const [directory, owner] of directories) scan(directory, owner);
    if (!sources.length) return { ok: true, value: { removedFiles: [], metadata: {} } };
    indexingNative = true;
    for (const thread of options.threads) addNative(thread.sessionFile, false);
    for (const path of options.nativeFiles ?? []) addNative(path, true);
    for (const path of nativePaths) addNative(path, false);
    // A switched SDK session's siblings can retain earlier native branches.
    for (const directory of new Set([...natives.values()].map(native => dirname(native.path)))) for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isFile() && item.name.endsWith(".jsonl") && !names.has(item.name)) addNative(join(directory, item.name), false);
    }
    for (const source of sources) if (source.format === "pi-tree.json") {
      const tree = sourceRecords(source)[0];
      if (!tree || !Array.isArray(tree.nodes)) throw new Error(`Invalid Pi tree: ${source.path}`);
      for (const node of tree.nodes) {
        if (!threads.has(node.id)) throw new Error(`Source child ${node.id} has not transferred to threads: ${source.path}`);
        if (node.busy || node.work && node.work.status !== "complete") throw new Error(`Source work ${node.work?.id ?? node.id} is not settled (${node.work?.status ?? "busy"}): ${source.path}`);
        knownAgents.push(node);
        if (node.workspace !== undefined) patch(node.id).workspace = node.workspace;
        if (node.error !== undefined) patch(node.id).executionError = node.error;
      }
      for (const [id, dispatch] of tree.dispatches ?? []) if (dispatch.state === "pending") throw new Error(`Source dispatch ${id} has unconfirmed admission: ${source.path}`);
    }
    for (const source of sources) {
      if (receipts.has(`${source.path}:${source.hash}`)) continue;
      const thread = threads.get(source.owner)!;
      if (!existsSync(thread.sessionFile) && thread.metadata?.nativeHistoryRequired === false && thread.cwd) seedPiSession(thread.sessionFile, thread.cwd);
      addNative(thread.sessionFile, true);
      const target = natives.get(realpathSync(thread.sessionFile))!;
      const facts: Row[] = [], matchedFiles = new Set<string>();
      let matchedMessages = 0;
      const entryId = hash(`${source.path}:${source.hash}`).slice(0, 24);
      function preserve(message: Row, sourceEntry?: Row) {
        const match = matched(message);
        if (match) { matchedMessages++; matchedFiles.add(match.path); return; }
        const sameContent = candidates.get(messageKey(message))?.[0];
        if (sameContent) {
          const extra = Object.fromEntries(Object.entries(message).filter(([key, value]) => key !== "content" && !subset(fingerprint(value), sameContent.value[key])));
          facts.push({ kind: "message-facts", native: { path: sameContent.path, entryId: sameContent.entryId }, value: extra, ...(sourceEntry ? { sourceEntry } : {}) });
          matchedFiles.add(sameContent.path); addMessage(message, target.path, entryId); return;
        }
        facts.push({ kind: "message", message, ...(sourceEntry ? { sourceEntry } : {}) });
        addMessage(message, target.path, entryId);
      }
      const records = sourceRecords(source);
      for (const record of records) {
        if (source.format === "conversation.jsonl") {
          if (record.type === "message") preserve(record.message, { id: record.id, parentId: record.parentId, timestamp: record.timestamp });
          else if (record.type === "custom_message") preserve({ role: "custom", content: record.content, customType: record.customType, details: record.details, timestamp: Date.parse(record.timestamp) });
          else if (record.type !== "session") facts.push({ kind: "source-structure", record });
        } else if (source.format === "transfer.json") {
          if (!Array.isArray(record.messages)) throw new Error(`Invalid transfer conversation: ${source.path}`);
          for (const message of record.messages) preserve(message);
          const { messages: _messages, agents, ...provenance } = record;
          const unmatched = (agents ?? []).filter((agent: Row) => !knownAgents.some(known => subset(agent, known)));
          facts.push({ kind: "transfer", value: { ...provenance, ...(unmatched.length ? { agents: unmatched } : {}) } });
          knownAgents.push(...unmatched);
        } else if (source.format === "activity.jsonl") {
          if (["context_update", "message_update"].includes(record.type)) continue;
          const { message, messages, toolResults, ...activity } = record;
          if (message?.role) preserve(message);
          for (const item of [...messages ?? [], ...toolResults ?? []]) if (item?.role) preserve(item);
          if (["message_start", "message_end"].includes(record.type)) continue;
          if (activity.agent && knownAgents.some(known => subset(activity.agent, known))) activity.agent = { id: activity.agent.id };
          facts.push({ kind: "activity", record: activity });
        } else if (source.format === "pi-tree.json") {
          const { nodes, ...tree } = record;
          const extras = nodes.map((node: Row) => {
            const { id, parentId: _parent, name: _name, model: _model, state: _state, nativeSessionId: _native, cwd: _cwd, sessionFile: _file, provider: _provider, thinkingLevel: _thinking, busy: _busy, work: _work, ...extra } = node;
            return { id, ...extra };
          }).filter((node: Row) => Object.keys(node).length > 1);
          facts.push({ kind: "relationships", value: { ...tree, nodes: extras } });
        } else if (source.format === "agents.json") {
          if (!Array.isArray(record)) throw new Error(`Invalid agent provenance: ${source.path}`);
          const unmatched = record.filter(agent => !knownAgents.some(known => subset(agent, known)));
          if (unmatched.length) { facts.push({ kind: "agents", value: unmatched }); knownAgents.push(...unmatched); }
        } else facts.push({ kind: "source-metadata", value: record });
      }
      const metadataForSource = Object.fromEntries(Object.entries(metadata).filter(([id]) => id === source.owner || source.format === "pi-tree.json" && records[0].nodes.some((node: Row) => node.id === id)));
      const parent = target.records.length > 1 ? target.records.at(-1)?.id ?? null : null;
      const addition = { type: "custom", id: entryId, parentId: parent, timestamp: new Date().toISOString(), customType: "thread_import_provenance",
        data: { source: { path: source.path, sha256: source.hash, format: source.format, ...(source.header.type === "session" ? { header: source.header } : {}) }, facts, metadata: metadataForSource,
          matchedMessages, matchedNativeFiles: [...matchedFiles] } };
      const text = readFileSync(target.path, "utf8");
      if (hash(text) !== target.hash) throw new Error(`Native history changed during provenance transfer: ${target.path}`);
      const updated = text + (text.endsWith("\n") ? "" : "\n") + JSON.stringify(addition) + "\n";
      custodyReplaceFileSync(target.path, updated);
      target.hash = hash(updated);
      target.records = [target.records[0], { id: entryId }];
    }
    for (const source of sources) if (hash(readFileSync(source.path, "utf8")) !== source.hash) throw new Error(`Source changed during provenance transfer: ${source.path}`);
    const removedFiles: string[] = [];
    for (const source of sources) { unlinkSync(source.path); syncDirectory(dirname(source.path)); removedFiles.push(source.path); }
    for (const directory of [...directoryPaths].sort((a, b) => b.length - a.length)) {
      if (directories.has(directory) || basename(directory) !== "children" && !/^[a-f0-9]{64}$/.test(basename(directory))) continue;
      if (readdirSync(directory).length === 0) { rmdirSync(directory); syncDirectory(dirname(directory)); }
    }
    return { ok: true, value: { removedFiles, metadata } };
  } catch (error) { return { ok: false, error: { code: "conflict", message: error instanceof Error ? error.message : String(error) } }; }
}
