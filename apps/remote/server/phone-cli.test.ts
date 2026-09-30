import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePhoneArgs, phoneEndpoint, runPhoneCli, savePhoneBinary } from "./phone-cli";

test("ergonomic arguments and generic stdin obey the same catalogue", () => {
  const parsed = parsePhoneArgs(["--device", "phone", "tap", "123", "456", "--timeout", "500"]);
  expect(parsed.ok).toBe(true);
  if (parsed.ok && parsed.value.kind === "command") expect(parsed.value).toMatchObject({ command: "ui.tap", args: { x: 123, y: 456 }, options: { phone: "phone", timeoutMs: 500 } });
  expect(parsePhoneArgs(["command", "device.wipe", "-"] , () => '{"confirm":true}').ok).toBe(true);
  expect(parsePhoneArgs(["command", "device.wipe"]).ok).toBe(false);
  expect(parsePhoneArgs(["tap", "NaN", "4"]).ok).toBe(false);
  expect(parsePhoneArgs(["screenshot"]).ok).toBe(false);
  expect(parsePhoneArgs(["screenshot", "--out", "/exact.png"]).ok).toBe(true);
  expect(parsePhoneArgs(["command", "files.write", '{"path":"a","base64":"YQ==","overwrite":true}']).ok).toBe(false);
  expect(parsePhoneArgs(["command", "settings.put", '{"key":"a","value":null,"confirm":true}']).ok).toBe(true);
});

test("binary files save bytes at exactly the requested path; file write encodes exact bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "phone-cli-"));
  try {
    const path = join(directory, "arbitrary.filename"); const bytes = Buffer.from([0, 255, 1, 127]);
    expect(savePhoneBinary({ base64: bytes.toString("base64") }, path)).toEqual({ ok: true, path, bytes: 4 });
    expect(readFileSync(path)).toEqual(bytes);
    const parsed = parsePhoneArgs(["files", "write", "/phone/target", "--input", path, "--overwrite", "--confirm"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.kind === "command") expect(parsed.value.args).toEqual({ path: "/phone/target", base64: bytes.toString("base64"), overwrite: true, confirm: true });
    expect(savePhoneBinary({ base64: "bad%" }, path).ok).toBe(false);
    expect(savePhoneBinary({ base64: "YQ==", nextOffset: 1 }, path).ok).toBe(false);
    expect(readFileSync(path)).toEqual(bytes);
    expect(savePhoneBinary({ base64: "YQ==", nextOffset: null }, join(directory, "complete"))).toMatchObject({ ok: true, bytes: 1 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("endpoint uses only the current Unix person's registry, not a selection header", () => {
  const directory = mkdtempSync(join(tmpdir(), "phone-person-"));
  try {
    writeFileSync(join(directory, "alice.json"), JSON.stringify({ version: 1, user: "alice", port: 12345, environment: {} }));
    expect(phoneEndpoint({ PI_REMOTE_PERSONS_DIR: directory }, "alice")).toEqual({ ok: true, url: "http://127.0.0.1:12345", headers: { "content-type": "application/json" } });
    expect(phoneEndpoint({ PI_REMOTE_PERSONS_DIR: directory }, "bob").ok).toBe(false);
    expect(phoneEndpoint({ PI_PHONE_URL: "https://router/v1/remotes/desk", PI_REMOTE_SESSION: "session" }, "alice")).toMatchObject({ ok: true, url: "https://router/v1/remotes/desk", headers: { "x-pi-remote-session": "session", "x-pi-remote-user": "alice" } });
    expect(phoneEndpoint({ PI_PHONE_URL: "https://secret@router" }, "alice").ok).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("CLI never retries an uncertain mutation", async () => {
  const previous = process.env.PI_PHONE_URL; process.env.PI_PHONE_URL = "http://127.0.0.1:12345";
  const outputs: any[] = []; let posts = 0;
  try {
    const code = await runPhoneCli(["tap", "1", "2"], { out: value => outputs.push(value), error: message => outputs.push(message), help: () => {} }, (async (_url, options) => {
      if (options?.method === "POST") { posts++; throw new Error("lost reply"); }
      return Response.json({ phones: [{ id: "phone", connected: true }] });
    }) as typeof fetch);
    expect(code).toBe(1); expect(posts).toBe(1); expect(outputs[0].error.code).toBe("unconfirmed");
  } finally { if (previous === undefined) delete process.env.PI_PHONE_URL; else process.env.PI_PHONE_URL = previous; }
});
