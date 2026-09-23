import { expect, test } from "bun:test";
import type { MessagingConversation } from "../server/messaging/protocol";
import { formatTokens, pickerOptions, recentRecipients } from "./src/chat-picker-options";

const names = Array.from({ length: 30 }, (_, index) => `Model ${index + 1}`);

test("eight choices need no search; the ninth enables it without hiding matching choices beyond the first twenty", () => {
  expect(pickerOptions(names.slice(0, 8), "", String)).toEqual({ searchable: false, total: 8, items: names.slice(0, 8) });
  expect(pickerOptions(names.slice(0, 9), "", String).searchable).toBe(true);
  expect(pickerOptions(names, "", String).items).toEqual(names.slice(0, 20));
  expect(pickerOptions(names, " MODEL 30 ", String)).toEqual({ searchable: true, total: 1, items: ["Model 30"] });
  expect(pickerOptions(names, "missing", String).items).toEqual([]);
});

test("recipient choices use activity rather than directory or current-chat order and search the entire backend", () => {
  const conversations: MessagingConversation[] = Array.from({ length: 31 }, (_, index) => ({
    id: `id-${index}`, externalId: `+44100${index}`, backendId: index === 30 ? "other" : "signal", title: `Contact ${index}`,
    kind: index === 29 ? "group" : "direct", updatedAt: index, current: index % 2 === 0, unread: 0,
  }));
  const recent = recentRecipients(conversations, "signal");
  expect(recent[0].kind).toBe("group");
  expect(recent[0].current).toBe(false);
  expect(recent.at(-1)?.id).toBe("id-0");
  expect(conversations[0].id).toBe("id-0");
  expect(pickerOptions(recent, "", item => item.title).items).toHaveLength(20);
  expect(pickerOptions(recent, "+441000", item => `${item.title} ${item.externalId}`).items.map(item => item.id)).toEqual(["id-0"]);
  expect(recentRecipients(conversations, "absent")).toEqual([]);
});

test("token counts round to what a picker row can carry", () => {
  expect(formatTokens(812)).toBe("812");
  expect(formatTokens(1_000)).toBe("1k");
  expect(formatTokens(9_949)).toBe("9.9k");
  expect(formatTokens(39_282)).toBe("39k");
  expect(formatTokens(99_207)).toBe("99k");
  expect(formatTokens(138_489)).toBe("138k");
});
