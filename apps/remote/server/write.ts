import type { Database } from "bun:sqlite";
import { modelBrokerUrl } from "pi-orchestrator/api";

export function writeEngineEndpoint(): string {
  const broker = modelBrokerUrl();
  return broker ? `${broker.replace(/^http/, "ws").replace(/\/$/, "")}/v1/write/stream`
    : process.env.PI_STACK_WRITE_URL ?? "ws://127.0.0.1:8797/";
}

export type Dictionary = { words: string[]; replacements: Array<{ from: string; to: string }> };
const word = /^[\p{L}][\p{L}\p{M}'’-]{0,79}$/u;
const tokens = (text: string) => text.match(/[\p{L}][\p{L}\p{M}'’-]*/gu) ?? [];
const key = (text: string) => text.toLocaleLowerCase("en");

export function parseDictionary(value: unknown): Dictionary | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Dictionary;
  if (!Array.isArray(input.words) || !Array.isArray(input.replacements) || input.words.length > 500 || input.replacements.length > 500) return null;
  if (!input.words.every(item => typeof item === "string" && word.test(item))) return null;
  if (!input.replacements.every(item => item && typeof item.from === "string" && word.test(item.from) && typeof item.to === "string" && word.test(item.to))) return null;
  if (new Set(input.words.map(key)).size !== input.words.length || new Set(input.replacements.map(rule => key(rule.from))).size !== input.replacements.length) return null;
  return { words: input.words, replacements: input.replacements };
}

function distance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = next;
    }
  }
  return previous[b.length]!;
}
const sound = (s: string) => key(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ph/g, "f").replace(/ck/g, "k").replace(/[cq]/g, "k").replace(/[aeiouy]/g, "").replace(/(.)\1+/g, "$1");
function misheard(from: string, to: string) {
  const a = key(from), b = key(to);
  if (a === b || a.length < 3 || b.length < 3) return false;
  return distance(a, b) <= (Math.max(a.length, b.length) >= 7 ? 2 : 1) || sound(a) === sound(b) && Math.abs(a.length - b.length) <= 3;
}

/** Align whole words; an insertion or deletion cannot masquerade as a corrected word. */
export function correctedWords(inserted: string, final: string): Array<{ from: string; to: string }> {
  const a = tokens(inserted), b = tokens(final);
  if (a.length > 200 || b.length > 200) return [];
  const costs = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) costs[i]![0] = i;
  for (let j = 0; j <= b.length; j++) costs[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) costs[i]![j] = Math.min(
    costs[i - 1]![j]! + 1, costs[i]![j - 1]! + 1, costs[i - 1]![j - 1]! + (key(a[i - 1]!) === key(b[j - 1]!) ? 0 : 2));
  const result: Array<{ from: string; to: string }> = [];
  let i = a.length, j = b.length;
  while (i && j) {
    const same = key(a[i - 1]!) === key(b[j - 1]!);
    if (same && costs[i]![j] === costs[i - 1]![j - 1]) { i--; j--; continue; }
    // A substitution is useful only when its words are genuinely similar; otherwise
    // the optimal two edits are a deletion and an insertion, not a learning signal.
    if (costs[i]![j] === costs[i - 1]![j - 1]! + 2 && misheard(a[i - 1]!, b[j - 1]!)) {
      result.unshift({ from: a[i - 1]!, to: b[j - 1]! }); i--; j--; continue;
    }
    if (costs[i]![j] === costs[i - 1]![j]! + 1) i--;
    else j--;
  }
  return result;
}

