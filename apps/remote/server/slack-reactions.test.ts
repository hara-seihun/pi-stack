import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackReactions, slackEmojiName } from "./slack-reactions";

const target = { transport: "slack" as const, workspace: "T146AV69K", channel: "C0BD8R4PCBC", messageId: "1787339329.750899" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function commandFixture(result: { alreadyPresent?: boolean; dryRun?: boolean; reacted?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "slack-reaction-"));
  dirs.push(dir);
  const file = join(dir, "args.json");
  const script = join(dir, "sender.cjs");
  writeFileSync(script, `const fs = require('node:fs');
const args = process.argv.slice(3);
fs.writeFileSync(process.argv[2], JSON.stringify(args));
const field = name => args[args.indexOf(name) + 1];
console.log(JSON.stringify({channel: field('--channel'), timestamp: field('--timestamp'), emoji: field('--emoji'), dryRun: false, reacted: true, alreadyPresent: false, ...${JSON.stringify(result)}}));
`);
  const route = JSON.stringify([{ workspace: target.workspace, command: [process.execPath, script, file], senderId: "U0B4DHY44NR", senderName: "Kenan" }]);
  return { file, route };
}

test("Unicode resolves through Slack-style emoji names, while workspace shortcodes pass through", () => {
  expect(slackEmojiName("👍")).toBe("+1");
  expect(slackEmojiName("❤️")).toBe("heart");
  expect(slackEmojiName("🚩")).toBe("triangular_flag_on_post");
  expect(slackEmojiName("🏳️‍🌈")).toBe("rainbow-flag");
  expect(slackEmojiName(":partyparrot:")).toBe("partyparrot");
  expect(slackEmojiName("👍🏽")).toBeNull();
  expect(slackEmojiName("not a shortcode")).toBeNull();
});

test("requires an explicit matching route and refuses removal without invoking the command", async () => {
  const fixture = commandFixture();
  expect(await new SlackReactions().react(target, "👍", false)).toMatchObject({ ok: false, error: { code: "unconfigured" } });
  expect(await new SlackReactions(fixture.route).react(target, "👍", true)).toMatchObject({ ok: false, error: { code: "unsupported" } });
  expect(await new SlackReactions(fixture.route).react({ ...target, channel: "#converge" }, "👍", false)).toMatchObject({ ok: false, error: { code: "invalid_target" } });
  expect(() => readFileSync(fixture.file)).toThrow();
});

test("command receives exact Slack target and root timestamp; only confirmed live result succeeds", async () => {
  const fixture = commandFixture({ alreadyPresent: true });
  const result = await new SlackReactions(fixture.route).react({ ...target, threadTs: "1787339320.000001" }, "❤️", false);
  expect(readFileSync(fixture.file, "utf8")).toBe(JSON.stringify([
    "--channel", target.channel, "--timestamp", target.messageId, "--emoji", "heart", "--thread-ts", "1787339320.000001", "--json",
  ]));
  expect(result).toMatchObject({ ok: true, value: [{ emoji: "❤️", own: true, sender: { id: "U0B4DHY44NR", name: "Kenan" } }] });
  if (result.ok) expect(result.value[0]!.timestamp).toBeGreaterThan(0);
});

test("dry-run JSON does not masquerade as a confirmed reaction", async () => {
  const fixture = commandFixture({ dryRun: true });
  expect(await new SlackReactions(fixture.route).react(target, "eyes", false)).toMatchObject({ ok: false, error: { code: "slack_reaction" } });
});

test("route configuration rejects malformed commands and duplicates", () => {
  expect(() => new SlackReactions('{')).toThrow("JSON route array");
  expect(() => new SlackReactions(JSON.stringify([{ workspace: target.workspace, command: "sh -c true" }]))).toThrow("invalid route");
  expect(() => new SlackReactions(JSON.stringify([{ workspace: target.workspace, command: ["echo"] }, { workspace: target.workspace, command: ["echo"] }]))).toThrow("duplicate workspace");
});
