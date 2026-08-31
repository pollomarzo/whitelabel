# Releasing the engine: the bundle delivery model

**One invariant: a runnable engine ⟺ a release.** ([R57])

The paper shim runs the engine by *checkout*, not install (`ci/run.sh` ends with
`exec node "$engine/dist/cli.cjs"`; no `npm install`, no network on the CI hot path). So
`dist/cli.cjs` must already exist at whatever ref a paper pins. Hence: **the only way a *ref*
becomes runnable is a release**, and the release commits the built bundle *onto the tag's leaf
commit*. `dist/` and `bin/` are gitignored and are **never** committed to `main` or any branch,
only to the leaf a release tag points at. You never hand-commit a build artifact.

## The two dev paths (there is nothing between them)

| You want to… | Use | Ref? | Network? |
|---|---|---|---|
| Iterate on **CLI logic** locally | `oak build` (working tree) | no, your WIP | no |
| Make a **ref** runnable, for CI or anyone pinning a version | a release | yes, a tag | push only |

`oak build` runs the code in front of you; nothing ever *pins* it. A release is the only thing CI
or a `version:` pin consumes; there is no "pin a branch and have it built."

## Testing a change end-to-end = cut a dev release

`oak build` cannot reproduce the GitHub-Actions surface: composite-action `if:`/`hashFiles`
gating, step-`env:` secret propagation, fork-PR preview behavior ([R18]). To exercise *that* you
need a real ref in CI, which means a release:

```bash
# build bundle + typst, commit both to the tag's leaf, push the tag, create a GH pre-release
scripts/cut-engine-release.sh v0.0.0-dev.25     # locally (needs node + gh authed)
#   or: Actions ▸ cut-engine-release ▸ Run workflow ▸ version: v0.0.0-dev.25

# then pin it in the fixture paper and run CI
#   myst.yml → project.options.oaktree-sapling.version: v0.0.0-dev.25
```

A `-` in the version marks it `--prerelease`, keeping it out of `releases/latest`. Every test thus
runs the **real release path**; it stays healthy because it is exercised constantly, instead of
being a rarely-run 2am surprise.

## Before a cut

- **`npm test`** (includes the integration canary that renders the fixture PDF through the bundled
  CLI) and **`npm run build:fixture`** (a second offline PDF). The cut runs the same two commands,
  but not against the same typst: it fetches `bin/typst` at `typst.version` first and renders with
  that, while locally the canary uses whatever `typst` is on `PATH` and SKIPS itself when there is
  none. So a local pass de-risks the cut without being the same gate; a typst-version regression is
  only caught by the cut.
- **The "pin a release" guard.** With the bundle absent the shim must fail loud, not with a raw
  `Cannot find module`:
  ```bash
  mv dist/cli.cjs /tmp/ && ci/run.sh build ; mv /tmp/cli.cjs dist/
  # expect: ::error:: engine ref carries no dist/cli.cjs; pin a released tag…
  ```
  This guard **is** the enforcement of "CI runs released tags only": a paper pinning a branch
  hits exactly this.

The script's own guards (version shape, dirty tree, existing tag) each exit before any push, so a
mistake here is cheap; it refuses to clobber a tag, because a bad tag breaks every tenant.

## Dev-release hygiene: accumulate + prune

Dev releases are cheap and disposable. **Accumulate them, then prune**; do **not** reuse a moving
`dev` tag (a tag whose meaning silently changes is worse than noise).

- **Name** them `vX.Y.Z-dev.N`, marked pre-release, so `version: latest` never resolves to one.
- **Never deposit a real paper** against a dev release; its tag will be deleted. Zenodo, not the
  engine tag, is the reproducibility anchor (§7, dec. 6 / [R56]).
- **Prune** stale dev releases + their tags periodically:

  ```bash
  # newest-first, so this keeps the newest 5 dev pre-releases and deletes the rest (tag + release)
  gh release list --limit 100 --json tagName,isPrerelease \
    --jq '.[] | select(.isPrerelease and (.tagName | test("-dev\\."))) | .tagName' \
    | tail -n +6 \
    | xargs -r -I{} gh release delete {} --cleanup-tag --yes
  ```

  (Prereleases only; real `vX.Y.Z` releases are never pruned.)

## What rides the tag leaf, and why

`cut-engine-release.sh` force-adds **`dist/cli.cjs`** and **`bin/typst`** (fetched at the version in
`typst.version`, and used to render the canary, test-what-you-ship) onto the leaf, then tags it.
So a checked-out engine tag is immediately runnable *including the PDF export*. The Zenodo deposit's
`engine.zip` is a `git archive` of that checkout, which is what makes a DOI'd PDF re-renderable on
linux-x86_64 + node with nothing fetched.

