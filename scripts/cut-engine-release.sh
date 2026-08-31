#!/usr/bin/env bash
# cut-engine-release.sh: the ONE way to make an engine *ref* runnable ([R57]).
#
# A runnable engine ⟺ a release. This builds dist/cli.cjs and commits it ONTO THE TAG'S
# LEAF COMMIT (never onto main or any branch), pushes ONLY the tag, and creates a GH
# (pre-)release. It runs identically in CI (the cut-engine-release workflow) and by hand:
# the release path is the product, so there is exactly one path.
#
#   scripts/cut-engine-release.sh v0.3.0-dev.4     # dev pre-release (accumulate + prune)
#   scripts/cut-engine-release.sh v1.2.0           # real release (immutable, never re-cut)
#
# A '-' in the version (semver pre-release) ⇒ marked --prerelease. Requires: node+npm and gh
# authed (GH_TOKEN in CI). typst is NOT required on PATH; this script fetches the pinned
# linux-x86_64 binary (typst.version) into bin/typst and both renders the canary with it AND
# ships it ([R34]/[R66]).
#
# NOTE ([R57]): the bundle is delivered by being *committed at the tag*, NOT uploaded as a
# Release asset (install pathology + local==CI byte-identity are the reasons, [R66] retires
# the "replay-on-move"/"no network" framings). bin/typst
# rides the same tag leaf so the checked-out engine is immediately runnable AND the Zenodo
# deposit's engine.zip is self-contained. The GH release is just the marker/pre-release flag.
set -euo pipefail

version="${1:-}"
cd "$(cd "$(dirname "$0")/.." && pwd)"   # engine root

# --- validate the version shape -------------------------------------------------------
if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::version must look like v1.2.0 or v1.2.0-dev.4 (got '${version:-<empty>}')" >&2
  exit 1
fi

# --- refuse to clobber an existing tag ------------------------------------------------
# Real vX.Y.Z are immutable; dev releases accumulate as a NEW N (never reuse a moving tag).
if git rev-parse -q --verify "refs/tags/$version" >/dev/null 2>&1 \
   || git ls-remote --exit-code --tags origin "refs/tags/$version" >/dev/null 2>&1; then
  echo "::error::tag $version already exists, bump the version (dev releases accumulate)" >&2
  exit 1
fi

# --- release only a clean source commit -----------------------------------------------
# The build steps below touch only gitignored paths (node_modules/, dist/), so a clean tree
# here guarantees the leaf's tree = exactly this source commit + dist/cli.cjs.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "::error::working tree has uncommitted tracked changes, commit or stash first" >&2
  exit 1
fi
src_sha="$(git rev-parse HEAD)"

# --- fetch the engine-pinned typst binary ([R34]/[R66]) --------------------------------
# Committed at the tag leaf next to dist/cli.cjs (gitignored on main). We render the canary
# with the SAME binary we ship (test-what-you-ship) by putting bin/ on PATH. Version is
# owned by typst.version; a bump rides the single options.oaktree-sapling.version coordinate.
typst_version="$(tr -d '[:space:]' < typst.version)"
typst_asset="typst-x86_64-unknown-linux-musl"
echo "fetching typst ${typst_version} (${typst_asset})"
mkdir -p bin
tmp_typst="$(mktemp -d)"
curl -fsSL "https://github.com/typst/typst/releases/download/v${typst_version}/${typst_asset}.tar.xz" \
  | tar -xJ -C "$tmp_typst"
install -m 0755 "$tmp_typst/${typst_asset}/typst" bin/typst
rm -rf "$tmp_typst"
export PATH="$PWD/bin:$PATH"
bin/typst --version

# --- release-safety canary (§12 step 0): a bad tag breaks every tenant -----------------
npm ci
npm run typecheck          # vitest transpiles through esbuild, which STRIPS types without
                           # checking them, so a type error passes `npm test` and reaches a tag.
                           # test.yml says so in its own comment and is deliberately not a
                           # required check, so a documented hole in a workflow that cannot block
                           # anything was the whole of the guard.
npm run bundle             # esbuild → dist/cli.cjs
npm test                   # unit + the integration canary (renders the fixture PDF via bin/typst)
npm run build:fixture      # second, standalone render through the freshly-built bundle

# --- build the leaf commit WITHOUT moving any branch (git plumbing) --------------------
# dist/ and bin/ are gitignored; force-add them into the index, snapshot the index as a tree,
# and make a detached commit parented on the source commit. HEAD/branches never move, so
# `main` is not advanced (handoff constraint 1: pushing never forces the developer to pull).
# Identity for the release commit + tag ONLY. Env vars, not `git config`: a bare `git config`
# writes .git/config and never unsets it, so a local cut silently re-authors every later commit
# in the developer's clone as the bot (invisible in CI, where the checkout is throwaway).
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-oak-release-bot}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-oak-release-bot@users.noreply.github.com}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
# The index is the DEVELOPER's index on a local cut. If the script dies between the add and the
# reset, the two ignored artifacts are left staged and the next ordinary `git commit` puts them on
# a branch, which makes that branch a runnable engine ref: the shim's guard is a file-existence
# test, so `main` would then pass it. Unstage on any exit, not just the happy one.
trap 'git reset -q -- dist/cli.cjs bin/typst 2>/dev/null || true' EXIT
git add -f dist/cli.cjs bin/typst
tree="$(git write-tree)"
leaf="$(git commit-tree "$tree" -p "$src_sha" -m "release: $version (engine bundle + typst)")"
git reset -q               # unstage; dist/cli.cjs + bin/typst return to ignored untracked files

# --- tag the leaf, push ONLY the tag (never HEAD/a branch) -----------------------------
# A runnable engine ⟺ a release ([R57]), so a pushed tag with no Release breaks the invariant in
# the direction that matters: the tag carries dist/cli.cjs and CI will run it. `gh release create`
# can fail for reasons that have nothing to do with this cut (expired auth, a 5xx), and the version
# is then spent, since the clobber guard above refuses to re-cut and a real release is never
# re-cut. So the tag is removed again if the Release does not follow it.
git tag -a "$version" -m "$version" "$leaf"
git push origin "refs/tags/$version"

# --- GH (pre-)release: a '-' in the version ⇒ prerelease -------------------------------
prerelease=()
[[ "$version" == *-* ]] && prerelease=(--prerelease)
if ! gh release create "$version" "${prerelease[@]}" \
  --title "$version" \
  --notes "Engine bundle release ([R57]): \`dist/cli.cjs\` is committed at this tag (not an asset)."; then
  echo "release creation failed; removing the tag so $version is not burned" >&2
  git push origin --delete "refs/tags/$version" || true
  git tag -d "$version" || true
  exit 1
fi

echo "cut $version at ${leaf} (source ${src_sha})"
