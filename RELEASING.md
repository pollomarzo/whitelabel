# Releasing the engine — the bundle delivery model

**One invariant: a runnable engine ⟺ a release.** ([R57])

The paper shim runs the engine by *checkout*, not install (`ci/run.sh` ends with
`exec node "$engine/dist/cli.cjs"`; no `npm install`, no network on the CI hot path). So
`dist/cli.cjs` must already exist at whatever ref a paper pins. We guarantee that with a single
rule: **the only way a *ref* becomes runnable is a release**, and the release process commits the
built bundle *onto the tag's commit*.

`dist/` is gitignored in the working tree. It is **never** committed to `main` or any branch —
only to the (leaf) commit a release tag points at. `main`'s history stays clean; you never
hand-commit a build artifact.

## The two dev paths (there is nothing between them)

| You want to… | Use | Ref? | Network? |
|---|---|---|---|
| Iterate on **CLI logic** locally | `oak build` (working tree) | no — your WIP | no |
| Make a **ref** runnable — for CI, or for anyone pinning a version | `oak release` | yes — a tag | push only |

- **`oak build`** runs the code in front of you. Nothing ever *pins* it; it is not "a ref."
  This is the fast inner loop for logic. (See README → "Building locally".)
- **A release** is the *only* thing CI or a `version:` pin ever consumes. There is no
  "pin a branch and have it built," no built-ref/force-push machinery, no download-at-checkout.

**Why local == CI is free:** both consume the *same committed released bundle object* — identical
bytes by git identity, never "did esbuild reproduce the same output?" The only time you build a
bundle locally is `oak build` from your own tree, where diverging from CI is the point.

## Testing a change end-to-end (the CI plumbing) = cut a dev release

`oak build` cannot reproduce the GitHub-Actions surface — composite-action `if:`/`hashFiles`
gating, step-`env:` secret propagation, fork-PR preview behavior ([R18]). To exercise *that*, you
must run a real ref in CI, which means a release:

```bash
# build bundle + commit it to the tag's leaf + push the tag + create a GH pre-release
scripts/cut-engine-release.sh v0.3.0-dev.4      # locally (needs node, typst, gh authed)
#   — or — Actions ▸ cut-engine-release ▸ Run workflow ▸ version: v0.3.0-dev.4

# then pin it in the fixture paper and run CI
#   myst.yml → project.options.oaktree-sapling.version: v0.3.0-dev.4
```

A `-` in the version marks it `--prerelease` (kept out of `releases/latest`). The script
refuses to clobber an existing tag and gates on the fixture build (§12 step 0) — a bad tag
breaks every tenant.

Every test thus runs the **real release path** — the "release path is the product" bet: it stays
healthy because it is exercised constantly, instead of being a rarely-run 2am surprise.

## Dev-release hygiene: accumulate + prune

Dev releases are cheap and disposable. **Accumulate them, then prune** — do **not** reuse a moving
`dev` tag (a tag whose meaning silently changes over time is worse than noise).

- **Name** them `vX.Y.Z-dev.N` and mark them **pre-release** on GitHub (keeps them out of
  `releases/latest`, so `version: latest` never resolves to one).
- **Never deposit a real paper** against a dev release — its tag will be deleted. Zenodo, not the
  engine tag, is the reproducibility anchor (§7, dec. 6 / [R56]).
- **Prune** stale dev releases + their tags periodically, e.g.:

  ```bash
  # list dev pre-releases oldest-first, delete all but the newest few (tag + release)
  gh release list --limit 100 \
    | awk '$0 ~ /-dev\./ {print $1}' \
    | tail -n +6 \
    | xargs -r -I{} gh release delete {} --cleanup-tag --yes
  ```

  (Prereleases only; real `vX.Y.Z` releases are never pruned.)

## Constraints this satisfies (from `handoff-release-story.md`)

1. **No forced pull-after-push** — the release commits to a *tag leaf*, never back to the branch
   you pushed; nothing lands on `main` on top of your push.
2. **local == CI** — both consume the same committed released bundle object (byte-identity).
3. **No `npm install` / no network on the CI build hot path** — a released checkout is
   immediately runnable.
4. **Floating-branch-in-CI is deliberately dropped** — CI runs *released tags only*; an
   unreleased pin fails loud in the shim (`::error:: pin a release`). This also dissolves most of
   the [R41] ref-trust surface.
5. **Reproducibility rests on Zenodo, not the engine tag** — dev releases are throwaway; the
   committed bundle *replays* on the interim→canonical home move (git object, not a Release asset).

## typst rides the tag too ([R34]/[R66])

The pinned typst binary **is** delivered by this mechanism now. `cut-engine-release.sh` fetches
the linux-x86_64 musl binary at the version in `typst.version`, renders the release-safety
canary with it (test-what-you-ship), and force-adds `bin/typst` onto the same tag leaf as
`dist/cli.cjs` (`bin/` is gitignored on `main`, like `dist/`). So a checked-out engine tag is
immediately runnable *including the PDF export* — no typst on the runner, no fetch on the build
hot path. `ci/run.sh` already puts `$engine/bin/typst` on PATH.

Why committed-at-tag rather than cache/fetch: the reproducibility argument, not the network one.
The Zenodo deposit carries an `engine.zip` (`git archive` of the engine checkout — which, at the
tag leaf, includes `bin/typst` + `dist/cli.cjs` + `templates/typst/`), making the DOI'd artifact
re-renderable on **linux-x86_64 + node + the deposit, nothing fetched**. Full rationale +
rejected alternatives: `../implementation.md` [R66]. A typst bump = edit `typst.version` + cut a
release; it rides the single `options.oaktree-sapling.version` coordinate like a myst-cli bump.

## Implementation

- **`scripts/cut-engine-release.sh`** — the git mechanics, runnable locally and by CI (one path).
  Validates the version shape, refuses to clobber an existing tag, gates on `npm test` +
  `npm run build:fixture`, then builds the leaf commit with `git commit-tree` (no branch moves),
  tags it, pushes **only the tag**, and creates the GH (pre-)release.
- **`.github/workflows/cut-engine-release.yml`** — `workflow_dispatch` (version + optional ref);
  sets up node + typst (for the canary) and calls the script. `contents: write`; nothing writes
  to a branch.

Intentionally small and **distinct from the Zenodo publish path** (slice 3, `zenodo.ts`). The
future `oak release` verb will wrap this same script so the CLI and CI stay one path.

**typst version** in the workflow (`TYPST_VERSION`) is a placeholder pin — reconcile it with the
engine's [R34] shipped-binary version once that is defined.
