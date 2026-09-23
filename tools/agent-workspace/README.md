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

For source delivery, call `release` as soon as the repository's durable publisher acknowledges custody of the immutable commit. Other live processes keep the checkout referenced. The manager excludes its own invocation ancestry from that check, so release can reclaim the calling shell's current directory. A subsequent allocation still works with absolute paths or Git URLs. Relative filesystem operands require a directory that still exists. The manager resolves local repositories and their relative remote URLs before starting subprocesses in the home directory, outside any disposable checkout. Mirror inspection failures are reported without attempting to add a remote.

The publication worker continues checks, merge, deployment, and verification without the originating model or workspace.

Creation resolves and validates the source commit before reserving a destination. Invalid refs, non-commit objects and interrupted source fetches leave no reservation. Abbreviated commit hashes resolve against the local source or the freshly fetched remote mirror; an unavailable or ambiguous abbreviation needs a full commit or remote ref. The manager records the request, immutable source commit and `creating` state before materializing the checkout. Repeat the same command after interruption. Retry keeps the recorded commit even if the source's HEAD advances. A completed retry returns the same registry ID without renewing its lease. A different request for that path is refused.

`agent-workspace cancel-creation --id ID --json` explicitly retires a pending reservation only when its destination is absent. It takes the same checkout and group fences as creation, including locks inherited by surviving Git children. It never removes files, source refs or grouped peers. Any filesystem entry, including a dangling symlink, causes refusal. Materialized checkouts stay resumable and protected. The command also repairs source-less reservations left by interrupted creation before source validation moved ahead of reservation. Ordinary release and reconciliation continue to retain pending creations; they do not silently cancel them.

Creation runs under a 45-second foreground deadline. A clone interrupted after Git materialization or checkout resumes without deleting the directory. Changed files, ignored output, a different HEAD, or an incomplete Git repository remain for repair. The error names the retained state. Reconciliation and release preserve a pending creation and its group; adoption and heartbeat cannot turn it into a completed checkout. Repair its reported Git state, then repeat the original create command.

`create` uses a shared bare mirror but gives the agent an independent checkout. Local clones use Git's transport negotiation through `--no-local`, so they do not copy every loose or unreachable object from the source. On September 15, local object copying took 31.56 seconds on Converge even with a reference mirror, and cancellation left a complete but unregistered checkout. Reference clones disable commit-graph reads and writes with `core.commitGraph=false`, `gc.writeCommitGraph=false` and `fetch.writeCommitGraph=false`. The mirror rewrites its graph chain during refresh, so borrowing that mutable chain would leave a checkout naming graph files the mirror has replaced. They also set `gc.auto=0` and `maintenance.auto=false` before the initial clone fetch. Temporary clones retain their local objects until whole-checkout reclamation; the shared source owns its object maintenance. Git objects still come from that source through alternates. Do not prune a shared source while borrowers may need its objects. It defaults to the repository's current `HEAD`, including a detached `HEAD`; pass `--ref` to select another commit. Use a ref the source repository can fetch, such as `refs/heads/main`, a branch name, or a commit. `origin/main` names a local remote-tracking ref and is not a remote branch name. `--strategy worktree` uses a linked Git worktree instead. When `--repo` names a local checkout, the new workspace inherits that checkout's canonical `origin` fetch and push URLs. A push URL is recorded only when it differs from the fetch URL, so a checkout cloned from a URL keeps Git's `url.<base>.pushInsteadOf` rewriting (an explicit push URL would disable it); a programme checkout cloned from the read-only remote therefore pushes through the host's write rewrite. The mirror uses a separate `workspace-source` remote to read a local detached or unpushed commit. Mirror refreshes keep fetched source refs outside the local branch namespace, so creating one worktree cannot rewrite another worktree's branch. Release checks only the linked checkout's `HEAD`; branches checked out by its peers belong to those peers. New allocations require 30 GiB of free disk and 10 percent free inodes. There is no default checkout-count limit. A fixed cap blocked the thirty-worker math fleet once active work and retained repair checkouts exceeded 32, despite 1.5 TiB of free disk. Retaining unique work must not block unrelated allocations. Callers can impose a count limit with `--max-count N`; zero disables that optional limit. Disk and inode reserves still apply.

