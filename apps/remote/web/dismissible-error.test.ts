import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DismissibleError } from "./src/dismissible-error";

const feedback = (message: string, resetKey?: string | number) => DismissibleError({ message, resetKey });

test("empty feedback unmounts dismissal state", () => {
  for (const message of ["", null, undefined]) {
    expect(DismissibleError({ message })).toBeNull();
  }
});

test("unchanged feedback keeps its dismissal identity; new failures reset it", () => {
  expect(feedback("offline")!.key).toBe(feedback("offline")!.key);
  expect(feedback("offline")!.key).not.toBe(feedback("denied")!.key);
  expect(feedback("offline", 1)!.key).not.toBe(feedback("offline", 2)!.key);
});

test("dismiss control is named, excluded from the alert text, and cannot submit a form", () => {
  const html = renderToStaticMarkup(createElement(DismissibleError, { message: "<offline>", dismissLabel: "Dismiss stop error" }));
  expect(html).toContain('role="alert">&lt;offline&gt;</div>');
  expect(html).toContain('type="button" aria-label="Dismiss stop error"');
  expect(html).toContain('<span aria-hidden="true">×</span>');
});

test("background feedback can keep a polite status role", () => {
  const html = renderToStaticMarkup(createElement(DismissibleError, { message: "offline", role: "status" }));
  expect(html).toContain('role="status"');
  expect(html).not.toContain('role="alert"');
});
