#!/usr/bin/env bash
# Compute the bindings.json key for a given cwd.
#
# Thin wrapper around src/derive-binding-key-cli.ts so the rules (realpath
# resolution, CLAUDE_DISCORD_CWD_REWRITE parsing, rewrite boundary semantics,
# sha1 derivation) live in a single TypeScript source. Earlier versions of
# this script duplicated the JS logic inline, which drifted from
# src/session-id.ts whenever the rewrite contract evolved (e.g. the
# rewrite-to-root boundary fix).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cli="$here/../src/derive-binding-key-cli.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "derive-binding-key: bun is required to invoke the TS source" >&2
  exit 127
fi

exec bun run --silent "$cli" "${1:-$PWD}"