export class WriteDictionary {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS write_dictionary (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS write_corrections (source TEXT NOT NULL, target TEXT NOT NULL, occurrences INTEGER NOT NULL, PRIMARY KEY(source,target));
      CREATE TABLE IF NOT EXISTS write_undo (id TEXT PRIMARY KEY, added TEXT NOT NULL, corrections TEXT NOT NULL);`);
  }
  get(): Dictionary {
    const row = this.db.query("SELECT data FROM write_dictionary WHERE id=1").get() as { data: string } | null;
    return row ? JSON.parse(row.data) : { words: [], replacements: [] };
  }
  put(dictionary: Dictionary): Dictionary {
    this.db.query("INSERT INTO write_dictionary(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(dictionary));
    return dictionary;
  }
  learn(inserted: string, final: string): Dictionary & { dictionary: Dictionary; undoId: string | null } {
    const added: Dictionary = { words: [], replacements: [] };
    const corrections = correctedWords(inserted, final);
    const undoId = corrections.length ? crypto.randomUUID() : null;
    const dictionary = this.db.transaction(() => {
      const current = this.get();
      for (const { from, to } of corrections) {
        if (!current.words.some(item => key(item) === key(to))) {
          current.words.push(to); added.words.push(to);
        }
        const source = key(from), target = key(to);
        this.db.query(`INSERT INTO write_corrections(source,target,occurrences) VALUES(?,?,1)
          ON CONFLICT(source,target) DO UPDATE SET occurrences=occurrences+1`).run(source, target);
        const count = this.db.query("SELECT occurrences FROM write_corrections WHERE source=? AND target=?").get(source, target) as { occurrences: number };
        if (count.occurrences >= 2 && !current.replacements.some(rule => key(rule.from) === source)) {
          const replacement = { from, to }; current.replacements.push(replacement); added.replacements.push(replacement);
        }
      }
      if (added.words.length || added.replacements.length) this.put(current);
      if (undoId) this.db.query("INSERT INTO write_undo(id,added,corrections) VALUES(?,?,?)").run(undoId, JSON.stringify(added), JSON.stringify(corrections));
      return current;
    })();
    return { ...added, dictionary, undoId };
  }
  undo(id: string): Dictionary | null {
    return this.db.transaction(() => {
      const receipt = this.db.query("SELECT added,corrections FROM write_undo WHERE id=?").get(id) as { added: string; corrections: string } | null;
      if (!receipt) return null;
      const added = JSON.parse(receipt.added) as Dictionary;
      const corrections = JSON.parse(receipt.corrections) as Array<{ from: string; to: string }>;
      const dictionary = this.get();
      dictionary.words = dictionary.words.filter(word => !added.words.some(item => key(item) === key(word)));
      dictionary.replacements = dictionary.replacements.filter(rule => !added.replacements.some(item => key(item.from) === key(rule.from) && key(item.to) === key(rule.to)));
      this.put(dictionary);
      for (const { from, to } of corrections) this.db.query("UPDATE write_corrections SET occurrences=MAX(0,occurrences-1) WHERE source=? AND target=?").run(key(from), key(to));
      this.db.query("DELETE FROM write_undo WHERE id=?").run(id);
      return dictionary;
    })();
  }
}

export type WriteSocketData = { kind: "write"; upstream?: WebSocket; receive?: (message: string | Uint8Array) => void; started: boolean; finished: boolean };
export function connectWrite(socket: Bun.ServerWebSocket<WriteSocketData>, endpoint: string, dictionary: WriteDictionary) {
  const upstream = new WebSocket(endpoint);
  upstream.binaryType = "arraybuffer";
  socket.data.upstream = upstream;
  const queued: Array<string | Uint8Array> = [];
  let queuedBytes = 0;
  upstream.addEventListener("open", () => { for (const frame of queued) upstream.send(frame); queued.length = 0; queuedBytes = 0; });
  const forward = (frame: string | Uint8Array) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
    else if (upstream.readyState === WebSocket.CONNECTING && queuedBytes + (typeof frame === "string" ? frame.length : frame.byteLength) <= 64 * 1024) {
      queued.push(frame); queuedBytes += typeof frame === "string" ? frame.length : frame.byteLength;
    } else socket.close(1013, "Write engine unavailable or overloaded");
  };
  upstream.addEventListener("message", event => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.getBufferedAmount() > 64 * 1024) { socket.close(1013, "Client is not reading"); return; }
    socket.send(String(event.data));
    try { if (["final", "error"].includes(JSON.parse(String(event.data)).type)) { socket.data.finished = true; socket.close(1000); } } catch { socket.close(1011, "Invalid engine reply"); }
  });
  upstream.addEventListener("error", () => { if (socket.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ type: "error", message: "Write engine unavailable" })); socket.close(1011); } });
  upstream.addEventListener("close", () => { if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Write engine closed before final text"); });
  return (message: string | Uint8Array) => {
    if (typeof message === "string") {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(message); } catch { socket.close(1003, "Invalid Write frame"); return; }
      if (!socket.data.started) {
        if (frame.type !== "start" || typeof frame.dictation !== "string" || frame.dictation.length > 128 || typeof frame.context !== "undefined" && typeof frame.context !== "string" || frame.audio !== undefined && frame.audio !== "pcm" && frame.audio !== "opus") { socket.close(1008, "Expected Write start"); return; }
        socket.data.started = true;
        forward(JSON.stringify({ type: "start", dictation: frame.dictation, dictionary: dictionary.get(), context: String(frame.context ?? "").slice(-2000), audio: frame.audio ?? "pcm" }));
      } else if (!socket.data.finished && (frame.type === "finish" || frame.type === "cancel")) {
        socket.data.finished = true;
        forward(JSON.stringify({ type: frame.type }));
        if (frame.type === "cancel") socket.close(1000);
      } else socket.close(1008, "Unexpected Write frame");
    } else if (socket.data.started && !socket.data.finished && upstream.bufferedAmount < 64 * 1024) forward(message);
    else socket.close(1013, "Write audio backlog or invalid sequence");
  };
}
