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
    getElementById(id: string) { return id === "environment-control" ? row : id === "environment-select" ? select : null; },
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

test("offers environment switching on the main browser page and carries person identity", async () => {
  let change: (() => Promise<void>) | undefined;
  let healthRequest: { input: string; init?: RequestInit } | undefined;
  let reloaded = false;
  const state = {
    id: "local",
    name: "Local",
    baseUrl: "",
    environments: [
      { id: "local", name: "Local", baseUrl: "" },
      { id: "converge", name: "Converge", baseUrl: "/converge" },
    ],
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
  const fakeDocument = {
    readyState: "complete",
    title: "",
    getElementById(id: string) { return id === "environment-control" ? row : id === "environment-select" ? select : null; },
    createElement() { return { value: "", textContent: "" }; },
    addEventListener() {},
  };
  const browserFetch = async (input: string, init?: RequestInit) => {
    if (input === "/v1/environments") return Response.json({ environments: state.environments });
    healthRequest = { input, init };
    return Response.json({ ok: true });
  };
  const fakeWindow = {
    Capacitor: undefined,
    fetch: browserFetch,
    location: { href: "https://local.test/", origin: "https://local.test", pathname: "/", reload: () => { reloaded = true; } },
    PiRemotePerson: { get: () => "kenan" },
    open() {},
  };
  const values = new Map<string, string>();
  const fakeStorage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  Object.assign(globalThis, { window: fakeWindow, document: fakeDocument, localStorage: fakeStorage });
  try {
    await import(`./native.js?browser-test=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(row.hidden).toBe(false);
    expect(select.value).toBe("local");

    select.value = "converge";
    await change?.();
    expect(healthRequest?.input).toBe("/converge/v1/health");
    expect(healthRequest?.init?.headers).toEqual({ "x-pi-remote-user": "kenan" });
    expect(values.get("kenan-environment")).toBe("converge");
    expect(reloaded).toBe(true);
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument, localStorage: previousStorage });
  }
});
