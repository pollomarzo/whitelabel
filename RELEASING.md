# Releasing the engine — the bundle delivery model

**One invariant: a runnable engine ⟺ a release.** ([R57])

The paper shim runs the engine by *checkout*, not install (`ci/run.sh` ends with
`exec node "$engine/dist/cli.cjs"`; no `npm install`, no network on the CI hot path). So
`dist/cli.cjs` must already exist at whatever ref a paper pins. Hence: **the only way a *ref*
becomes runnable is a release**, and the release commits the built bundle *onto the tag's leaf
commit*. `dist/` and `bin/` are gitignored and are **never** committed to `main` or any branch —
only to the leaf a release tag points at. You never hand-commit a build artifact.

## The two dev paths (there is nothing between them)

| You want to… | Use | Ref? | Network? |
|---|---|---|---|
| Iterate on **CLI logic** locally | `oak build` (working tree) | no — your WIP | no |
| Make a **ref** runnable — for CI, or for anyone pinning a version | a release | yes — a tag | push only |

`oak build` runs the code in front of you; nothing ever *pins* it. A release is the only thing CI
or a `version:` pin consumes — there is no "pin a branch and have it built."

## Testing a change end-to-end = cut a dev release

`oak build` cannot reproduce the GitHub-Actions surface — composite-action `if:`/`hashFiles`
gating, step-`env:` secret propagation, fork-PR preview behavior ([R18]). To exercise *that* you
need a real ref in CI, which means a release:

```bash
# build bundle + typst, commit both to the tag's leaf, push the tag, create a GH pre-release
scripts/cut-engine-release.sh v0.0.0-dev.25     # locally (needs node + gh authed)
#   — or — Actions ▸ cut-engine-release ▸ Run workflow ▸ version: v0.0.0-dev.25

# then pin it in the fixture paper and run CI
#   myst.yml → project.options.oaktree-sapling.version: v0.0.0-dev.25
```

A `-` in the version marks it `--prerelease`, keeping it out of `releases/latest`. Every test thus
runs the **real release path** — it stays healthy because it is exercised constantly, instead of
being a rarely-run 2am surprise.

## Before a cut

- **`npm test`** (includes the integration canary that renders the fixture PDF through the bundled
  CLI) and **`npm run build:fixture`** (a second offline PDF). These are exactly what
  `cut-engine-release.sh` gates on, so passing them locally de-risks the cut.
- **The "pin a release" guard.** With the bundle absent the shim must fail loud, not with a raw
  `Cannot find module`:
  ```bash
  mv dist/cli.cjs /tmp/ && ci/run.sh build ; mv /tmp/cli.cjs dist/
  # expect: ::error:: engine ref carries no dist/cli.cjs — pin a released tag…
  ```
  This guard **is** the enforcement of "CI runs released tags only" — a paper pinning a branch
  hits exactly this.

The script's own guards (version shape, dirty tree, existing tag) each exit before any push, so a
mistake here is cheap; it refuses to clobber a tag, because a bad tag breaks every tenant.

## Dev-release hygiene: accumulate + prune

Dev releases are cheap and disposable. **Accumulate them, then prune** — do **not** reuse a moving
`dev` tag (a tag whose meaning silently changes is worse than noise).

- **Name** them `vX.Y.Z-dev.N`, marked pre-release, so `version: latest` never resolves to one.
- **Never deposit a real paper** against a dev release — its tag will be deleted. Zenodo, not the
  engine tag, is the reproducibility anchor (§7, dec. 6 / [R56]).
- **Prune** stale dev releases + their tags periodically:

  ```bash
  # dev pre-releases oldest-first, delete all but the newest few (tag + release)
  gh release list --limit 100 \
    | awk '$0 ~ /-dev\./ {print $1}' \
    | tail -n +6 \
    | xargs -r -I{} gh release delete {} --cleanup-tag --yes
  ```

  (Prereleases only; real `vX.Y.Z` releases are never pruned.)

## What rides the tag leaf, and why

`cut-engine-release.sh` force-adds **`dist/cli.cjs`** and **`bin/typst`** (fetched at the version in
`typst.version`, and used to render the canary — test-what-you-ship) onto the leaf, then tags it.
So a checked-out engine tag is immediately runnable *including the PDF export*. The Zenodo deposit's
`engine.zip` is a `git archive` of that checkout, which is what makes a DOI'd PDF re-renderable on
linux-x86_64 + node with nothing fetched.

The rule for what earns a place at the tag leaf: things that are reproducibility-critical for the
DOI'd artifact **and** not controlled by us — today exactly `bin/typst`. Our own assets
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

The accepted cost is that a floating branch is **not** runnable in CI — an unreleased pin fails
loud in the shim. That is deliberate, and it also removes most of the ref-trust surface, since only
tags ever run.

Mechanics: `scripts/cut-engine-release.sh` (its header comment explains each step) and
`.github/workflows/cut-engine-release.yml` — one path, runnable locally and by CI. The design
ledger records this as **[R57]** (delivery) and **[R66]** (typst + deposit self-containment); those
tags are the cross-reference if you have the ledger to hand — this file does not depend on it.
