#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo 'Usage: rename-thread.sh "Two or Three Words"' >&2
  exit 2
fi

: "${PI_REMOTE_SESSION_ID:?PI_REMOTE_SESSION_ID is available only inside a Pi Remote agent}"
: "${PI_REMOTE_SERVER_URL:=http://127.0.0.1:8788}"

title="$*"
printf '%s' "$title" | curl --fail-with-body --silent --show-error \
  --request PUT \
  --header 'Content-Type: text/plain; charset=utf-8' \
  --data-binary @- \
  "${PI_REMOTE_SERVER_URL}/v1/sessions/${PI_REMOTE_SESSION_ID}/name"
printf '\n'
