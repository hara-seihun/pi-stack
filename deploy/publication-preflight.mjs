import { readFileSync } from 'node:fs';

const sha = /^[a-f0-9]{40}$/;
const request = /^PUB-[a-f0-9]{24}$/;
const failure = (kind, message) => ({ ok: false, error: { kind, message } });
const script = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const path = value => typeof value === 'string' && value.startsWith('/') && !/[\s\0]/.test(value);

// The caller keeps durable reservation/native-history custody. This batch never
// advances history, changes source selection, fetches, or reads thread content.
export function buildHostPreflight(input) {
  if (!input || !request.test(input.requestId) || !sha.test(input.integrationSha)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.hostId)
    || !path(input.releaseRepository) || !path(input.hostConfig)
    || !['all', 'restart-blockers', 'override'].includes(input.meetings)
    || typeof input.runtimeCensusScript !== 'string' || !input.runtimeCensusScript.trim()) {
    return failure('invalid-host-preflight-input', 'Host identity, paths, meeting policy and runtime census source must be explicit');
  }
  let source;
  try {
    source = script('release-checkout') + '\n' + String.raw`
set -euo pipefail
request=$1 candidate=$2 host=$3 repository=$4 host_file=$5 meeting_mode=$6
` + `runtime_census() (\n${input.runtimeCensusScript}\n)\nmeeting_census() (\n${script('meeting-census')}\n)\nnative_prerequisites() (\n${script('native-prerequisites')}\n)\n` + String.raw`
reservation_check() (
  set -euo pipefail
  reservation="\${PI_STACK_HOST_LOCK_PATH:-/srv/pi/.pi-stack-deploy.lock}.publication"
  [[ -e $reservation ]] || { echo 'host reservation is absent' >&2; exit 65; }
  jq -e --arg request "$request" --arg commit "$candidate" \
    '.requestId == $request and .integrationSha == $commit' "$reservation" >/dev/null || {
    echo 'host reservation belongs to another publication' >&2; exit 75;
  }
)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
observations='{}'
observe() {
  local name=$1 status output detail
  shift
  set +e
  output=$("$@" 2>"$work/stderr")
  status=$?
  set -e
  detail=$(<"$work/stderr")
  observations=$(jq -c --arg name "$name" --argjson status "$status" --arg stdout "$output" --arg stderr "$detail" \
    '. + {($name): {status:$status,stdout:$stdout,stderr:$stderr}}' <<<"$observations")
}
set +e
pi_stack_acquire_host_lock 2>"$work/stderr"
lock_status=$?
set -e
if (( lock_status != 0 )); then
  observations=$(jq -nc --argjson status "$lock_status" --arg stderr "$(<"$work/stderr")" '{reservation:{status:$status,stdout:"",stderr:$stderr}}')
else
  observe reservation reservation_check
fi
# These observations are independent; their consumer preserves admission order.
# No absent reservation is interpreted as permission to observe private state.
if [[ $(jq -r '.reservation.status' <<<"$observations") == 0 ]]; then
  observe runtime runtime_census "$host" "$repository"
  if [[ $meeting_mode == override ]]; then
    observations=$(jq -c '. + {meetings:{state:"override"}}' <<<"$observations")
  else
    observe meetings meeting_census "--$meeting_mode"
  fi
  observe native native_prerequisites "$host_file" "$repository" "$candidate"
fi
jq -nc --arg host "$host" --arg requestId "$request" --arg integrationSha "$candidate" --argjson observations "$observations" \
  '{version:1,host:$host,requestId:$requestId,integrationSha:$integrationSha,observations:$observations}'
`;
  } catch (error) { return failure('preflight-source-unavailable', error.message); }
  source = source.replaceAll('\\${', '${');
  return { ok: true, value: { script: source, args: [input.requestId, input.integrationSha, input.hostId,
    input.releaseRepository, input.hostConfig, input.meetings] } };
}

const validObservation = value => value && Number.isSafeInteger(value.status) && value.status >= 0
  && typeof value.stdout === 'string' && typeof value.stderr === 'string';