Use repeatable `--cache PATH` flags on `create`, `register`, or `adopt` for repository-generated ignored output. A comma-separated list also works. `--cache-owned OUTPUT=TRACKED_SOURCE` declares an output only in repositories that track its executable owner and ignore the output. This lets one pool adoption classify `src/docs/swagger-output.json` only where `src/docs/swagger.js` owns it, for example. Declarations extend the built-in set, which covers the output a normal build or test pass leaves behind: `node_modules`, `**/node_modules`, `dist`, `**/dist`, `.nx`, `.react-router`, `**/.react-router`, `.converge-cache`, `build`, `**/build`, `**/__pycache__`, `**/.pytest_cache`, `**/.mypy_cache`, `**/.ruff_cache`, `.lake`, `**/.lake`, `target`, and `**/target`. Pool owners can pass `--replace-cache` to `register` or `adopt` when they have recomputed the complete repository-specific policy and need to remove stale declarations. The built-in set remains present. Cache paths must be relative exact paths or `**/directory` patterns. The manager removes only declared paths, and never one holding files the repository tracks, so a committed `build/` survives while a generated one does not. The tracked-file check runs in the target's owning Git repository, including nested submodules. A superproject's index records only the submodule link and cannot answer whether files inside it are tracked. Record any further test, build, or infrastructure cache a normal agent pass can create before doing the work.

A repository can carry its own declaration instead of relying on every caller: a tracked `.agent-workspace-caches` file at the repository root, one cache path per line with `#` comments, extends the record's declared paths whenever caches are stripped. The manager reads it from `HEAD`, so an untracked or working-tree-only manifest classifies nothing; declaring generated output is a repository decision with history. Entries use the same exact-path or `**/name` forms, where `**/name` matches a generated directory or file of that name anywhere in the checkout; an invalid line is reported and skipped.

A released or expired checkout is reclaimable only when it is clean and every local branch and detached `HEAD` commit is already on a remote ref, or when it remains at the source commit recorded during creation. Dirty files, unclassified ignored output, and unpushed commits move it to `repair-required`. A checkout also remains referenced while another registered checkout borrows its Git objects through an alternates file. Declared generated trees are removed once no runtime uses the checkout, even when unique source work still needs repair. Cleanup checks exact paths first, then discovers every recursive cache name in one directory walk. Removed trees are not traversed. Retained tracked directories are traversed so generated caches inside them can still be reclaimed. This avoids repeating a full source-tree scan for each recursive declaration.

Give related repositories the same `--group` value when one agent task spans them. A heartbeat on any member renews the whole group. Release removes the group only when every member is recoverable, so a clean frontend checkout cannot disappear while its backend peer still contains unique work.

## Finding out what became of a checkout

Records outlive the directory. When a checkout is gone, the registry still holds why, so this is answerable rather than a matter of guesswork:

```bash
agent-workspace status --path p3-ob50-review          # substring, not the full path
agent-workspace status --owner some-task --json
agent-workspace status                               # the whole pool
```

`list` is accepted as an alias, since that is what people reach for first. Both commands leave the disposal queue alone. Dry-run reconciliation also leaves it untouched; `reconcile --execute` drains it. Root, path and owner filters run in SQLite before decoding matched records. Path and owner substrings are literal and case-sensitive, including `%` and `_`; a relative path also matches its resolved absolute path. Text output counts the root-scoped pool separately without loading its cache declarations. This prevents a narrow custody lookup from decoding unrelated history. The September 16 Converge registry held 8,193 records with 298 MB of cache declarations; filtering after decoding took 6.42 seconds.

The answer that matters is the `state` and its `detail`. `released` with `every local branch commit exists on a remote ref` means the manager proved the work was on a remote before removing the tree: the commits are safe, and a local hash that no longer resolves was almost certainly rewritten by a rebase before the push. Look for the content on `main` rather than for the hash. `repair-required` is the opposite, and means unique local work is still there and the tree was kept.

A path that matches no record has no retained registration. Before creation requests were recorded, an interrupted create could leave an unregistered Git checkout. Inspect such a checkout before adopting it.

## Reconciliation

Registry connections install SQLite's five-second busy handler before reading journal or schema state. Schema version 1 initializes WAL and the workspace schema once under the `registry-schema` resource fence and an immediate transaction. Already-initialized connections read the version and journal mode without acquiring the writer lock. On September 15, unconditional migration transactions made status and setup calls compete with every native writer, producing `database is locked` before creation could reserve a row. The registry keeps existing rows and source custody during version adoption.

The manager fences checkout mutations and group lifecycle operations with advisory locks under the registry's `locks/` directory. Heartbeat, adoption, release and reconciliation use the same fences. Root admission holds a separate lock only while checking capacity and reserving a creation row. A pending row counts toward an explicit checkout-count limit even before its directory exists.

Mirror mutation holds its own lock only while resolving source. A previously fetched exact commit reuses its retained source ref without refreshing the remote; moving refs still refresh. Clone and checkout run outside the mirror lock, so unrelated creations and lease operations can proceed together. Git children inherit the held lock descriptors, so killing only the creator does not expose a still-writing checkout. Lock ownership ends when the last descriptor closes, not at a timestamp. Lock files contain no source and remain reusable after their owner exits. A lock wait exhausts its 30-second budget with exit 75, without changing the fenced record.

