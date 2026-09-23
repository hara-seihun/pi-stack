import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessagingBackendInfo, MessagingLink } from "../server/messaging/protocol";
import { linkStage, MessagingLinkPanel } from "./src/messaging-link";

const backend = (status: MessagingBackendInfo["status"], link: MessagingLink | null = null, linkable = true): MessagingBackendInfo => ({
  id: "signal", label: "Signal", plugin: "signal", icon: "signal",
  capabilities: { attachments: true, groups: true }, status, detail: "", linkable, link,
});
const link = (extra: Partial<MessagingLink> = {}): MessagingLink => ({
  status: "waiting", uri: "sgnl://linkdevice?uuid=u&pub_key=k", qr: "<svg viewBox=\"0 0 21 21\"></svg>",
  deviceName: "PiStack", account: null, error: null, updatedAt: 1, ...extra,
});
const panel = (info: MessagingBackendInfo, props: Partial<Parameters<typeof MessagingLinkPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(MessagingLinkPanel, {
    backend: info, deviceName: "PiStack", onDeviceName() {}, onStart() {}, onCancel() {},
    busy: false, error: "", copied: false, onCopy() {}, ...props,
  }));

test("linking is offered only where an account can still be linked", () => {
  expect(linkStage(backend("unconfigured"))).toBe("idle");
  expect(linkStage(backend("error"))).toBe("idle");
  expect(linkStage(backend("ready"))).toBe("hidden");
  expect(linkStage(backend("unconfigured", null, false))).toBe("hidden");
  expect(linkStage(backend("unconfigured", link()))).toBe("waiting");
  expect(linkStage(backend("connecting", link({ status: "linked", uri: null, qr: null, account: "+12025550100" })))).toBe("connecting");
  expect(linkStage(backend("unconfigured", link({ status: "failed", uri: null, qr: null, error: "Link request timed out" })))).toBe("failed");
  expect(linkStage(backend("unconfigured", link({ status: "cancelled", uri: null, qr: null })))).toBe("idle");
  expect(panel(backend("ready"))).toBe("");
  expect(panel(backend("unconfigured", null, false))).toBe("");
});

test("an unlinked account gets a named device and one start control", () => {
  const html = panel(backend("unconfigured"));
  expect(html).toContain("Link Signal");
  expect(html).toContain('value="PiStack"');
  expect(html).toContain("linked devices");
  expect(html).not.toContain("<svg");
});

test("a waiting link shows the scannable code, the phone link and a cancel control", () => {
  const html = panel(backend("unconfigured", link()));
  expect(html).toContain('role="img" aria-label="Signal device link code"');
  expect(html).toContain('<svg viewBox="0 0 21 21">');
  expect(html).toContain('href="sgnl://linkdevice?uuid=u&amp;pub_key=k"');
  expect(html).toContain("Copy link");
  expect(html).toContain("Cancel");
  expect(html).toContain("Settings, then Linked devices");
  expect(panel(backend("unconfigured", link()), { copied: true })).toContain("Link copied");
});

test("a host without qrencode still offers the link, and failures keep a retry", () => {
  const plain = panel(backend("unconfigured", link({ qr: null })));
  expect(plain).toContain("cannot draw the code");
  expect(plain).toContain("sgnl://linkdevice");
  const failed = panel(backend("unconfigured", link({ status: "failed", uri: null, qr: null, error: "Link request timed out" })));
  expect(failed).toContain("Link request timed out");
  expect(failed).toContain("Try again");
  expect(panel(backend("connecting", link({ status: "linked", uri: null, qr: null, account: "+12025550100" })))).toContain("Linked as +12025550100");
});

test("a request failure is shown without discarding the waiting code", () => {
  const html = panel(backend("unconfigured", link()), { error: "Messaging is handing over" });
  expect(html).toContain("Messaging is handing over");
  expect(html).toContain("<svg");
});
