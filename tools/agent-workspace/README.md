# Agent workspace manager

`agent-workspace` owns temporary Git clones and worktrees used by agents. It gives every checkout a lease, records its owner and durable source commit, blocks new allocation when disk or inode reserves are low, and removes a checkout only after proving that it has no unique local work. Processes, active systemd units, and Docker containers count as live owners.

## Normal flow

```bash
agent-workspace create \
  --root ~/worktrees \
  --name claim-123 \
  --repo https://github.com/example/project.git \
  --ref refs/heads/main \
  --owner claim-123 \
  --mode writer \
  --cache deploy/generated \
  --json

agent-workspace heartbeat --path ~/worktrees/claim-123
agent-workspace release --path ~/worktrees/claim-123
```

For source delivery, call `release` as soon as the repository's durable publisher acknowledges custody of the immutable commit. A live process keeps the checkout referenced until the session exits. The publication worker continues checks, merge, deployment, and verification without the originating model or workspace.

`create` uses a shared bare mirror but gives the agent an independent checkout. Reference clones disable commit-graph acceleration: the mirror rewrites its graph chain during refresh, so borrowing that mutable chain would leave a checkout naming graph files the mirror has replaced. Git objects still come from the mirror through alternates. It defaults to the repository's current `HEAD`, including a detached `HEAD`; pass `--ref` to select another commit. Use a ref the source repository can fetch, such as `refs/heads/main`, a branch name, or a commit. `origin/main` names a local remote-tracking ref and is not a remote branch name. `--strategy worktree` uses a linked Git worktree instead. When `--repo` names a local checkout, the new workspace inherits that checkout's canonical `origin` fetch and push URLs. A push URL is recorded only when it differs from the fetch URL, so a checkout cloned from a URL keeps Git's `url.<base>.pushInsteadOf` rewriting (an explicit push URL would disable it); a programme checkout cloned from the read-only remote therefore pushes through the host's write rewrite. The mirror uses a separate `workspace-source` remote to read a local detached or unpushed commit. Mirror refreshes keep fetched source refs outside the local branch namespace, so creating one worktree cannot rewrite another worktree's branch. Release checks only the linked checkout's `HEAD`; branches checked out by its peers belong to those peers. New allocations default to a 32-checkout limit, 30 GiB of free disk, and 10 percent free inodes. Callers may set stricter limits.

Use repeatable `--cache PATH` flags on `create`, `register`, or `adopt` for repository-generated ignored output. A comma-separated list also works. Declarations extend the built-in set, which covers the output a normal build or test pass leaves behind: `node_modules`, `**/node_modules`, `dist`, `**/dist`, `.nx`, `.react-router`, `**/.react-router`, `.converge-cache`, `build`, `**/build`, `**/__pycache__`, `**/.pytest_cache`, `**/.mypy_cache`, `**/.ruff_cache`, `.lake`, and `**/.lake`. Cache paths must be relative exact paths or `**/directory` patterns. The manager removes only declared paths, and never one holding files the repository tracks, so a committed `build/` survives while a generated one does not. Record any further test, build, or infrastructure cache a normal agent pass can create before doing the work.

A released or expired checkout is reclaimable only when it is clean and every local branch and detached `HEAD` commit is already on a remote ref, or when it remains at the source commit recorded during creation. Dirty files, unclassified ignored output, and unpushed commits move it to `repair-required`. A checkout also remains referenced while another registered checkout borrows its Git objects through an alternates file. Declared generated trees are removed once no runtime uses the checkout, even when unique source work still needs repair.

Give related repositories the same `--group` value when one agent task spans them. A heartbeat on any member renews the whole group. Release removes the group only when every member is recoverable, so a clean frontend checkout cannot disappear while its backend peer still contains unique work.

## Finding out what became of a checkout

Records outlive the directory. When a checkout is gone, the registry still holds why, so this is answerable rather than a matter of guesswork:

```bash
agent-workspace status --path p3-ob50-review          # substring, not the full path
agent-workspace status --owner some-task --json
agent-workspace status                               # the whole pool
```

`list` is accepted as an alias, since that is what people reach for first.

The answer that matters is the `state` and its `detail`. `released` with `every local branch commit exists on a remote ref` means the manager proved the work was on a remote before removing the tree: the commits are safe, and a local hash that no longer resolves was almost certainly rewritten by a rebase before the push. Look for the content on `main` rather than for the hash. `repair-required` is the opposite, and means unique local work is still there and the tree was kept.

A path that matches no record was never registered, and the manager never touched it.

## Reconciliation

Adopt existing children of a pool, then inspect before changing anything:

```bash
agent-workspace adopt --root ~/worktrees --kind project-agent --mode writer --json
agent-workspace reconcile --root ~/worktrees --json
agent-workspace reconcile --root ~/worktrees --execute --json
```

Use `--nested-groups` when each direct child is a task directory containing sibling repositories. The manager discovers Git roots one level below the pool, assigns siblings to one durable group, and removes the task directory only when it is empty after the whole group is released.

An expired lease with a live process, active systemd unit, or Docker container remains referenced. `--reap-expired` fences that owner, stops user units, removes containers, terminates processes, and continues reconciliation. System units remain blocked for their owning service lifecycle. Use reaping only for roots whose workers honor workspace leases.

An executing reconcile also forgets released records older than thirty days whose trees are gone, so the registry stays the size of the pool's recent history rather than its whole past.

The registry defaults to `~/.local/state/pi-workspaces/registry.sqlite3`. Set `PI_WORKSPACE_STATE` when a host needs another persistent location. Removed trees are atomically moved into the registry's `gc/` directory and deleted by a detached low-priority collector, so large dependency trees disappear from the active pool immediately.