export function nativePreflightResult(observation, hostId) {
  if (!validObservation(observation)) return failure('invalid-native-preflight-output', 'Native prerequisite observation is invalid');
  const result = { ...observation, ok: observation.status === 0 };
  if (result.ok || result.status === 75 && /^native source prerequisite [^\r\n]+ requires [0-9a-f]{40} before Pi Stack [0-9a-f]{40}; selected [0-9a-f]{40}$/m.test(result.stderr)) {
    return { ok: true, value: result };
  }
  return { ok: false, error: { kind: 'native-source', host: hostId, status: result.status,
    message: result.stderr.trim() || `native prerequisite probe exited ${result.status}` } };
}

export function parseHostPreflight(result, input) {
  if (!result?.ok) return { ok: false, error: { kind: 'host-preflight-command-failed', status: result?.status,
    message: result?.stderr || result?.stdout || 'Host preflight returned no command result' } };
  let value;
  try { value = JSON.parse(result.stdout); }
  catch (error) { return failure('invalid-host-preflight-output', error.message); }
  const observations = value?.observations;
  if (value?.version !== 1 || value.host !== input.hostId || value.requestId !== input.requestId
    || value.integrationSha !== input.integrationSha || !validObservation(observations?.reservation)) {
    return failure('invalid-host-preflight-output', 'Host preflight identity or reservation observation is invalid');
  }
  if (observations.reservation.status !== 0) return { ok: false, error: {
    kind: observations.reservation.status === 75 ? 'host-lock-busy' : 'host-reservation-unavailable',
    ...observations.reservation } };
  if (!validObservation(observations.runtime) || !validObservation(observations.native)
    || (input.meetings === 'override' ? observations.meetings?.state !== 'override' : !validObservation(observations.meetings))) {
    return failure('invalid-host-preflight-output', 'Host preflight stage observation is missing or invalid');
  }
  let census;
  if (observations.runtime.status === 0) {
    try { census = JSON.parse(observations.runtime.stdout); }
    catch (error) { return failure('invalid-runtime-census', error.message); }
    if (census?.host !== input.hostId || !Array.isArray(census.runtimes)
      || ![census.selectedCommit, census.checkoutCommit].every(commit => commit === null || sha.test(commit))) {
      return failure('invalid-runtime-census', 'Runtime census must contain explicit valid source markers');
    }
  } else return { ok: false, error: { kind: 'runtime-census-unavailable', ...observations.runtime } };
  return { ok: true, value: { census, meetings: observations.meetings, native: observations.native } };
}

const maintenanceFiles = ['deploy/native-history-boundary', 'deploy/native-history-coordinator.mjs',
  'deploy/native-history-owner-recovery.mjs', 'deploy/native-history-bridge.mjs', 'deploy/native-history-closed-owner.mjs',
  'deploy/native-history-package-identity.mjs', 'deploy/native-history-root-boundary', 'deploy/core-host.mjs', 'deploy/core-runtime', 'deploy/core-adopt', 'deploy/core_namespace.py',
  'scripts/migrate-native-history.mjs', 'deploy/prepare', 'deploy/host', 'deploy/runtime', 'deploy/lib',
  'deploy/orchestrator', 'deploy/prepared-components.mjs'];

