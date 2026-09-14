import { expect, it } from "vitest";
import { Store } from "../src/store.js";

it("defaults lanes to forced admission and retains explicit background pacing", () => {
  const store = Store.open(":memory:");
  try {
    store.reconcileLanes([
      { id: "forced", cwd: "/tmp", prompt: "work", profile: "astra", weight: 1 },
      { id: "paced", cwd: "/tmp", prompt: "work", profile: "terra", weight: 2, admission: "background" },
    ]);
    expect(store.lane("forced")?.admission).toBe("force");
    expect(store.lane("paced")?.admission).toBe("background");
    expect(() => store.reconcileLanes([{ id: "bad", cwd: "/tmp", prompt: "work", profile: "astra", weight: 1, admission: "urgent" as never }])).toThrow("admission must be force or background");
  } finally { store.close(); }
});
