# The forever conversation

Each account starts in classic view. Long-press **Chats** in the desktop rail or phone tab bar to enter mono view: one full-screen conversation with the person's managing Kenan. Long-press its header to return to classic. Titles describe the gesture and the first mono opening presents a one-time hint. Preference and hint acknowledgement live server-side in the person's canonical manager-owner supervisor database. Its subscribed devices receive updates through Bootstrap. Devices viewing another authorized environment read that owner's state on opening, focus/visibility return and every thirty seconds while visible; they never store another preference. Opening a thread link from mono uses the classic conversation screen; Back returns to mono without changing the saved preference.

The existing conversation and composer provide dictation, attachments, questions, images and conversation history. Mono has no tabs or thread list. Quiet heartbeat turns remain in native history but their wake input, thinking and tool records are not rendered in mono when they have no assistant text for the person. Wake input is an agent notification, never person input.

## Manager custody

The person's canonical owner supervisor creates their one manager lazily on the first mono toggle, with no initial message or model call. Toggling from another environment routes to that same supervisor and conversation; it never creates another manager or copies context between hosts. Explicit thread links can still open another environment's classic conversation. Cross-host task-system bridging is separate from this view. It is an ordinary full-context thread, identified by `metadata.manager:true`, protected from explicit and automatic archival. Cancel stops current work without deleting its identity. Its initial model is `anthropic/claude-opus-5-5`, high thinking, standard speed. Its prompt is source-owned [`server/manager-prompt.md`](../server/manager-prompt.md), loaded fresh on each turn together with the destination's chosen context files.

Creation registers the existing durable `thread_wake` at a four-hour cadence. The manager can change or cancel it; reopening mono and supervisor restart do not reset the schedule. Due wakes do not run during a current turn or within fifteen minutes of the person's latest input. They use ordinary admission and restart-safe message identities.

The person registry supplies:

- `PI_REMOTE_MANAGER_ENVIRONMENT`: canonical manager owner environment ID. Unset means this person's sole current supervisor. Cross-environment accounts set the same owner ID in every registry. Nonowner supervisors advertise the pointer and do not instantiate manager state; the client uses its authorized environment catalog to reach the owner. An unavailable or ungranted owner is an explicit error.
- `PI_REMOTE_MANAGER_MODEL`: optional catalog name or installed provider/model, validated at supervisor startup. Unset deliberately selects `anthropic/claude-opus-5-5`; thinking is high and speed standard.
- `PI_REMOTE_MANAGER_DESTINATION`: optional offered full-context destination. Unset selects Personal when offered, otherwise Home, otherwise the first offered full-context destination. Raw and sandbox are rejected.
- Each `PI_REMOTE_THREAD_DESTINATIONS` entry may declare `managerContextFiles`, top-level Markdown names in its `contextDir`, alongside `watchContextFiles`. An omitted choice uses every top-level Markdown file in that directory; a destination with no context directory loads none. A configured choice without a full-context directory is invalid. Missing configured files reject first creation and, after creation, remain explicit context-load errors rather than selecting another file.

Configuration belongs in each person's registry, never source. Reload through the ordinary supervisor lifecycle to apply registry changes. The manager stays in its accepted destination and settings; subsequent view toggles do not migrate or reconfigure it.

## Questions

Once a manager exists, questions from the person's other threads go into durable manager custody before reaching a composer or Attention. The manager can list held questions, answer with explicit manager attribution through the existing correlated-answer path, or forward one rewritten question covering one or several originals. Manager-authored questions go straight to the person.

A forwarded question appears in the manager conversation and its originals also become answerable in classic view. The first accepted answer settles the linked group and fans out to original asking threads; retries cannot send another answer. A question left held for two hours surfaces directly to the person. All custody, deadlines and answer receipts survive restart. See [asynchronous questions](questions.md).

## API and storage

At the canonical owner, `GET /v1/manager` returns `{view, managerThreadId, hintSeen}`. Another supervisor returns `409` with `code:'manager_owner'` and the owner `environmentId`. Bootstrap carries `managerOwnerEnvironmentId` and either that owner's view or explicit `manager:null`. `POST /v1/manager` accepts `{view:'classic'|'mono', hintSeen?:boolean}` from the authenticated person. Entering mono creates the manager before saving mono. A mono response always has a manager ID. Failed initialization keeps classic and retains the reserved identity for an idempotent retry.

`manager_view` in `DATA/supervisor.sqlite3` owns view, hint and creation/wake initialization custody. The ordinary thread owner database owns the actual manager and question state. No browser-local preference, alternative transcript or new task scheduler exists.

Owners: [`server/manager.ts`](../server/manager.ts), [`server/server.ts`](../server/server.ts), [`web/src/app/mono.ts`](../web/src/app/mono.ts), and the ordinary [thread service](../../../docs/threads.md). Publication ships one shared web bundle and the matching checked Android artifact through the existing [publication path](../../../docs/publication.md).
