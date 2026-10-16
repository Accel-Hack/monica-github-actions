#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$1"
  exit 1
}

# Composite actions do not enforce required inputs.
[[ -n ${MONICA_PROJECT:-} ]] || fail "input project is empty"
[[ -n ${MONICA_RELEASE:-} ]] || fail "input release is empty"
[[ -d ${MAPS_PATH:-} ]] || fail "input path is not a directory: ${MAPS_PATH:-}"
if [[ -z ${ACTIONS_ID_TOKEN_REQUEST_URL:-} || -z ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-} ]]; then
  fail "no GitHub OIDC token available; give the job 'permissions: id-token: write' (a pull request from a fork never gets one)"
fi

# Ingest accepts a token only when its audience equals the Ingest origin, which has no trailing slash.
ingest=${INGEST_URL%/}
dir=${MAPS_PATH%/}
prefix=${URL_PREFIX%/}
uri() { jq -rn --arg v "$1" '$v | @uri'; }

body=$(mktemp)
response=$(mktemp)
trap 'rm -f "$body" "$response"' EXIT

count=0
while IFS= read -r -d '' map; do
  rel=${map#"$dir"/}
  file=$prefix/${rel%.map}
  # Ingest drops sourcesContent too; removing it here keeps the source code inside CI.
  jq -c 'del(.sourcesContent)' "$map" | gzip -c >"$body" || fail "$map is not JSON"
  # OIDC tokens are short-lived and a large build can outlast one, so each file gets a fresh token.
  token=$(curl -sS --fail --retry 3 --max-time 30 \
    -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
    "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$(uri "$ingest")" | jq -er .value) ||
    fail "could not get a GitHub OIDC token"
  status=$(curl -sS --retry 3 --max-time 60 -o "$response" -w '%{http_code}' -X PUT \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Content-Encoding: gzip" \
    --data-binary "@$body" \
    "$ingest/v1/sourcemaps?project=$(uri "$MONICA_PROJECT")&release=$(uri "$MONICA_RELEASE")&file=$(uri "$file")") ||
    fail "PUT $file ($map) did not complete"
  if [[ $status != 2?? ]]; then
    cat "$response"
    echo
    hint=""
    if [[ $status == 403 ]]; then
      hint="; is ${GITHUB_REPOSITORY:-this repository} selected in the GitHub section of project $MONICA_PROJECT's Settings in MONICA?"
    fi
    fail "PUT $file ($map) returned $status$hint"
  fi
  echo "uploaded $map as $file"
  count=$((count + 1))
done < <(find "$dir" -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' \) -print0)

((count > 0)) || fail "no *.js.map, *.mjs.map or *.cjs.map files under $dir"
