import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { isRoomSession, assertRoomTools, ROOM_TOOLS, roomSessionInstructions } from "../src/threads/room-session.js";

describe("unprivileged room runtime", () => {
  it("requires fixed server-side runtime identity and room ID", () => {
    assert.equal(isRoomSession({}, "room"), false);
    assert.throws(() => isRoomSession({ PI_REMOTE_ROOMS_RUNTIME: "1", PI_REMOTE_SENDER_ID: "alice", PI_REMOTE_ROOM_ID: "room" }, "room"));
    assert.throws(() => isRoomSession({ PI_REMOTE_ROOMS_RUNTIME: "1", PI_REMOTE_SENDER_ID: "pi-rooms", PI_REMOTE_ROOM_ID: "another" }, "room"));
    assert.equal(isRoomSession({ PI_REMOTE_ROOMS_RUNTIME: "1", PI_REMOTE_SENDER_ID: "pi-rooms", PI_REMOTE_ROOM_ID: "room" }, "room"), true);
  });
  it("has only root-request and public-question tools, never memory/file/shell/thread access", () => {
    assert.deepEqual(ROOM_TOOLS, ["ask_kenan", "request_user_input_async"]);
    assertRoomTools([...ROOM_TOOLS]);
    for (const forbidden of ["read", "bash", "write", "edit", "memory_read", "thread_read", "thread_list", "thread_send"]) assert.throws(() => assertRoomTools([...ROOM_TOOLS, forbidden]));
    assert.throws(() => assertRoomTools(["request_user_input_async"]));
  });
  it("loads the current full audience each turn and keeps room work transparent", async () => {
    const originalFetch = globalThis.fetch;
    const handlers = new Map<string, Function>();
    const env = { PI_REMOTE_SERVER_URL: "http://127.0.0.1:19901", PI_REMOTE_ROOM_ID: "room" };
    let roster = "Alice and Bob";
    vi.stubGlobal("fetch", async () => Response.json({ instructions: roster }));
    try {
      roomSessionInstructions(env).factory({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any);
      const before = handlers.get("before_agent_start")!;
      assert.match((await before()).systemPrompt, /Alice and Bob/);
      roster = "Alice, Bob and Cara";
      assert.match((await before()).systemPrompt, /Alice, Bob and Cara/);
      assert.match((await before()).systemPrompt, /fully transparent/);
      vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
      await assert.rejects(before(), /Room audience unavailable/);
    } finally { globalThis.fetch = originalFetch; }
  });
});
