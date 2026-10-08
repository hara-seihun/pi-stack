import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryTimezone, readTimezoneProjection, writeTimezoneProjection } from "../src/person-timezone.js";
import { readPersonTimezone, reconcilePersonTimezoneProjection, writePersonSetting } from "../src/person-settings.js";
import { createMessageDeliveryProjection } from "../src/threads/message-delivery.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
const paths: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() { const data = mkdtempSync(join(tmpdir(), "person-timezone-")); paths.push(data); return { data, file: join(data, "timezone.json") }; }
it("publishes only timezone provenance, preserving observed/configured precedence and real unset", () => {
  const f = fixture();
  expect(readTimezoneProjection(f.file)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(reconcilePersonTimezoneProjection(join(f.data, "missing-private-mount"), f.file)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(reconcilePersonTimezoneProjection(f.data, f.file)).toEqual({ ok: true, value: null });
  expect(readTimezoneProjection(f.file)).toEqual({ ok: true, value: null });
  vi.stubEnv("PI_PERSON_TIMEZONE_FILE", f.file); vi.stubEnv("PI_PERSON_SETTINGS_DATA", f.data);
  writePersonSetting(f.data, "person.timezone", { zone: "Asia/Tokyo", source: "client-observed" }, "2026-10-08T00:00:00Z");
  expect(readTimezoneProjection(f.file)).toEqual(readPersonTimezone(f.data));
  writePersonSetting(f.data, "person.timezone", { zone: "Europe/London", source: "configured" }, "2026-10-08T01:00:00Z");
  writePersonSetting(f.data, "person.timezone", { zone: "Asia/Tokyo", source: "client-observed" }, "2026-10-08T02:00:00Z");
  expect(readTimezoneProjection(f.file)).toMatchObject({ ok: true, value: { zone: "Europe/London", source: "configured" } });
  expect(Object.keys(JSON.parse(readFileSync(f.file, "utf8")))).toEqual(["version", "state", "timezone"]);
  expect(readFileSync(f.file, "utf8")).not.toContain("autoCollapse");
  writePersonSetting(f.data, "person.timezone", null);
  expect(readTimezoneProjection(f.file)).toEqual({ ok: true, value: null });
});
it("fences in-flight/crashed updates, repairs from canonical authority and rejects foreign writes", () => {
  const f = fixture(), foreign = fixture();
  writePersonSetting(f.data, "person.timezone", { zone: "America/New_York", source: "configured" });
  writeTimezoneProjection(f.file, { version: 1, state: "updating" });
  expect(readTimezoneProjection(f.file)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(reconcilePersonTimezoneProjection(f.data, f.file)).toMatchObject({ ok: true, value: { zone: "America/New_York" } });
  vi.stubEnv("PI_PERSON_TIMEZONE_FILE", f.file); vi.stubEnv("PI_PERSON_SETTINGS_DATA", f.data);
  expect(writePersonSetting(foreign.data, "person.timezone", { zone: "Asia/Tokyo", source: "configured" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(readTimezoneProjection(f.file)).toMatchObject({ ok: true, value: { zone: "America/New_York" } });
});
it("fleet delivery reads an exact narrow projection without private directories; missing authority is an error", () => {
  const f = fixture();
  writeTimezoneProjection(f.file, { version: 1, state: "ready", timezone: { zone: "Asia/Tokyo", source: "configured", observedAt: "2026-10-08T00:00:00Z" } });
  const project = createMessageDeliveryProjection(SessionManager.inMemory(), { PI_PERSON_TIMEZONE_FILE: f.file, PI_PERSON_SETTINGS_DATA: "/inaccessible/private/settings" }, () => 0);
  const result = project([{ role: "user", content: "fleet input", timestamp: 1 }]);
  expect(result).toMatchObject({ ok: true });
  expect(JSON.stringify(result)).toContain("Asia/Tokyo");
  expect(deliveryTimezone({})).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(deliveryTimezone({ PI_MODEL_DELIVERY_TIMEZONE: "null", PI_PERSON_TIMEZONE_FILE: "/inaccessible/other-person" })).toEqual({ ok: true, value: null });
  expect(deliveryTimezone({ PI_MODEL_DELIVERY_TIMEZONE: '{"zone":"+01:00","source":"configured","observedAt":"2026-10-08T00:00:00Z"}' })).toMatchObject({ ok: false, error: { code: "invalid" } });
});
it("rejects projection symlinks and unknown schema states instead of exposing another file", () => {
  const f = fixture(); writeTimezoneProjection(f.file, { version: 1, state: "ready", timezone: null });
  const link = join(f.data, "link.json"); symlinkSync(f.file, link);
  expect(readTimezoneProjection(link)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  writeFileSync(f.file, JSON.stringify({ version: 1, state: "ready", timezone: null, private: "rejected" }));
  expect(readTimezoneProjection(f.file)).toMatchObject({ ok: false, error: { code: "invalid" } });
});
it("publishes group-readable projection even under supervisor UMask 0077", () => {
  const f = fixture(), mask = process.umask(0o077);
  try {
    expect(writeTimezoneProjection(f.file, { version: 1, state: "ready", timezone: null })).toEqual({ ok: true, value: null });
    expect(statSync(f.file).mode & 0o777).toBe(0o640);
  } finally { process.umask(mask); }
});
