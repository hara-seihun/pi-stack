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
  --json

agent-workspace heartbeat --path ~/worktrees/claim-123
agent-workspace release --path ~/worktrees/claim-123
```

`create` uses a shared bare mirror but gives the agent an independent checkout. `--strategy worktree` uses a linked Git worktree instead. New allocations default to a 32-checkout limit, 30 GiB of free disk, and 10 percent free inodes. Callers may set stricter limits.

A released or expired checkout is reclaimable only when it is clean and every local branch commit is already on a remote ref, or when it remains at the source commit recorded during creation. Dirty files, unclassified ignored output, and unpushed commits move it to `repair-required`. Declared generated trees such as `node_modules`, `.nx`, and `.converge-cache` are removed once no runtime uses the checkout, even when unique source work still needs repair.

Give related repositories the same `--group` value when one agent task spans them. A heartbeat on any member renews the whole group. Release removes the group only when every member is recoverable, so a clean frontend checkout cannot disappear while its backend peer still contains unique work.

## Reconciliation

Adopt existing direct children of a pool, then inspect before changing anything:

```bash
agent-workspace adopt --root ~/worktrees --kind project-agent --mode writer --json
agent-workspace reconcile --root ~/worktrees --json
agent-workspace reconcile --root ~/worktrees --execute --json
```

An expired lease with a live process, active systemd unit, or Docker container remains referenced. `--reap-expired` fences that owner, stops user units, removes containers, terminates processes, and continues reconciliation. System units remain blocked for their owning service lifecycle. Use reaping only for roots whose workers honor workspace leases.

The registry defaults to `~/.local/state/pi-workspaces/registry.sqlite3`. Set `PI_WORKSPACE_STATE` when a host needs another persistent location. Removed trees are atomically moved into the registry's `gc/` directory and deleted by a detached low-priority collector, so large dependency trees disappear from the active pool immediately.