Adopt existing children of a pool, then inspect before changing anything:

```bash
agent-workspace adopt --root ~/worktrees --kind project-agent --mode writer --json
agent-workspace reconcile --root ~/worktrees --json
agent-workspace reconcile --root ~/worktrees --execute --json
```

Use `--nested-groups` when a direct child is a task directory containing sibling repositories or a checkout containing an independent nested repository. The manager discovers those Git roots one level below each pool child and assigns the parent and children to one durable group. Existing ungrouped records join that group. Newly found siblings inherit an existing member's lease, so discovering a repository cannot postpone recovery of an inactive group or shorten an active lease. A record already assigned to another group makes the request fail without changing any grouping. Parent status excludes registered nested roots because the nested repository has its own recoverability check. The manager removes nested roots before their parent and removes a task directory only when it is empty after the whole group is released.

Reconciliation inspects at most 32 ownership groups or 20 seconds per invocation. It returns every selected record, marking unchecked groups `deferred` with `action: none` and a `continuationAfter` ID. A deferred record is not a cleanliness or safety verdict. Read-only callers continue with `--after ID`; use `--after start` to restart the scan. Executing calls save their cursor in the registry and continue on the next invocation, including after the preceding checkout was released. A group stays together. `--max-groups N` sets the page size and `--budget-ms N` sets the inspection budget up to 40000 milliseconds. Safety snapshots and Git inspection reads share that deadline; a timed-out read retains the checkout and reports `blocked`. Already-started cleanup or owner shutdown finishes through its normal lifecycle rather than being killed at the inspection deadline.

A September 18 Converge pool with 533 directories exposed the former unbounded serial scan. The manager now reads tracked, untracked and ignored status in one Git walk and returns bounded coverage instead of waiting for every checkout. An executing timer makes progress across pages without discarding dirty, unpushed, leased or runtime-owned work. If any member of a group remains runtime-referenced or safety-blocked, cache cleanup for the group does not run.

An expired lease with a live process, active systemd unit, or Docker container remains referenced. `--reap-expired` fences that owner, stops user units, removes containers, terminates processes, and continues reconciliation. System units remain blocked for their owning service lifecycle. Use reaping only for roots whose workers honor workspace leases.

Runtime discovery follows the caller's authority. Process inspection covers the caller's UID; user/system unit references and registered Git borrowers are still checked. Docker discovery resolves the selected context, honoring `DOCKER_CONTEXT` before `DOCKER_HOST`. A foreign-owned Unix socket without a filesystem write grant is outside that account's Docker authority, so it is not queried. This lets ordinary accounts release workspaces on hosts with an administrator-only Docker daemon without granting Docker access. Writable local sockets, rootless daemons and remote endpoints still require a complete container snapshot. Broken context resolution, inaccessible owned sockets, missing sockets, unexpected filesystem errors and failed daemon queries block cleanup. An administrator who attaches containers to another person's private checkout owns that cross-account reference; ordinary release does not inspect the administrator's daemon.

Reference-clone maintenance is reconciled before lease and group checks, including for active workspaces. Registration and adoption apply it too. On September 10, disabling graph reads alone left graph writes enabled: a normal Converge publication commit produced `.git/gc.log`, which then suppressed later automatic Git cleanup. The manager now disables both operations and automatic clone maintenance. It removes a `gc.log` only when every line is one of the diagnosed disabled-graph or unreachable-loose-object warnings and no `gc.pid` remains. Unknown failures stay in place and block reconciliation for inspection. It never prunes objects, rewrites refs, removes graphs or alters worktrees as part of this repair.

Inspect or repair only this maintenance state, without lease changes, cache cleanup, checkout deletion or draining the disposal queue:

```sh
agent-workspace maintain --json
agent-workspace maintain --execute --json
agent-workspace maintain --path /absolute/checkout --execute --json
```

The operation selects registered reference clones and reports changed configuration keys and warning-log disposition. Missing paths, ordinary clones and linked worktrees are not modified. Shared mirrors are not reference clones and keep their own configuration.

An executing reconcile also forgets released records older than thirty days whose trees are gone, so the registry stays the size of the pool's recent history rather than its whole past.

The registry defaults to `~/.local/state/pi-workspaces/registry.sqlite3`. Set `PI_WORKSPACE_STATE` when a host needs another persistent location. Removed trees are atomically moved into the registry's `gc/` directory and deleted by a detached low-priority collector, so large dependency trees disappear from the active pool immediately.
