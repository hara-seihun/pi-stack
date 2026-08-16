# Prompt Eval

`prompt-eval` runs reproducible Pi system-prompt experiments. Each case gets the same task and optional seed workspace in a separate working directory. The tool captures the complete JSON event stream, final assistant response, resulting files, file hashes, timing, usage, and pairwise diffs.

## Start an experiment

```bash
prompt-eval init /home/kenan/my-eval
cd /home/kenan/my-eval
$EDITOR task.md prompts/*.md experiment.json
prompt-eval run experiment.json
```

`run` prints the result directory. Open its `comparison.md` for the summary and links to every response, transcript, workspace, metadata record, and patch.

List selectable Pi models with:

```bash
prompt-eval models
prompt-eval models gpt-5.6
```

Regenerate comparisons after inspecting or copying a run:

```bash
prompt-eval compare results/prompt-comparison-20260816-200000.000Z
```

## Experiment format

```json
{
  "name": "api-design-prompts",
  "task": "task.md",
  "workspace": "seed-project",
  "model": "openai-codex/gpt-5.6-sol",
  "thinking": "high",
  "timeoutSeconds": 900,
  "parallelism": 1,
  "tools": ["read", "bash", "edit", "write"],
  "extensions": true,
  "outputRoot": "results",
  "cases": [
    {
      "name": "baseline",
      "systemPrompt": "prompts/baseline.md"
    },
    {
      "name": "challenger",
      "model": "openai-codex/gpt-5.6-luna",
      "thinking": "xhigh",
      "systemPrompt": "prompts/challenger.md"
    }
  ]
}
```

Paths are resolved relative to `experiment.json`. `workspace` is optional; when present, it is copied independently for every case. Top-level `model` and `thinking` are defaults that a case may override. Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Prompt Eval disables context files, skills, prompt templates, project trust, and session persistence. A small CLI-loaded extension replaces Pi's generated prompt immediately before the agent starts, avoiding Pi's usual per-workspace working-directory suffix. The selected Pi tools remain available, and no evaluator instruction is added.

Global extensions remain enabled by default because this machine's healthy subscription routing and custom providers are extensions. The current routing/provider extensions do not rewrite system prompts, so the snapshotted prompt is the effective system prompt. Pi runs CLI extensions before discovered global extensions; if a future global `before_agent_start` hook rewrites the prompt, it must be treated as part of the case configuration. Set `"extensions": false` only when using a healthy built-in provider directly and extension-free execution is intentional.

`parallelism` defaults to one. Increase it only when simultaneous cases are part of the intended experiment and provider capacity permits it. `timeoutSeconds` bounds each Pi process; timeout termination applies to its process group. Each Pi bash tool invocation also inherits the machine's globally configured resource-bounded tool shell.

## Result custody

A run is self-contained:

```text
RUN/
  manifest.json
  comparison.md
  inputs/
    task.md
    prompts/CASE.md
    workspace/
  cases/CASE/
    workspace/
    events.jsonl
    stderr.log
    final.md
    result.json
  comparisons/
    CASE--CASE-final.patch
    CASE--CASE-workspace.patch
```

`inputs/` is the immutable snapshot used by the run. `cases/*/workspace/` contains the actual files each agent left behind. `result.json` records created, modified, and deleted paths relative to the seed plus a SHA-256 inventory. `events.jsonl` is the authoritative Pi event stream; `final.md` is the last completed assistant text message extracted from it.

A failed or timed-out case does not discard successful siblings. The command finishes all configured cases, writes the comparison, and exits nonzero when any case did not complete.

The workspaces isolate outputs for comparison; they are not security sandboxes. Agents retain the selected Pi tools and the host's normal authority.

## Validation and deployment

From `/home/kenan/tools/pi-runtime`:

```bash
npm test
./deploy
prompt-eval --help
```

The implementation is dependency-free beyond Node, Git, and the pinned Pi runtime. `PROMPT_EVAL_PI` overrides the Pi executable for automated tests only.
