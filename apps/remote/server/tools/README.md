# Remote API performance probes

`api-latency.py` runs the actual UI read routes against a selected own-person session. It records only timings, wire sizes, HTTP/API outcomes and opaque locators. Response text, titles, tool arguments, cookies and private context never enter receipts or stdout. Keep receipts outside public source. A router session cookie can be supplied through `PI_PERFORMANCE_COOKIE_FILE`; the thread token is read from `PI_THREAD_TOKEN`, not a command argument.

```sh
python3 apps/remote/server/tools/api-latency.py \
  --base-url http://127.0.0.1:18790 --session-id OWN_SESSION_ID \
  --samples 6 --routes sessions,all-agents,archived,thread-list,sync,workers-sync \
  --output /private/performance/directory.json

python3 apps/remote/server/tools/api-latency.py \
  --base-url http://127.0.0.1:18790 --session-id OWN_SESSION_ID \
  --samples 6 --routes transcript,older-page,lazy-body,selected-sync \
  --output /private/performance/transcript.json
```

Other labels cover health, environment, workspaces, actions, voice, dashboard-sync, detail, settings, commands, questions, children, images and the bounded native context-window diagnostic. That diagnostic reports API errors even when the HTTP envelope is 200. A legitimately oversized native record is an error, not a successful fast empty page. `--export` additionally streams and counts the complete context export without retaining it; export is not an ordinary opening dependency.

The first observation is not a cold-service measurement: these probes never restart a live service or discard its caches. Warm p50/p95 use subsequent observations and nearest-rank p95. Split route sets to fit an attended command budget; submit longer matrices to the host's durable job service. `viewing:false` prevents read probes from marking a chat viewed. `get_commands` may attach an idle runtime to read its extension commands, so use a disposable own fixture if runtime attachment is unwanted.

## Isolated locator durability benchmark

```sh
bun apps/remote/server/tools/transcript-locator-bench.ts /installed/remote/server/source-transcripts.ts /own/disk/fixture-root 6
bun apps/remote/server/tools/transcript-locator-bench.ts "$PWD/apps/remote/server/source-transcripts.ts" /own/disk/fixture-root 6
```

Each run creates its own synthetic 60-head file-backed SQLite fixture with WAL/FULL durability in the explicit storage root and removes it afterwards. Use the same disk/storage class as the service; `/tmp` may be tmpfs and suppress the durability cost being measured. Cold time includes the first locator commit; warm time includes all later page derivation and locator work. This isolates the difference between one fsync per item, one atomic page commit, and an unchanged page with zero row mutations.

## Directory read contract

Normal supervisor refresh uses `list({archived:false})` plus `archived({kind:"count"})`. Archived ancestors needed for placement are fetched by identity, not by scanning all history. Direct archived-session URLs hydrate the requested record and ancestors on demand.

The `archived` thread-owner operation accepts a typed count query or a page query with explicit offset, limit, conversation filter and order. A page query scans narrow archive title/identity/time metadata in its owning database, filters literal Unicode titles, then hydrates only selected rows. Returned totals are exact. Source revisions detect archive changes across pages. The directory merges bounded owner pages globally; Remote's conversations-only query consults only the person owner, not fleet roots. An unavailable owner or malformed result is an explicit error, never an empty successful archive.
