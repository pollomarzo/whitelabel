#!/usr/bin/env bash
# The ONLY bash in the engine (design §12). The composite action has already checked out
# the engine at the pinned ref into ./.engine and set INSTANCE_REPO from pins.yml. This
# does the CI-specific *materialization* §1b assigns it — typst on PATH, instance-config
# cloned, BASE_URL by event — then dispatches to dist/cli.cjs, where all LOGIC lives.
# (Resolves the §12 "5 lines" aspiration toward §1b: setup here, logic in the bundle.)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
engine="$(cd "$here/.." && pwd)"
verb="${1:-}"

# A runnable engine ⟺ a release ([R57]): dist/cli.cjs is committed ONLY onto release-tag
# leaves, never a branch tip. If it's absent the pinned ref is a branch (or a bad tag) —
# fail loud with the fix, not a raw "Cannot find module". This guard IS the enforcement of
# "CI runs released tags only"; nothing else rejects a branch pin.
if [ ! -f "$engine/dist/cli.cjs" ]; then
  echo "::error::engine ref carries no dist/cli.cjs — pin a released tag, not a branch tip (a runnable engine ⟺ a release, [R57]; see RELEASING.md)"
  exit 1
fi

# typst — prefer a binary shipped with the engine tag ([R34]); else rely on PATH.
if [ -x "$engine/bin/typst" ]; then export PATH="$engine/bin:$PATH"; fi

extra=()

# build + release run a real myst build → materialize instance-config + pick BASE_URL.
if [ "$verb" = "build" ] || [ "$verb" = "release" ]; then
  # BASE_URL: '' for PR previews (served at the Cloudflare root), '/<repo>' for Pages/prod.
  if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
    base_url=""
  else
    base_url="/${GITHUB_REPOSITORY##*/}"
  fi
  extra+=(--base-url "$base_url")

  # instance-config: public, depth-1, default branch (dec. 16/19). '.' = co-located
  # (repo=journal, deferred) — leave to the CLI's root resolution.
  if [ -n "${INSTANCE_REPO:-}" ] && [ "${INSTANCE_REPO}" != "." ]; then
    inst_dir="$(mktemp -d)"
    git clone --depth 1 "https://github.com/${INSTANCE_REPO}.git" "$inst_dir"
    extra+=(--instance "$inst_dir")
  fi
fi

echo "::group::engine context"
echo "engine dir : $engine"
echo "verb       : $verb"
echo "instance   : ${INSTANCE_REPO:-<co-located>}"
echo "extra args : ${extra[*]:-<none>}"
# Secret PRESENCE only — never the value (design §1a: echo what we resolved; aids a
# tenant's first broken run, and lets the [R18] step-env-propagation spike be observed
# on prepare/publish/preview-deploy without leaking anything). `:+present` is set -u safe.
echo "GH_TOKEN     : ${GH_TOKEN:+present}"
echo "ZENODO_TOKEN : ${ZENODO_TOKEN:+present}"
echo "CLOUDFLARE   : ${CLOUDFLARE_API_TOKEN:+present}"
echo "::endgroup::"

exec node "$engine/dist/cli.cjs" "$@" "${extra[@]}"
