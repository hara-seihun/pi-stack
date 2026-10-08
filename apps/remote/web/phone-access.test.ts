import { expect, test } from "bun:test";
import { phoneGrants, requestPhoneGrant } from "./src/phone-access";
import type { PhoneSetupStep, PhoneStatus } from "./src/native";

function fixture() {
  const status: PhoneStatus = { enabled: false, connected: false, deviceId: "test", name: "Emulator", environment: "test", capabilities: Object.fromEntries(phoneGrants.map(({ step }) => [step, false])) };
  const requests: PhoneSetupStep[] = [];
  let active = true;
  const driver = { status: async () => structuredClone(status), active: () => active,
    request: async (step: PhoneSetupStep) => { requests.push(step); status.capabilities[step] = true; } };
  return { status, requests, driver, stop: () => { active = false; } };
}

test("one grant waits for Android return, rechecks actual capability and does not request other access", async () => {
  const f = fixture();
  let returned!: () => void;
  f.driver.request = async step => { f.requests.push(step); await new Promise<void>(resolve => { returned = resolve; }); };
  const pending = requestPhoneGrant(f.driver, "sms");
  await Promise.resolve(); await Promise.resolve();
  expect(f.requests).toEqual(["sms"]);
  returned();
  const result = await pending;
  expect(result.state).toBe("denied");
  expect(f.status.enabled).toBe(false);
  expect(f.requests).toEqual(["sms"]);
});

test("granting one capability does not require all permissions or enable phone control", async () => {
  const f = fixture();
  expect((await requestPhoneGrant(f.driver, "contacts")).state).toBe("granted");
  expect(f.status.capabilities.sms).toBe(false);
  expect(f.status.enabled).toBe(false);
  expect(f.requests).toEqual(["contacts"]);
  await requestPhoneGrant(f.driver, "contacts");
  expect(f.requests).toEqual(["contacts"]);
});

test("unavailable and retired grants never request Android access", async () => {
  const f = fixture();
  delete f.status.capabilities.camera;
  expect((await requestPhoneGrant(f.driver, "camera")).state).toBe("error");
  f.status.capabilities.writeAccessibility = false;
  expect((await requestPhoneGrant(f.driver, "writeAccessibility")).state).toBe("error");
  expect(f.requests).toEqual([]);
});

test("background location requires the actual foreground grant first", async () => {
  const f = fixture();
  expect((await requestPhoneGrant(f.driver, "backgroundLocation")).state).toBe("error");
  expect(f.requests).toEqual([]);
  f.status.capabilities.location = true;
  expect((await requestPhoneGrant(f.driver, "backgroundLocation")).state).toBe("granted");
  expect(f.requests).toEqual(["backgroundLocation"]);
});

test("identity change while Android settings is open prevents accepting the result", async () => {
  const f = fixture();
  f.driver.request = async step => { f.requests.push(step); f.stop(); };
  expect((await requestPhoneGrant(f.driver, "sms")).state).toBe("cancelled");
  expect(f.requests).toEqual(["sms"]);
});

test("Android failures remain errors rather than permission success", async () => {
  const f = fixture();
  f.driver.request = async () => { throw new Error("Restricted by Android"); };
  expect(await requestPhoneGrant(f.driver, "sms")).toEqual({ state: "error", message: "Restricted by Android" });
});
