# Engine bundle delivery — decision handoff

Companion to `handoff-release-story.md` (the problem). Full rationale: `../implementation.md` [R57].
Dev process: `RELEASING.md`.

**Problem.** The paper shim runs the engine by *checkout* (`node .engine/dist/cli.cjs`, no install),
so the ~12 MB `dist/cli.cjs` must exist at whatever ref a paper pins — branch tips *and* tags —
without (1) forcing pull-after-push, (2) local/CI drift, (3) network on the CI hot path.

## Options considered

| # | Option | Why not |
|---|---|---|
| 1 | Commit bundle into `main`, every commit | Bloats the browsed history; a build artifact in source ("feels wrong"). |
| 2 | CI commits the bundle back to `main` | Forces the developer to `git pull` after every push (constraint 1). |
| 3 | Force-pushed `*-built` refs + `branch:` resolution in the shim | Standing infra (a build-and-force-push workflow + permanent frozen-shim logic) for a rare need. |
| 4 | Rolling Release **assets** + download-at-checkout | Reopens network-on-hot-path ([R34]); assets don't replay on the home move ([R56]). |
| 5 | Git LFS for `dist/` | LFS dependency in every consumer; per-repo LFS storage *complicates* the home move. |
| 6 | Floating branch → resolve latest tag at checkout | Half-measure; folded into "tags only" — see chosen. |
| ✅ | **A runnable engine ⟺ a release** | Chosen — below. |

## Chosen: a runnable engine ⟺ a release

The bundle is **committed onto the tag's leaf commit** by `cut-engine-release`; **CI runs released
tags only**; `oak build` is the local working-tree inner loop; **testing = cut a `vX.Y.Z-dev.N`
pre-release** (accumulate + prune).

**Why it won**
- One invariant, least code — no built refs, no download path, no per-commit `main` bloat.
- **local == CI is guaranteed**, not hoped: both consume the *same committed bundle object* (byte-identity by git).
- Commits land only at *sparse tag leaves*, never in `main`'s browsed history.
- A committed git object **replays on the interim→canonical home move** (unlike a Release asset, [R56]).
- No network on the hot path (constraint 3); **dissolves most of the [R41] ref-trust surface** (only tags run).
- The release path is exercised on every test → it stays healthy, not a rare 2am surprise.

**Costs accepted**
- Floating-branch-in-CI is **dropped** (handoff constraint 4 relaxed to *local-only*); an unreleased pin fails loud in the shim.
- Exercising the CI plumbing costs a throwaway dev release (mitigated: `oak build` covers the logic inner loop).
- Needs the small `cut-engine-release` helper (built; distinct from the Zenodo publish path).

typst was out of scope here originally; it is now **resolved** and rides the same tag-leaf
mechanism ([R34]/[R66], `../implementation.md`): `cut-engine-release.sh` ships `bin/typst` next to
`dist/cli.cjs`, and the Zenodo deposit carries an `engine.zip` so the DOI'd PDF is re-renderable
on linux-x86_64 + node with nothing fetched. The decision doc also retires two framings this
file leaned on — "replay-on-move" and "no network on the hot path" — as the *reasons* for
commit-at-tag; the surviving reasons are install pathology (`dist/cli.cjs`) and
reproducibility-of-the-DOI'd-artifact (`bin/typst`).