⚑ **`bin/typst` is `linux-x86_64` (musl) only**: one hardcoded asset, no matrix
(`cut-engine-release.sh`). That is deliberate and sufficient: every workflow here and in the seeded
templates is `runs-on: ubuntu-latest`, so the CI hot path always matches, and it is why the
re-renderability claim above names a platform. The consequence is for a tag checked out anywhere
else (macOS, arm64) where the PDF export falls back to a system typst. `ci/run.sh` probes that
the shipped binary *runs* before putting it on `PATH`, precisely so it cannot shadow a working one:
a Linux ELF keeps its executable bit on macOS, so testing `-x` alone used to prepend a binary that
dies with `Exec format error`.

The rule for what earns a place at the tag leaf: things that are reproducibility-critical for the
DOI'd artifact **and** not controlled by us: today exactly `bin/typst`. Our own assets
(`book-theme.zip`, `typst-template.zip`) stay fetched-at-build. A typst bump = edit `typst.version`
+ cut a release, riding the single `options.oaktree-sapling.version` review gate.

**Why commit-at-tag rather than the obvious alternatives.** Three reasons, in order: the shim
installs nothing, so the bundle must already be *in* the checkout; local and CI then consume the
same committed object, making them byte-identical by git identity rather than by hoping esbuild is
reproducible; and `bin/typst` inside `engine.zip` is what a DOI'd artifact needs to re-render.
Rejected, so they don't get re-proposed: committing the bundle to `main` per-commit (bloats the
browsed history with a build artifact); having CI commit it back (forces a `git pull` after every
push); force-pushed `*-built` refs (standing infra for a rare need); rolling Release *assets* with
download-at-checkout (puts the network back on the CI hot path, and assets don't survive a repo
move the way a committed git object does); Git LFS (a dependency in every consumer).

The accepted cost is that a floating branch is **not** runnable in CI: an unreleased pin fails
loud in the shim. That is deliberate, and it also removes most of the ref-trust surface, since only
tags ever run.

## The npm package (`oaktree-sapling`, 0.x)

A second delivery path, and **not yet the one CI uses**: papers still run the engine by checkout,
exactly as above. What follows is what the package is and is not, so nobody infers a guarantee from
its existence.

**Two coordinate systems, deliberately.** `package.json`'s `version` is independent of the
release tag (`vX.Y.Z-dev.N`), which `cut-engine-release.sh` takes as an argument. npm versions are
effectively permanent (72 h unpublish window) and must be real semver, so they cannot follow the
disposable dev tags. **Nothing currently keeps the two in step** (the cut script has no npm step)
so a published version does not name a tag and cannot be mapped back to one. Closing that is the
job of the eventual publish-from-CI step, folded into the cut, with npm trusted publishing (OIDC)
in the canonical repo; until then, treat the npm version as naming a *source state*, not a ref.

**`repository` points at the interim home** (`pollomarzo/whitelabel`). It is per-version metadata,
not a name: it changes with the canonical move and later versions carry the new URL. `--provenance`
requires it to match the repo whose Actions run publishes, so it must never be moved ahead of the
publisher.

**`files` is an allowlist**, so anything unlisted is excluded by construction. It carries what the
CLI reads at runtime (`dist/cli.cjs`, `templates/` less `!templates/*/README.md`,
`paper-base.yml`, `typst.version`) plus the whole of `ci/` and `plugins/`, which are consumed from
the checkout and a pinned raw URL rather than the package, but are small enough that shipping them
keeps the tarball a faithful subset. Read the list in `package.json`, not this sentence: it is the
enforcement, and a new file under a listed directory ships without anyone editing prose. `prepack` (not `prepublishOnly`) runs typecheck + bundle: `dist/` is gitignored and a
missing file is *silently omitted* from a tarball rather than erroring, and `prepack` is the only
hook that fires on both `npm pack` and `npm publish`.

**Two things an npm-installed engine cannot do**, both because it is a package rather than a
checkout:

- **No PDF.** `bin/typst` rides the tag leaf and is not in the tarball (per-platform binaries have
  no clean npm answer: `optionalDependencies` or a postinstall download, both real design work).
  `ci/run.sh` adds `$engine/bin` to `PATH` only if the shipped binary runs, so an install without
  a system typst degrades silently to no export.
- **No `engine.zip`.** `oak deposit` builds it with `git archive` over the engine root
  (`zenodo.ts`), and `node_modules/oaktree-sapling` is not a git repository. Latent while deposits
  run in CI from a tag checkout; a hard failure the moment they do not.

Mechanics: `scripts/cut-engine-release.sh` (its header comment explains each step) and
`.github/workflows/cut-engine-release.yml`: one path, runnable locally and by CI. The design
ledger records this as **[R57]** (delivery) and **[R66]** (typst + deposit self-containment); those
tags are the cross-reference if you have the ledger to hand; this file does not depend on it.
