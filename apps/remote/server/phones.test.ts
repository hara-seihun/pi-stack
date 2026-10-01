import { describe, expect, test } from "bun:test";
import { PhoneBroker, phoneCallerAllowed, type PhoneConnection } from "./phones";

function connect(broker: PhoneBroker, id = "device-1") {
  const sent: any[] = []; const closes: number[] = [];
  const connection = broker.open({ send(frame) { sent.push(JSON.parse(frame)); return frame.length; }, close(code) { closes.push(code); } });
  broker.receive(connection, JSON.stringify({ type: "hello", device: { id, name: "Phone", model: "Pixel", android: "16", capabilities: { accessibility: true } } }));
  return { connection, sent, closes };
}
function result(broker: PhoneBroker, connection: PhoneConnection, id: string, payload: unknown = {}) {
  broker.receive(connection, JSON.stringify({ type: "result", id, ok: true, result: payload }));
}

describe("phone broker custody", () => {
  test("request results correlate only on their owning connection; refreshed grants preserve identity", async () => {
    const broker = new PhoneBroker(); const a = connect(broker); const b = connect(broker, "device-2");
    const pending = broker.execute("device-1", { command: "ui.tap", args: { x: 1, y: 2 } });
    const command = a.sent[1];
    expect(command.type).toBe("command"); expect(command.deadline).toBeGreaterThan(Date.now());
    result(broker, b.connection, command.id, "wrong-device");
    expect(a.connection.pending.size).toBe(1);
    result(broker, a.connection, command.id, { tapped: true });
    expect(await pending).toEqual({ type: "result", id: command.id, ok: true, result: { tapped: true } });
    broker.receive(a.connection, JSON.stringify({ type: "hello", device: { id: "device-1", name: "Phone", model: "Pixel", android: "16", capabilities: { accessibility: false } } }));
    expect(broker.list().phones[0]!.capabilities.accessibility).toBe(false);
    broker.stop();
  });

  test("offline means no queue, timeout/disconnect/replacement mean unconfirmed and no retry", async () => {
    const broker = new PhoneBroker();
    const offline = await broker.execute("device-1", { command: "status" });
    expect(offline.ok).toBe(false); if (!offline.ok) expect(offline.error.code).toBe("disconnected");
    const a = connect(broker);
    const expired = await broker.execute("device-1", { command: "ui.tap", args: { x: 3, y: 4 }, timeoutMs: 5 });
    expect(expired.ok).toBe(false); if (!expired.ok) expect(expired.error.code).toBe("unconfirmed");
    expect(a.sent.length).toBe(2); expect(a.connection.pending.size).toBe(0);
    const lost = broker.execute("device-1", { command: "status" });
    const b = connect(broker);
    expect((await lost).ok).toBe(false); expect(a.closes).toEqual([1012]);
    expect(b.sent).toEqual([{ type: "ready" }]);
    broker.disconnected(a.connection);
    expect(broker.list().phones[0]!.connected).toBe(true);
    const stopped = broker.execute("device-1", { command: "status" });
    broker.stop(); expect((await stopped).ok).toBe(false);
    expect(b.connection.pending.size).toBe(0); expect(broker.list().phones[0]!.connected).toBe(false);
  });

  test("identity changes close the connection and settle dispatched work", async () => {
    const broker = new PhoneBroker(); const a = connect(broker);
    const pending = broker.execute("device-1", { command: "status" });
    broker.receive(a.connection, JSON.stringify({ type: "hello", device: { id: "another", name: "X", model: "X", android: "16", capabilities: {} } }));
    expect((await pending).ok).toBe(false); expect(a.closes).toEqual([1008]);
    expect(broker.list().phones).toHaveLength(1); broker.stop();
  });

  test("caller abort cleans pending state; late result cannot recover a timed-out command", async () => {
    const broker = new PhoneBroker(); const a = connect(broker); const controller = new AbortController();
    const pending = broker.execute("device-1", { command: "status" }, controller.signal);
    controller.abort(); const outcome = await pending;
    expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe("unconfirmed");
    result(broker, a.connection, a.sent[1].id, "late");
    expect(a.connection.pending.size).toBe(0); broker.stop();
  });

  test("API validates destructive grants, bounded deadlines and never dispatches invalid requests", async () => {
    const broker = new PhoneBroker(); const a = connect(broker);
    for (const input of [{ command: "device.wipe" }, { command: "status", timeoutMs: 60_001 }, { command: "ui.tap", args: { x: 1, y: 2, surprise: true } }]) {
      const response = await broker.handle(new Request("http://local/v1/phones/device-1/commands", { method: "POST", body: JSON.stringify(input) }));
      expect(response!.status).toBe(400);
    }
    expect(a.sent.length).toBe(1);
    const catalogue = await broker.handle(new Request("http://local/v1/phones/commands"));
    expect((await catalogue!.json()).commands.some((item: any) => item.command === "device.wipe")).toBe(true); broker.stop();
  });

  test("a user header is not authentication; only verified router can enroll a phone", () => {
    expect(phoneCallerAllowed({ kind: "process", uid: -1 }, 1000)).toBe(false);
    expect(phoneCallerAllowed({ kind: "process", uid: 1001 }, 1000)).toBe(false);
    expect(phoneCallerAllowed({ kind: "process", uid: 1000 }, 1000)).toBe(true);
    expect(phoneCallerAllowed({ kind: "thread" }, 1000)).toBe(true);
    expect(phoneCallerAllowed({ kind: "thread" }, 1000, true)).toBe(false);
    expect(phoneCallerAllowed({ kind: "person" }, 1000, true)).toBe(true);
  });
});
