import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { connectWrite, WriteDictionary, type WriteSocketData } from "./write";

test("supervisor injects its person's dictionary and relays streaming engine frames", async () => {
  let start: any;
  let pcm: number[] = [];
  const engine = Bun.serve({ port: 0, fetch(req, server) { return server.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 }); }, websocket: {
    message(socket, frame) {
      if (typeof frame === "string") {
        const input = JSON.parse(frame);
        if (input.type === "start") start = input;
        if (input.type === "finish") socket.send(JSON.stringify({ type: "final", text: "Kelana", raw: "Keelana", edits: [], timing: { flushMs: 2 } }));
      } else {
        pcm = [...frame]; socket.send(JSON.stringify({ type: "partial", committed: "Kela", tail: "na" }));
      }
    },
  } });
  const db = new Database(":memory:");
  const dictionary = new WriteDictionary(db);
  dictionary.put({ words: ["Kelana"], replacements: [] });
  const supervisor = Bun.serve<WriteSocketData>({ port: 0, fetch(req, server) { return server.upgrade(req, { data: { kind: "write", started: false, finished: false } }) ? undefined : new Response("upgrade required", { status: 426 }); }, websocket: {
    open(socket) { socket.data.receive = connectWrite(socket, `ws://127.0.0.1:${engine.port}/`, dictionary); },
    message(socket, frame) { socket.data.receive?.(frame); },
    close(socket) { socket.data.upstream?.close(); },
  } });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${supervisor.port}/`);
    await new Promise<void>(resolve => socket.addEventListener("open", () => resolve(), { once: true }));
    const partial = new Promise<any>(resolve => socket.addEventListener("message", event => resolve(JSON.parse(event.data)), { once: true }));
    socket.send(JSON.stringify({ type: "start", dictation: "a", dictionary: { words: ["attacker"], replacements: [] } }));
    socket.send(new Uint8Array([1, 2, 3, 4]));
    expect(await partial).toMatchObject({ type: "partial", committed: "Kela", tail: "na" });
    const final = new Promise<any>(resolve => socket.addEventListener("message", event => resolve(JSON.parse(event.data)), { once: true }));
    socket.send(JSON.stringify({ type: "finish" }));
    expect(await final).toMatchObject({ type: "final", text: "Kelana", timing: { flushMs: 2 } });
    expect(start.dictionary).toEqual({ words: ["Kelana"], replacements: [] });
    expect(pcm).toEqual([1, 2, 3, 4]);
    socket.close();
  } finally { supervisor.stop(); engine.stop(); db.close(); }
});
