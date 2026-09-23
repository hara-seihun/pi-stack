# Local models

Engines listed in the host manifest become Pi providers. The manifest is `~/.pi/agent/local-models.json` (or `$PI_STACK_LOCAL_MODELS`); a host without one loads nothing. Each engine is an OpenAI-compatible server on this machine: the extension probes `GET <baseUrl>/models`, starts a listed engine that is not answering, waits for it, registers its models through `pi.registerProvider`, and writes the same providers into `~/.pi/agent/models.json` so every Pi surface, including PiStack's thread model catalog, lists them. Engines that stay down are left out of the catalog and reported on stderr.

```json
{
  "version": 1,
  "engines": [
    {
      "id": "bonsai-halo",
      "name": "Bonsai Halo",
      "baseUrl": "http://127.0.0.1:8471/v1",
      "start": {
        "unit": "bonsai-halo",
        "command": ["/path/to/bonsai-halo", "serve", "--port", "8471", "--dflash", "/path/to/dflash2.safetensors"],
        "cwd": "/path/to/engine-directory",
        "readySeconds": 120
      },
      "reservation": { "lock": "/path/to/engine-reservation.lock", "waitSeconds": 0 },
      "models": [
        { "id": "bonsai-2-27b", "name": "Bonsai 2 27B (local)", "icon": "🌳", "reasoning": true, "maxTokens": 8192 }
      ]
    }
  ]
}
```

Fields: `id` (lowercase identifier, also the Pi provider id), `name`, `baseUrl` (the `/v1` root), optional `apiKey` (default `local`, a placeholder Pi requires), optional `reservation` (see below), optional `compat` (default `supportsDeveloperRole: false`, `supportsReasoningEffort: true`), `models` with `id`, `name`, `icon` (required: an emoji such as `🌳` or a Pi Remote asset name; a model without one is refused at parse time, so it is never registered or written to the catalog), `reasoning`, `input`, `contextWindow` (when unset, the engine's advertised `context_window` from `/models` is used, else 8192), `maxTokens` and, for reasoning models, `thinkingLevelMap` (default: `off` and `minimal` send `none`, `low`, `medium`, and `high`/`xhigh`/`max` send `xhigh`). `start.command` runs through `systemd-run --user --unit <unit> --collect`, so the engine outlives the session that started it and answers to `systemctl --user status <unit>`; `readySeconds` bounds the wait. `PI_STACK_LOCAL_MODELS_LAUNCHER=direct` spawns the command directly (tests). `PI_STACK_LOCAL_MODELS_QUIET=1` silences the log lines.

## Maintenance reservation

An engine that shares an accelerator with other work can be paused. `reservation` names the lock file that says so, and [`reservation.mjs`](reservation.mjs) owns the protocol for everyone:

- A **maintenance holder** — a benchmark, a repair, anything that needs the device to itself — takes that file **exclusively** for as long as the engine must stay down, then stops the engine. From a shell that is `exec 9>PATH; flock -w 15 -E 75 9`.
- Every **consumer** takes it **shared** around admission: probing the engine, starting it, and waiting for it to answer. Consumers run `flock --shared --nonblock --conflict-exit-code 75 PATH sh -c 'printf held; exec cat'`, so the lock lives in a child that also releases it if the consumer dies.

Neither side has a check-then-start window. A consumer that already holds the shared side keeps maintenance out until the engine is actually up, so a benchmark can never stop a half-started engine; and while maintenance holds the exclusive side, no consumer starts the unit, so the pause holds however many Pi sessions open during it.

**The lease is admission-scoped, not request-scoped.** Once this extension has registered the provider, the model requests a Pi session makes travel under Pi's own client and are not leased. That is deliberate: a shared lease held for the life of a session would deny maintenance for as long as that session lived, and the interesting failure was a paused engine being restarted, not a request arriving at a running one. While maintenance holds the engine down those requests fail with a connection error, which is the engine's true state. A consumer whose request is short and bounded may hold its lease across the request instead — Pi Remote's thread naming does, so a pause that begins mid-title waits a second or two rather than killing it.

`waitSeconds` is how long a consumer keeps trying, default `0`. At `0` a consumer reports the reservation at once; a larger value lets a session wait a bounded time for the device to come free. Background work such as Pi Remote's thread naming always passes `0` and retries after the lease rather than occupying it.

A reserved engine comes back from `ensureEngine` as `{ ready: false, reserved: true, detail }`. The extension does not start it, keeps its models registered and in `models.json` — a pause is not a broken engine, and the picker should not lose the model for the length of a benchmark — and requests to it fail while it is down. A reservation whose lock cannot be evaluated at all, for example without `flock` on `PATH`, refuses the start as well: a declared reservation is never silently ignored.

An engine with no `reservation` behaves exactly as it did before.

Bonsai Halo's `serve` mode implements chat completions with streaming, `reasoning_content`, `reasoning_effort` and the model's tool-call format. Replace the example paths with the host's executable, model and lock paths; the manifest and engine resource notes belong to the host's machine handbook.

`node --test local-models.test.mjs` covers manifest parsing, catalog merging, launching a delayed fake engine, the extension's registration and catalog write against a temporary agent directory, and the reservation: a held exclusive lock leaves the engine stopped and its models listed, a start in progress makes a would-be maintenance holder exit 75, a bounded wait joins the engine after the lease ends, and an unusable lock refuses the start. It takes about three seconds.

Pi Remote's supervisor carries the second implementation of the consumer half, [`apps/remote/server/engine-reservation.ts`](../../../../apps/remote/server/engine-reservation.ts), because it deploys as its own tree under Bun. Its manifest field names, defaults and lock semantics must match this file.
