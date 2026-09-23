import { expect, it } from "vitest";
import { historyPreview } from "../src/threads/pi-history-preview.js";

it("bounds tool history without changing native content or exposing image/signature bytes", () => {
  const entry = { id: "large", type: "message", message: { role: "toolResult", content: [
    { type: "image", mimeType: "image/png", data: "OPAQUE_IMAGE".repeat(100_000) },
    { type: "text", text: "visible text ".repeat(10_000), textSignature: "OPAQUE_SIGNATURE" },
  ] } };
  const first = historyPreview({ entries: [entry], nextCursor: "1" }) as any;
  expect(JSON.stringify(first).length).toBeLessThan(5000);
  expect(JSON.stringify(first)).not.toContain("OPAQUE");
  expect(first.entries[0]).toMatchObject({ entryId: "large", offset: 0, nextOffset: 4000 });
  const chunk = historyPreview({ entries: [entry] }, "large", first.entries[0].nextOffset) as any;
  expect(chunk.entries[0].offset).toBe(4000);
  expect(chunk.entries[0].text.length).toBe(24_000);
  expect(chunk.entries[0].nextOffset).toBe(28_000);
  expect(entry.message.content[0].data).toContain("OPAQUE_IMAGE");
});
