# Delegation guidance

[`src/delegation-policy.ts`](../src/delegation-policy.ts) owns the shared tool-description policy for `thread_spawn`. It is exported through `pi-orchestrator/api`. Remote, fleet lanes and ordinary subthreads use the same persistent thread operation rather than host-specific delegation tools. Parent conversations can spawn workers; workers cannot spawn subagents. The [unified thread design](../../../docs/threads.md) owns lifecycle and delivery semantics, and [Pi session execution](pi-sessions.md) owns tool registration.

Agents can choose delegation for independent work while they make useful progress locally. Immediate blocking tasks stay local. The policy covers task decomposition, non-overlapping edits, automatic result delivery and integration. Model-selection descriptions do not establish a reason to delegate. Thinking level does not change this policy. When local work is finished, a parent can await the first result from selected children or end its turn and resume on automatic result delivery.

PiStack Voice retains its separate [`delegation-policy.md`](../../../apps/remote/server/voice/delegation-policy.md), loaded by `voiceInstructions()` during Voice negotiation. Its computer-work handoffs keep the voice model available for conversation. A backing text agent uses the regular optional policy, with one exception: the root thread a meeting is attached to also receives Remote's [meeting root policy](../../../apps/remote/server/meet/root-thread-policy.md) in its system prompt, which requires delegation for anything longer than one or two tool calls because Voice hard-steers that thread on every handoff. [Meet](../../../apps/remote/docs/meet.md#meeting-thread-and-workers) owns that policy.

## Authorization and source

On September 12, 2026, Hara authorized this change in the "Delegation Prompting Bias" thread:

> All right go ahead and copy as much of Codex's behaviour as possible here. you can even copy the prompting verbatim

This is permission to copy and adapt this delegation prompt, not a general change to prompt-authorship policy.

The source is OpenAI Codex at commit [`ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8`](https://github.com/openai/codex/tree/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8), specifically [`multi_agents_spec.rs`, lines 700–727 and 746](https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L700-L746).

Most task-selection and decomposition wording is copied verbatim. Pi Stack changes:

- Delegation remains optional without requiring an explicit request each time. Codex's explicit-request gate and Ultra-triggered proactive mode are not imported, preserving Hara's distinction between optional text delegation and required voice handoffs.
- "Main rollout" becomes "main agent".
- Forked-workspace and uploaded-change wording becomes agent-workspace and shared-filesystem wording. Results include the changed paths and commit.
- `wait_agent` guidance uses `thread_await` for the first result from one or more direct children, or automatic delivery after the parent ends its turn. Neither path requires polling. Failures and unfinished work remain visible.
- Verification guidance respects the user's request and applicable instructions.
- Remote and fleet model selection remains available through thread settings. Orchestrator owns persistent parent links, continuation through ordinary sends and durable completion delivery between parent conversations and their workers.

## License and attribution

OpenAI Codex

Copyright 2025 OpenAI

The adapted policy is licensed under Apache-2.0. The complete upstream [license](../src/delegation-policy.LICENSE), including its OpenAI copyright notice, ships beside the policy source in the deployed Orchestrator. The source file identifies the adaptation. No Ratatui code is included.

## Checks and deployment

Tool-registration checks compare the installed description with the shared owner rather than duplicating prompt text. Voice tests keep meeting-only handoff details out of regular thread delegation.

Release through the [stack deployment procedure](../../../docs/deployment.md). New Pi sessions load the tool description from the selected release; active turns finish on their loaded generation.
