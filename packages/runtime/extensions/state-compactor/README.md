# State compactor

State compactor replaces old dialogue with a source-linked working-state record and keeps a recent tail verbatim. It runs in interactive Pi threads and orchestrator sessions.

The engine has four pieces:

1. An anchored state update absorbs only messages added since the previous checkpoint.
2. The checkpoint separates current activity, unanswered requests, completed requests, work, constraints, decisions, artifacts, blockers, uncertainty, and next actions.
3. Every fact cites a raw session entry. `state_recall` pages the exact source when the compact record is insufficient.
4. A recent tool-safe tail remains verbatim. Large tool results may leave the active view, but their source entries remain recallable.

A checkpoint begins with a fixed warning that it is a historical record rather than a user instruction. Completed opening exchanges cannot become active work. The orchestrator may provide an authoritative task, but the engine does not require one. Without a host task it derives current activity from unresolved user messages and permits `active: null` for an ordinary conversation.

Pi's JSONL session stays the source of truth. Checkpoints are branch-local custom entries. `<session>.state-views.ndjson` records the checkpoint, branch leaf, boundary, token estimate, and hashes needed to reproduce each assembled provider view.

## Configuration

- `PI_STATE_COMPACTOR_TRIGGER` lowers the default 220,000-token checkpoint threshold. It cannot raise it.
- `PI_STATE_COMPACTOR_ALERTS` names the directory for a checkpoint-model failure alert. The engine then uses deterministic extraction so the provider request still fits; this path is loud and occurs once per session.

The active threshold also stays 32,000 tokens below the selected model's context window. The retained tail is 40,000 tokens on large models and scales down on smaller ones.

## Design sources

- [TRACE](https://arxiv.org/abs/2608.06503): typed current and completed state, plus continuation-based damage measurement.
- [Factory's compression evaluation](https://factory.ai/news/evaluating-compression): anchored iterative updates beat whole-summary regeneration across 36,000 production messages.
- [Anthropic's context-engineering cookbook](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools): clear old tool payloads and preserve recoverability.
- [TierMem](https://arxiv.org/abs/2602.17913): compact records retain provenance into immutable raw evidence.

## Test

```sh
node --test state.test.mjs extension.test.mjs
```
