import { expect, test } from "bun:test";
import { editorLaunch } from "./src/features/files/editor-launch";

test("editor handoff admits only a one-use POST target without URL credentials", () => {
  expect(editorLaunch({ ok: true, url: "http://alice-editor.example/editor/open", ticket: "a".repeat(43) }).ok).toBe(true);
  for (const url of ["javascript:alert(1)", "http://user:password@alice-editor.example/editor/open", "http://alice-editor.example/editor/open?session=secret", "http://alice-editor.example/", "http://alice-editor.example/editor/open#secret"]) expect(editorLaunch({ ok: true, url, ticket: "a".repeat(43) }).ok).toBe(false);
  expect(editorLaunch({ ok: true, url: "http://alice-editor.example/editor/open", ticket: "not-a-ticket" }).ok).toBe(false);
});
