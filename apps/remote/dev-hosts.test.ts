import { expect, test } from "bun:test";
import { devAllowedHosts } from "./dev-hosts";

test("an unconfigured dev server accepts only Vite's built-in localhost hosts", () => {
  expect(devAllowedHosts(undefined)).toEqual([]);
});

test("explicit hostnames allow a host-owned private domain", () => {
  expect(devAllowedHosts("work.example.test, phone.example.test")).toEqual(["work.example.test", "phone.example.test"]);
});

test("reject URLs, wildcard bypasses and empty host entries", () => {
  for (const input of ["https://work.example.test", "true", ".", "work.example.test,", "*.example.test"]) {
    expect(() => devAllowedHosts(input)).toThrow("PI_REMOTE_DEV_ALLOWED_HOSTS");
  }
});
