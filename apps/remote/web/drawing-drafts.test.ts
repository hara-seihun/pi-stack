import { expect, test } from "bun:test";
import { findDrawingDraft, type DrawingDraft } from "./src/drawing-drafts";

test("white paper and each source image keep separate drafts in their owning chat", () => {
  const background = { src: "/image.png", alt: "Original" };
  const drafts: DrawingDraft[] = [
    { id: "white", chatId: "agent" },
    { id: "image", chatId: "agent", background },
    { id: "other-image", chatId: "other-agent", background },
  ];
  expect(findDrawingDraft(drafts, "agent")?.id).toBe("white");
  expect(findDrawingDraft(drafts, "agent", { ...background, alt: "New caption" })?.id).toBe("image");
  expect(findDrawingDraft(drafts, "other-agent", background)?.id).toBe("other-image");
  expect(findDrawingDraft(drafts, "other-agent")).toBeUndefined();
  expect(findDrawingDraft(drafts, "agent", { src: "/different.png", alt: "" })).toBeUndefined();
});
