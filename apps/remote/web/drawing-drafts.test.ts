import { expect, test } from "bun:test";
import { findDrawingDraft, type DrawingDraft } from "./src/drawing-drafts";

test("white paper and each source image keep separate drafts in their owning thread", () => {
  const background = { src: "/image.png", alt: "Original" };
  const drafts: DrawingDraft[] = [
    { id: "white", sessionId: "first" },
    { id: "image", sessionId: "first", background },
    { id: "other-thread", sessionId: "second", background },
  ];
  expect(findDrawingDraft(drafts, "first")?.id).toBe("white");
  expect(findDrawingDraft(drafts, "first", { ...background, alt: "New caption" })?.id).toBe("image");
  expect(findDrawingDraft(drafts, "second", background)?.id).toBe("other-thread");
  expect(findDrawingDraft(drafts, "second")).toBeUndefined();
  expect(findDrawingDraft(drafts, "first", { src: "/different.png", alt: "" })).toBeUndefined();
});
