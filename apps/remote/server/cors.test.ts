import { describe, expect, it } from "bun:test";
import { preflight, withCors } from "./cors";

describe("Pi Remote CORS", () => {
  it("allows the Android person's routing header during preflight", () => {
    const response = preflight();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-pi-remote-user");
  });

  it("makes router-owned API responses visible to the Android WebView", async () => {
    const response = withCors(Response.json({ error: "Say who you are" }, { status: 423 }));
    expect(response.status).toBe(423);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost");
    expect(await response.json()).toEqual({ error: "Say who you are" });
  });
});
