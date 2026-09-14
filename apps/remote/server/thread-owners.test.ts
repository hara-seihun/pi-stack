import { expect, test } from "bun:test";
import { fleetThreadUrl } from "./thread-owners";

test("fleet control authority follows the configured Unix owner, not observer access", () => {
  expect(fleetThreadUrl({ fleetUser: "kenan" }, "sybil", "http://127.0.0.1:2460")).toBeNull();
  expect(fleetThreadUrl({}, "kenan")).toBeNull();
  expect(fleetThreadUrl({ fleetUser: "kenan" }, "kenan")).toBe("http://127.0.0.1:2460");
});