// One local command boundary: retain exact source custody and derive all immutable
// Git proofs. sourceRepository is the explicitly selected target's Git repository.
export function buildSourcePreflight(input) {
  if (!input || !path(input.repository) || !sha.test(input.integrationSha)
    || ![input.selectedCommit, input.checkoutCommit].every(commit => commit === null || sha.test(commit))
    || typeof input.sourceRepository !== 'string' || !input.sourceRepository.trim() || /[\s\0]/.test(input.sourceRepository)
    || typeof input.hostId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.hostId)) {
    return failure('invalid-source-preflight-input', 'Repository and explicit nullable source markers are required');
  }
  const source = String.raw`
set -Eeuo pipefail
repository=$1 candidate=$2 selected=$3 checked=$4 source_repository=$5 host=$6
stage=source-custody
failed() {
  jq -nc --arg kind "$1" --arg message "$2" '{ok:false,error:{kind:$kind,message:$message}}'
  exit 0
}
trap 'status=$?; failed source-preflight-unavailable "$stage exited $status"' ERR
git_read() { git --no-replace-objects -C "$repository" "$@"; }
[[ $(git_read rev-parse --is-shallow-repository) == false ]] || failed source-preflight-unavailable 'Cannot prove ancestry from a shallow checkout'
grafts=$(git_read rev-parse --path-format=absolute --git-path info/grafts)
[[ ! -e $grafts ]] || failed source-preflight-unavailable 'Cannot prove ancestry with Git grafts installed'
git_read cat-file -e "$candidate^{commit}"
retain() {
  local commit=$1 status ref="refs/pi-stack-publication/selected/$1"
  if git_read cat-file -e "$commit^{commit}" 2>/dev/null; then status=0; else status=$?; fi
  if (( status != 0 )); then git_read fetch --quiet --no-tags "$source_repository" "$commit:$ref"; fi
  git_read cat-file -e "$commit^{commit}"
  git_read update-ref "$ref" "$commit"
}
for commit in "$selected" "$checked"; do
  [[ -z $commit ]] || retain "$commit"
done
ancestor() {
  local status
  if git_read merge-base --is-ancestor "$1" "$2"; then status=0; else status=$?; fi
  case $status in 0) printf true ;; 1) printf false ;; *) failed release-ancestry-unavailable "Ancestry proof exited $status" ;; esac
}
contract() {
  local status
  if git_read grep -q -F 'THREAD_EXECUTION_CONTRACT = "unified-threads-v1"' "$1" -- packages/orchestrator/src/threads/contracts.ts; then status=0; else status=$?; fi
  case $status in 0) printf true ;; 1) printf false ;; *) failed execution-contract-unavailable "Contract proof exited $status" ;; esac
}
stage=release-ancestry
baselines='[]'
for kind in live checkout; do
  if [[ $kind == live ]]; then commit=$selected; else commit=$checked; fi
  [[ -n $commit ]] || continue
  included=$(ancestor "$commit" "$candidate")
  [[ $included == true || $included == false ]] || { printf '%s\n' "$included"; exit 0; }
  baselines=$(jq -c --arg kind "$kind" --arg repository "$source_repository" --arg ref "refs/pi-stack-publication/selected/$commit" --arg commit "$commit" --argjson included "$included" \
    '. + [{kind:$kind,repository:$repository,ref:$ref,commit:$commit,included:$included}]' <<<"$baselines")
done
superseded=false
selected_contract=false
if [[ -n $selected ]]; then
  superseded=$(ancestor "$candidate" "$selected")
  [[ $superseded == true || $superseded == false ]] || { printf '%s\n' "$superseded"; exit 0; }
  selected_contract=$(contract "$selected")
  [[ $selected_contract == true || $selected_contract == false ]] || { printf '%s\n' "$selected_contract"; exit 0; }
fi
stage=native-maintenance
needed=false
native='{"ok":true,"needed":false}'
if [[ -n $(git_read ls-tree --name-only "$candidate" -- deploy/native-history-boundary) ]]; then
  needed=true
  retained=$(git_read for-each-ref --format='%(objectname)' refs/pi-stack-publication/owner-source)
  if [[ -n $retained ]]; then
    candidate_tree=$(git_read ls-tree -r --format='%(objectname) %(path)' "$candidate" -- ` + maintenanceFiles.join(' ') + String.raw`)
    retained_tree=$(git_read ls-tree -r --format='%(objectname) %(path)' "$retained" -- ` + maintenanceFiles.join(' ') + String.raw`)
    if [[ $candidate_tree != "$retained_tree" ]]; then
      includes_owner=$(ancestor "$retained" "$candidate")
      [[ $includes_owner == true || $includes_owner == false ]] || { printf '%s\n' "$includes_owner"; exit 0; }
      if [[ $includes_owner != true ]]; then
        changed=$(jq -nc --arg candidate "$candidate_tree" --arg retained "$retained_tree" --argjson files '` + JSON.stringify(maintenanceFiles) + String.raw`' 'def blobs: split("\n") | map(select(length>0) | split(" ") | {key:.[1],value:.[0]}) | from_entries; ($candidate|blobs) as $a | ($retained|blobs) as $b | [$files[] | select($a[.] != $b[.])]')
        native=$(jq -nc --arg candidate "$candidate" --arg retained "$retained" --argjson changed "$changed" '{ok:false,error:{code:"obsolete-native-maintenance-source",candidate:$candidate,retained:$retained,changed:$changed}}')
      fi
    fi
  fi
  if [[ $(jq -r .ok <<<"$native") == true ]]; then
    if intake=$(git_read show "$candidate:deploy/native-history-bridge.mjs"); then intake_status=0; else intake_status=$?; fi
    if (( intake_status != 0 )); then
      native='{"ok":false,"error":{"code":"maintenance-intake-contract-unavailable","message":"Cannot read candidate maintenance intake contract"}}'
    elif ! grep -Eq '^export const MAINTENANCE_INTAKE = ['\''"]always-open-v1['\''"];$' <<<"$intake"; then
      native=$(jq -nc --arg candidate "$candidate" '{ok:false,error:{code:"closed-intake-maintenance-forbidden",candidate:$candidate}}')
    else
      native='{"ok":true,"needed":true}'
    fi
  fi
fi
jq -nc --arg host "$host" --arg candidate "$candidate" --argjson baselines "$baselines" --argjson selectedDescendsFromCandidate "$superseded" --argjson selectedHasContract "$selected_contract" --argjson nativeHistory "$native" \
  '{ok:true,value:{ancestry:{host:$host,target:$candidate,baselines:$baselines,ok:all($baselines[];.included)},selectedDescendsFromCandidate:$selectedDescendsFromCandidate,selectedHasContract:$selectedHasContract,nativeHistory:$nativeHistory}}'
`;
  return { ok: true, value: { script: source, args: [input.repository, input.integrationSha, input.selectedCommit ?? '',
    input.checkoutCommit ?? '', input.sourceRepository, input.hostId] } };
}

