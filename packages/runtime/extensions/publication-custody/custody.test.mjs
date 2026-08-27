import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLICATION_CUSTODY_RULE,
  publicationPollingReason,
  registerPublicationCustody,
} from "./index.mjs";

function handlers() {
  const registered = new Map();
  registerPublicationCustody({
    on: (event, handler) => registered.set(event, handler),
  });
  return registered;
}

const pollingCommands = [
  "gh pr checks 638 --watch",
  "gh pr checks --watch-interval=10 638",
  "gh run watch 33115473559 --exit-status",
  "watch -n 5 gh run view 33115473559",
  "while gh pr checks 638; do sleep 10; done",
  "until gh run view 33115473559 --json conclusion | jq -e '.conclusion'; do sleep 5; done",
  "sleep 30; gh run list --branch main --limit 1",
  "sleep $delay && gh api repos/owi-link/converge/actions/runs",
];

for (const command of pollingCommands) {
  test(`blocks model-side publication polling: ${command}`, () => {
    const reason = publicationPollingReason(command);
    assert.match(reason ?? "", /publication worker owns those phases/i);
  });
}

test("allows one-shot diagnostics and durable handoff", () => {
  const commands = [
    "./converge publish submit --task TSK-123 --json",
    "gh run view 33115473559 --log-failed",
    "gh pr checks 638",
    "gh api repos/owi-link/converge/actions/runs/33115473559/jobs",
    "sleep 1",
    "make test",
  ];
  for (const command of commands) {
    assert.equal(publicationPollingReason(command), null, command);
  }
});

test("the bash gate blocks polling without consuming another model call", () => {
  const toolCall = handlers().get("tool_call");
  assert.equal(toolCall({ toolName: "read", input: { path: "x" } }), undefined);
  assert.equal(toolCall({ toolName: "bash", input: { command: "gh run view 1" } }), undefined);
  const result = toolCall({ toolName: "bash", input: { command: "gh run watch 1" } });
  assert.equal(result.block, true);
  assert.match(result.reason, /stop the originating run/i);
});

test("the custody contract appears once in the system prompt", () => {
  const beforeStart = handlers().get("before_agent_start");
  const first = beforeStart({ systemPrompt: "base" }).systemPrompt;
  assert.ok(first.includes(PUBLICATION_CUSTODY_RULE));
  assert.equal(beforeStart({ systemPrompt: first }), undefined);
});
