// Adapted from OpenAI Codex, Copyright 2025 OpenAI, Apache-2.0.
// Source and modifications: ../docs/delegation-policy.md. License: ./delegation-policy.LICENSE.
export const DELEGATION_POLICY = `Delegation is optional. You can complete tasks yourself. Follow the user's requests about delegation.
Only call this tool for a concrete, bounded subtask that can run independently alongside useful local work; otherwise continue locally.
Model descriptions help choose a worker after deciding to delegate; they are not a reason to delegate.

### When to delegate vs. do the subtask yourself
- First, quickly analyze the overall user task and form a succinct high-level plan. Identify which tasks are immediate blockers on the critical path, and which tasks are sidecar tasks that are needed but can run in parallel without blocking the next local step. As part of that plan, explicitly decide what immediate task you should do locally right now. Do this planning step before delegating to agents so you do not hand off the immediate blocking task to a submodel and then waste time waiting on it.
- Use a subagent when a subtask is easy enough for it to handle and can run in parallel with your local work. Prefer delegating concrete, bounded sidecar tasks that materially advance the main task without blocking your immediate next local step.
- Do not delegate urgent blocking work when your immediate next step depends on that result. If the very next action is blocked on that task, the main agent should usually do it locally to keep the critical path moving.
- Keep work local when the subtask is too difficult to delegate well and when it is tightly coupled, urgent, or likely to block your immediate next step.

### Designing delegated subtasks
- Subtasks must be concrete, well-defined, and self-contained.
- Delegated subtasks must materially advance the main task.
- Do not duplicate work between the main agent and delegated subtasks.
- Avoid issuing multiple delegate calls on the same unresolved thread unless the new delegated task is genuinely different and necessary.
- Narrow the delegated ask to the concrete output you need next.
- For coding tasks, prefer delegating concrete code-change worker subtasks over read-only explorer analysis when the subagent can make a bounded patch in a clear write scope.
- When delegating coding work, ask the worker to edit files directly in its own agent workspace and list the file paths and commit it changed in the final answer. Workers share your filesystem, not an automatically forked checkout.
- For code-edit subtasks, decompose work so each delegated task has a disjoint write set.

### After you delegate
- Results arrive automatically. Do not poll or repeatedly read a worker's transcript just to wait for it.
- Do not redo delegated subagent tasks yourself; focus on integrating results or tackling non-overlapping work.
- While the subagent is running in the background, do meaningful non-overlapping work immediately.
- If no useful local work remains, use thread_await for one or more direct children to continue on the first result, or end your turn and let automatic result delivery resume you. Do not claim the overall task is complete while delegated work is outstanding.
- When a delegated coding task returns, quickly review the changes, then integrate or refine them. Report failed or incomplete work plainly.

### Parallel delegation patterns
- Run multiple independent information-seeking subtasks in parallel when you have distinct questions that can be answered independently.
- Split implementation into disjoint codebase slices and spawn multiple agents for them in parallel when the write scopes do not overlap.
- Delegate verification only when it is part of the requested work or applicable instructions, can run in parallel with ongoing implementation, and is likely to catch a concrete risk before final integration.
- The key is to find opportunities to spawn multiple independent subtasks in parallel within the same round, while ensuring each subtask is well-defined, self-contained, and materially advances the main task.`;
