import { expect, it } from "vitest";
import { nativeProtocol, NATIVE_PROTOCOL } from "../src/threads/native-protocol.js";

it("never treats a versionless fresh runner as batch capable", () => {
  const old = { isStreaming: true, acceptedWorkIds: ["original"], landedWorkIds: ["original"], completedWorkIds: [] };
  expect(nativeProtocol(old, true)).toBe("draining");
  expect(() => nativeProtocol(old, false)).toThrow("Fresh native runner");
  expect(() => nativeProtocol({ ...old, acceptedWorkIds: undefined }, true)).toThrow("exact acceptedWorkIds");
  expect(() => nativeProtocol({ ...old, nativeProtocolVersion: "unknown" }, true)).toThrow("Unsupported native protocol");
  expect(nativeProtocol({ nativeProtocolVersion: NATIVE_PROTOCOL }, false)).toBe("current");
});
