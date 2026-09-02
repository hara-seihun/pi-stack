import { expect, test } from "bun:test";

test("passes the selected person when Android verifies a new environment", async () => {
  let change: (() => Promise<void>) | undefined;
  let selected: unknown;
  let reloaded = false;
  const state = {
    id: "local",
    name: "Local",
    baseUrl: "https://local.test",
    requiresUnlock: true,
    requiresPreparation: false,
    environments: [{ id: "local", name: "Local" }, { id: "converge", name: "Converge" }],
  };
  const select = {
    value: "",
    disabled: false,
    replaceChildren() {},
    addEventListener(name: string, listener: () => Promise<void>) {
      if (name === "change") change = listener;
    },
  };
  const row = { hidden: true, title: "", classList: { add() {} } };
  const remote = {
    async getState() { return state; },
    async prepare() {},
    async select(options: unknown) { selected = options; return { ...state, id: "converge", name: "Converge" }; },
    async haptic() {},
  };
  const fakeDocument = {
    readyState: "complete",
    title: "",
    getElementById(id: string) { return id === "native-environment" ? row : id === "native-environment-select" ? select : null; },
    createElement() { return { value: "", textContent: "" }; },
    addEventListener() {},
  };
  const fakeWindow = {
    Capacitor: {
      isNativePlatform: () => true,
      registerPlugin: () => remote,
    },
    fetch: async () => new Response(),
    location: { href: "http://localhost/", origin: "http://localhost", pathname: "/", reload: () => { reloaded = true; } },
    PiRemotePerson: { get: () => "kenan" },
    open() {},
  };

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: fakeWindow, document: fakeDocument });
  try {
    await import(`./native.js?test=${Date.now()}`);
    await Promise.resolve();
    select.value = "converge";
    await change?.();
    expect(selected).toEqual({ id: "converge", user: "kenan" });
    expect(reloaded).toBe(true);
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
});
