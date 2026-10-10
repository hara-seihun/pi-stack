# Local Kenan working on Converge

With `oneKenan: true` in the host's `/etc/pi-stack/host.json`, normal local Pi sessions for
Hara (`PI_REMOTE_SENDER_ID === "kenan"`) get a `converge` tool. The sender ID comes from the
root-owned person configuration, not the execution UID: sharing the Kenan execution identity
must not give other people's sessions this tool. Raw, sandbox and isolated application
sessions do not get it. With the flag absent or false, no tool is added and existing endpoint
routing is unchanged. Already-created tools check the flag again before executing.

The thread remains on this host, with its existing context, memory, contacts, Signal and
other local tools. Converge is a place it works, not a supervisor it hands the conversation
to. The explicit remote tool avoids accidentally routing a personal-memory read or contact
action to the work machine. Local `bash`, `read`, `write` and `edit` still work locally.

## Use

Ask a local thread to work on Converge. The agent calls `converge` with an operation:

```json
{"action":"bash","cwd":"/home/kenan/projects/example","command":"git status --short","timeout":55}
{"action":"read","cwd":"/home/kenan/projects/example","path":"AGENTS.md"}
{"action":"write","cwd":"/home/kenan/projects/example","path":"src/note.txt","content":"chosen work content\n"}
{"action":"edit","cwd":"/home/kenan/projects/example","path":"src/note.txt","edits":[{"oldText":"chosen work content","newText":"revised work content"}]}
```

`cwd` is an absolute **remote** directory, defaulting to the SSH user's remote home; it never
inherits the local thread cwd. Relative file paths resolve against that directory; `~` in a
file path means the remote home. Each operation is independent. Read the remote repository's
`AGENTS.md` before changing it; those instructions are not automatically loaded into the
local context.

- `bash` runs `bash -lc` and returns `output`, `exitCode`, `truncated` and `stopped`. Nonzero
  exit codes and timeout/cancellation are tool errors. Stdout/stderr are combined, keeping
  the last 50 KiB. Canonical managers require an explicit positive timeout of at most
  five seconds, covering the complete SSH operation with no transport grace. Other
  threads default to the lesser of 55 seconds and their configured shell allowance,
  never exceeding 1800 seconds. Commands cannot take
  interactive input; provide a script or literal input in the chosen command.
- `read` reads UTF-8 text, at most 2000 lines/50 KiB, with 1-based `offset` and optional
  `limit`. `nextOffset` continues complete lines. If `partialLine` is true, use `bash` to
  inspect a byte range rather than retrying that line indefinitely. Binary/image reads
  require an explicit remote command to inspect or convert them.
- `write` creates parent directories and atomically replaces the selected file. Existing
  permissions are preserved; new files are private (`0600`).
- `edit` matches all `oldText` values exactly once in the original file and rejects overlaps
  before changing anything. A missing/nonunique match leaves the file unchanged. File
  mutations resolve symlinks and replace their target, preserving the symlink itself.

## Transport and custody

`packages/orchestrator/src/threads/converge.ts` owns the tool and SSH lifecycle;
`converge-worker.ts` owns its ephemeral Python worker. Nothing is installed on Converge.
The worker receives only one operation as JSON over SSH stdin. No context, transcript,
local file, contact database, memory store or session environment is uploaded. The thread
must explicitly choose any content it writes there. Remote output enters the local thread's
transcript just like other tool results.

SSH uses the existing server-owned `converge-kenan` alias, host-key trust and identity—the
same identity used for the existing supervisor forward. It does not modify/reuse that live
forward, start a remote supervisor, or add an endpoint grant. Agent/X11 forwarding and
connection multiplexing/persistence are disabled for the operation. The local SSH process
inherits only `HOME`, `PATH` and a locale, not thread tokens or agent sockets. The flag-on
execution identity must be able to read the existing SSH configuration/key/known-hosts;
this is operator custody, not a key delivered to a person's client.

Converge needs `python3` and `bash` on its remote login PATH. Commands use its own remote
login environment and installed tools. SSH connection/host-key failures are reported, not
silently routed through a different identity or supervisor.

The SSH connection stays foreground. The worker watches stdin EOF and kills the command's
process group on disconnect; it also kills that group on remote timeout and on completion
(to avoid leaving child processes behind). This is a bounded command tool, not a remote
service launcher. Deliberately daemonized processes outside the group are not managed by it.
No transport failure is automatically retried: a file write or command may already have had
effects. Inspect the remote state before retrying.

## Focused proof

```sh
node_modules/.bin/vitest run packages/orchestrator/tests/converge{,-session}.test.ts --maxWorkers=1
```

The tests use temporary local fixtures in place of SSH. They cover off-by-default/person
admission, payload/environment custody, path handling, exact batch edits, bounded output,
timeout after stdout closes, cancellation cleanup, shell allowance and no retry on SSH
failure. A native runtime test proves the local context and tools stay present and the
flag-off, other-person and raw tool sets are unchanged. A read-only real SSH smoke on October 3, 2026 returned `host=converge-kenan`,
`user=kenan`, `cwd=/home/kenan` and the remote `python3`, `git`, `bash` paths. No service,
SSH configuration or Converge file was changed for that smoke.