export function parseSourcePreflight(result, input) {
  if (!result?.ok) return { ok: false, error: { kind: 'source-preflight-command-failed', status: result?.status,
    message: result?.stderr || result?.stdout || 'Source preflight returned no command result' } };
  let proof;
  try { proof = JSON.parse(result.stdout); }
  catch (error) { return failure('invalid-source-preflight-output', error.message); }
  if (proof?.ok === false && typeof proof.error?.kind === 'string' && typeof proof.error.message === 'string') return proof;
  const value = proof?.value;
  const expected = [['live', input.selectedCommit], ['checkout', input.checkoutCommit]].filter(([, commit]) => commit !== null);
  if (proof?.ok !== true || value?.ancestry?.host !== input.hostId || value.ancestry.target !== input.integrationSha
    || typeof value.ancestry.ok !== 'boolean' || !Array.isArray(value.ancestry.baselines)
    || value.ancestry.baselines.length !== expected.length
    || !value.ancestry.baselines.every((baseline, index) => baseline.kind === expected[index][0] && baseline.commit === expected[index][1]
      && baseline.repository === input.sourceRepository && baseline.ref === `refs/pi-stack-publication/selected/${baseline.commit}` && typeof baseline.included === 'boolean')
    || value.ancestry.ok !== value.ancestry.baselines.every(baseline => baseline.included)
    || typeof value.selectedDescendsFromCandidate !== 'boolean' || typeof value.selectedHasContract !== 'boolean'
    || !(value.nativeHistory?.ok === true && typeof value.nativeHistory.needed === 'boolean'
      || value.nativeHistory?.ok === false && ['obsolete-native-maintenance-source', 'maintenance-intake-contract-unavailable', 'closed-intake-maintenance-forbidden'].includes(value.nativeHistory.error?.code))) {
    return failure('invalid-source-preflight-output', 'Source proof is incomplete or differs from the requested source identity');
  }
  return proof;
}
