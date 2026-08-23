#!/usr/bin/env bash
# Proves, end to end and against the deployed build, that a session survives a
# provider that never answers: it retries in-turn on the raised budget, then
# the host waits and resumes the same session instead of ending the run.
#
# Everything here is private — its own ledger, agent directory, config, and a
# fake OpenAI-compatible provider on localhost that answers every request with
# a 500. The fleet's ledger, accounts, and runners are untouched.
#
# Takes about six minutes: exhausting six retries at 5s doubling is 315s of
# the run, and there is no way to reach the host's layer without spending them.
#
# Usage: tools/failing-provider-probe.sh [path-to-deployed-cli]
set -euo pipefail

CLI=${1:-/srv/pi/pi-orchestrator/dist/cli.js}
[[ -f $CLI ]] || { echo "no CLI at $CLI (deploy first, or pass a path)"; exit 1; }

DIR=$(mktemp -d /tmp/failing-provider-probe.XXXXXX)
RUNS=$DIR/runs
export PI_ORCHESTRATOR_LEDGER=$DIR/ledger.sqlite3
export PI_ORCHESTRATOR_CONFIG=$DIR/config.json
export PI_ORCHESTRATOR_RUNS=$RUNS
export PI_CODING_AGENT_DIR=$DIR/agent
mkdir -p "$DIR/agent" "$DIR/work" "$RUNS"

cleanup() {
  [[ -n ${SERVER_PID:-} ]] && kill "$SERVER_PID" 2>/dev/null
  [[ -n ${RUNNER_PID:-} ]] && kill "$RUNNER_PID" 2>/dev/null
  wait 2>/dev/null || true
  # The runner's session writes its own files as it unwinds, and a delete
  # racing that leaves the directory behind: give it a moment, then insist.
  sleep 2
  rm -rf "$DIR" || { sleep 3; rm -rf "$DIR"; }
}
trap cleanup EXIT

# Port 0, never a fixed one: another agent may be running this probe, or
# anything else, on the port you picked.
cat > "$DIR/server.mjs" <<'EOF'
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
let hits = 0;
const server = createServer((_req, res) => {
  console.log(new Date().toISOString(), "request", ++hits);
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "probe provider is down on purpose", code: 500 } }));
});
server.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(server.address().port)));
EOF

node "$DIR/server.mjs" "$DIR/port" & SERVER_PID=$!
for _ in $(seq 1 50); do [[ -s $DIR/port ]] && break; sleep 0.2; done
PORT=$(cat "$DIR/port" 2>/dev/null) || true
[[ -n ${PORT:-} ]] || { echo "probe provider never came up"; exit 1; }

cat > "$DIR/agent/models.json" <<EOF
{ "providers": { "probe": {
  "name": "Probe", "baseUrl": "http://127.0.0.1:$PORT/v1", "api": "openai-completions",
  "apiKey": "probe", "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
  "models": [{ "id": "probe-model", "name": "Probe Model", "contextWindow": 100000, "maxTokens": 4096 }] } } }
EOF
echo '{ "probe": { "type": "api_key", "key": "probe" } }' > "$DIR/agent/auth.json"
echo '{}' > "$DIR/agent/settings.json"
cat > "$DIR/config.json" <<'EOF'
{
  "tiers": { "light": [], "standard": [{ "provider": "probe", "model": "probe-model", "thinking": "off" }], "expert": [] },
  "providers": { "probe": { "meters": [], "sessionCapacity": 1 } },
  "maxConcurrentSessions": 1
}
EOF

node "$CLI" account add probe --provider probe > /dev/null
# Credentialing is the daemon's job and this probe has no daemon; the account's
# credential is the models.json key sitting next to it.
sqlite3 "$PI_ORCHESTRATOR_LEDGER" "update account set fleet_credentialed=1;"
node "$CLI" task set probe-task --tiers standard --demand-constant 1 \
  --prompt "Say hello." --cwd "$DIR/work" > /dev/null
node "$CLI" spawn probe-task | tail -1
node "$CLI" runner --id probe-runner --max-sessions 1 --interval 2000 > "$DIR/runner.log" 2>&1 &
RUNNER_PID=$!

echo "waiting for the session to exhaust its retries and be resumed (about six minutes)..."
for _ in $(seq 1 80); do
  sleep 10
  events=$(cat "$RUNS"/*/events.jsonl 2>/dev/null || true)
  grep -q "Your last turn was cut off" <<< "$events" && break
done

# Only the retries of the first turn: by the time the resumption lands, the
# session is already retrying its way through the next one.
retries=$(awk '/Provider failed the turn/ { exit } /"text":"Retrying/ { n++ } END { print n+0 }' <<< "$events")
echo
echo "in-turn retries before the host stepped in: $retries (want 6; 3 means the budget was lost)"
grep -o 'provider failed the turn[^"]*' "$DIR/runner.log" | head -1
echo

fail=0
(( retries >= 6 )) || { echo "FAIL: retry budget did not reach the session"; fail=1; }
grep -q "Provider failed the turn" <<< "$events" || { echo "FAIL: host did not wait"; fail=1; }
grep -q "Your last turn was cut off" <<< "$events" || { echo "FAIL: session was not resumed"; fail=1; }
state=$(sqlite3 "$PI_ORCHESTRATOR_LEDGER" "select state from run limit 1;")
[[ $state == running ]] || { echo "FAIL: run is $state, not still running"; fail=1; }
(( fail == 0 )) && echo "PASS: the session rode out a provider that never answered"
exit $fail
