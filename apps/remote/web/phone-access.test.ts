import { expect, test } from "bun:test";
import { allPermissionsGranted, phoneGrants, requestPhoneAccess } from "./src/phone-access";
import type { PhoneSetupStep, PhoneStatus } from "./src/native";

function fixture(missing: PhoneSetupStep[]) {
  const status: PhoneStatus = { enabled: false, connected: false, deviceId: "test", name: "Emulator", environment: "test",
    capabilities: Object.fromEntries(phoneGrants.map(({ step }) => [step, !missing.includes(step)])) };
  const requests: PhoneSetupStep[] = [];
  let active = true;
  const driver = { status: async () => structuredClone(status), active: () => active, progress: () => {},
    request: async (step: PhoneSetupStep) => { requests.push(step); status.capabilities[step] = true; } };
  return { status, requests, driver, stop: () => { active = false; } };
}

test("one setup chains missing access only, waits for return, then rechecks actual grants", async () => {
  const f = fixture(["accessibility", "sms", "overlay"]);
  let returned!: () => void;
  let waiting = true;
  f.driver.request = async step => {
    f.requests.push(step);
    if (step === "accessibility" && waiting) {
      waiting = false;
      await new Promise<void>(resolve => { returned = resolve; });
    } else if (step !== "accessibility") f.status.capabilities[step] = true;
  };
  const result = requestPhoneAccess(f.driver);
  await Promise.resolve(); await Promise.resolve();
  expect(f.requests).toEqual(["accessibility"]);
  returned();
  expect((await result).completed).toBe(true);
  expect(f.requests).toEqual(["accessibility", "sms", "overlay"]);
  expect((await result).status.capabilities.accessibility).toBe(false);
  f.requests.length = 0;
  await requestPhoneAccess(f.driver);
  expect(f.requests).toEqual(["accessibility"]);
});

test("denial and unavailable system screens do not stop remaining requests or claim success", async () => {
  const f = fixture(["sms", "contacts", "calendar"]);
  f.driver.request = async step => {
    f.requests.push(step);
    if (step === "sms") throw new Error("Restricted by Android");
    if (step === "calendar") f.status.capabilities[step] = true;
  };
  const result = await requestPhoneAccess(f.driver);
  expect(f.requests).toEqual(["sms", "contacts", "calendar"]);
  expect(result.granted).toBe(false);
  expect(result.failures.sms).toContain("Restricted by Android");
  expect(result.status.capabilities.contacts).toBe(false);
  expect(result.status.capabilities.calendar).toBe(true);
});

test("background location is a separate request and depends on foreground location", async () => {
  const f = fixture(["location", "backgroundLocation", "overlay"]);
  f.driver.request = async step => { f.requests.push(step); };
  const result = await requestPhoneAccess(f.driver);
  expect(f.requests).toEqual(["location", "overlay"]);
  expect(result.failures.backgroundLocation).toContain("Location must be granted first");
  f.status.capabilities.location = true;
  f.requests.length = 0;
  await requestPhoneAccess(f.driver);
  expect(f.requests).toEqual(["backgroundLocation", "overlay"]);
});

test("unmount, stop or identity change while settings is open prevents any further requests", async () => {
  const f = fixture(["accessibility", "sms"]);
  f.driver.request = async step => { f.requests.push(step); f.stop(); };
  expect((await requestPhoneAccess(f.driver)).completed).toBe(false);
  expect(f.requests).toEqual(["accessibility"]);
});

test("readiness requires every app grant including both accessibility services", async () => {
  const f = fixture([]);
  expect(allPermissionsGranted(f.status)).toBe(true);
  for (const { step } of phoneGrants) {
    f.status.capabilities[step] = false;
    expect(allPermissionsGranted(f.status)).toBe(false);
    f.status.capabilities[step] = true;
  }
  delete f.status.capabilities.writeAccessibility;
  expect(allPermissionsGranted(f.status)).toBe(false);
  f.status.capabilities.writeAccessibility = true;
  expect((await requestPhoneAccess(f.driver)).granted).toBe(true);
  expect(f.requests).toEqual([]);
});

test("Write settings return is awaited and denied Write access never becomes ready", async () => {
  const f = fixture(["writeAccessibility", "notifications"]);
  let returned!: () => void;
  f.driver.request = async step => {
    f.requests.push(step);
    if (step === "writeAccessibility") await new Promise<void>(resolve => { returned = resolve; });
    else f.status.capabilities[step] = true;
  };
  const result = requestPhoneAccess(f.driver);
  await Promise.resolve(); await Promise.resolve();
  expect(f.requests).toEqual(["writeAccessibility"]);
  returned();
  expect((await result).completed).toBe(true);
  expect((await result).granted).toBe(false);
  expect(f.requests).toEqual(["writeAccessibility", "notifications"]);
});
