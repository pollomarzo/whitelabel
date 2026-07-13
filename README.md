# oaktree-sapling — the white-label journal engine

The platform ENGINE (design.md §2): one tagged repo carrying **all** journal logic —
workflows, base configs, compose, the Zenodo deposit, the gallery plugin, the typst
template — referenced by every journal via a single `options.oaktree-sapling.version`
coordinate. This tree is the in-progress port from `isp-actions-config` +
`oaktree-sapling` scripts + `zenodo-deposit.py`.

**Home:** developed on `pollomarzo/whitelabel` (interim, personal account; renamed from
`oaktree-sapling` 2026-07-12, [R58]) to avoid the disruptive legacy-repo rename; moves to a
canonical org repo later via replayed commits on a clean branch ([R56], defers [R30]). The
home is named in two places (`pins.yml` `engine_repo` + the `cli.ts` fallback), so the move is
a one-line owner swap + re-cut releases (`dist/cli.cjs` replays — committed at the tag; only
true Release assets don't, [R57]). The repo *name* is one of three independent roles of
"oaktree-sapling" — only the repo changed; the `options.oaktree-sapling.*` myst key + the npm
package/bin are unchanged ([R58]).

**Live-validated 2026-07-12** — the full shim ran on a real runner; [R18] closed ([R58]–[R64]).
See `../testing.md` + `../interim-fixtures/PROVISIONING.md`.

See `../design.md` (what/why), `../implementation.md` (how), `../existing-implementation.md`
(the port sources).

## Status — slices 0, 1, 2 (pure core + `oak build` end-to-end)

Done and green (`npm test` → **37 passing**, `npm run typecheck` clean; the integration
test renders a real PDF through the bundled CLI):

| File | Slice role |
|---|---|
| `src/schema.ts` | zod contracts for the `oaktree-sapling` options key, `journal.yml`, the registry, `pins.yml`; id-shape + id-uniqueness checks (design dec. 20). Additive-only (dec. 24). JSON-Schema export. |
| `src/compose.ts` | **pure** compose(): assembles the engine‹edition‹brand extends chain + computes the engine `ownOverride` (asset URLs). Unit-tested. |
| `src/ref.ts` | engine-ref classification + the floating-author trust policy (dec. 23 / [R41]); syntactic half only — ancestry check is CI-side. |
| `src/assets.ts` | version-matched typst-template + theme-zip URLs (closes [R5]). |
| `src/yaml-io.ts` | working-tree myst.yml round-trips (Document API, never sed — [R3]). |
| `src/build.ts` | **`oak build`**: the two-pass orchestrator ([R52]); myst edge injected for testing. |
| `src/myst.ts` | the mystmd edge (the one module importing bundled myst-cli — [R51]); sets the current project+site pointers via `findCurrent*AndLoad` so `build` renders HTML ([R59]). |
| `src/cli.ts` | `oak` entry point; `build` + `deposit`/`release` implemented; `deploy-preview`/`notify`/`validate`/`bootstrap`/`upgrade` stubbed by slice. |
| `src/zenodo.ts` | **`oak deposit`**: the zenodo-deposit.py port (prepare/publish/status); paginated + id-first lookups, `deposit/` bundle, tenant bytes from journal.yml. HTTP + git/gh injected as seams; no myst-cli import. |
| `src/gh.ts` | git/gh side effects (`GitContext` + DOI PR / release asset / comment / issue), kept out of `zenodo.ts` so the deposit logic stays network-free under test. |
| `templates/typst/` | the engine's generic typst template (seeded from lapreprint-typst; used by path for offline PDF — design dec. 2). |
| `test/fixture-*`, `test/integration.test.ts` | the release-safety canary (design §12 step 0). |

`paper-base.yml` / `nexus-base.yml` are the engine-owned data compose wires in;
`ci/run.sh` is the ~5-line shim dispatcher.

## Building locally / testing with a local template

```
npm run bundle          # esbuild → dist/cli.cjs (CJS, ~12MB — [R51])
npm run build:fixture    # builds the fixture paper via the in-engine typst template, OFFLINE
```

`oak build` auto-detects `templates/typst` (no release zip needed); `--typst-template
<path>` overrides it, `--no-site-template` uses myst's default theme until the fork
release exists. The two-pass ([R52]): write `extends:` → `loadConfig` → write the
complete engine typst entry + theme to the working-tree OWN config → `build`. Neither
write is committed.

### Releasing — a runnable engine ⟺ a release ([R57], `RELEASING.md`)

CI runs **released tags only**; a paper pins a tag in `options.oaktree-sapling.version`,
never a branch. `dist/cli.cjs` is gitignored on `main` and **committed onto the tag's
leaf commit** by `scripts/cut-engine-release.sh vX.Y.Z` (or the `cut-engine-release`
workflow) — so `main` stays clean (no pull-after-push), local == CI is byte-identical
(same committed object), and the bundle *replays* on the canonical home move (it's a git
object, unlike Release assets). A branch/unreleased pin fails loud in the shim (above).
Testing the pipeline = cut a `vX.Y.Z-dev.N` pre-release (accumulate + prune). Rationale +
rejected options: `release-delivery-decision.md`.

The pinned **typst** binary rides the same tag leaf ([R34]; see `../implementation.md` [R66]):
`cut-engine-release.sh` fetches the linux-x86_64 musl build at the version in `typst.version`,
renders the canary with it, and commits `bin/typst` alongside `dist/cli.cjs` (`bin/` gitignored
on `main`). `ci/run.sh` puts `$engine/bin/typst` on PATH, so a checked-out tag renders the PDF
with no runner install or hot-path fetch. The Zenodo deposit also carries an `engine.zip`
(`git archive` of the engine at the tag → typst + bundle + template), so the DOI'd PDF is
re-renderable on linux-x86_64 + node with nothing fetched. Locally, keep `typst` on PATH
(`oak build` and the integration test use it directly).

### Findings baked into these fixtures/code (not yet in design.md)

1. **`id` ≠ `slug` ≠ `location`** — three distinct registry coordinates. Real ids are
   `isp-`-prefixed/semantic (suheylgulenc → `isp-micropublication-decisive-times`),
   never the repo slug. `RegistryEntry` carries all three; the `id_sentinel` a paper
   is rejected for is **instance-defined** (`journal.yml`), not a global constant.
2. **Typst export is engine-owned and WHOLE** ([R52]/[R53]) — myst merges `exports` by
   id, whole-entry, base-wins, NO field merge; splitting a skeleton in paper-base from
   `articles`/`template` in the edition races and drops fields (caught in the first real
   build). So the complete export lives in `paper-base.yml`, editions carry none, compose
   swaps only `template:` on the paper's OWN working-tree config (deterministic win).
3. **`project.options.youtube` coexists with `options.oaktree-sapling`** — schema reads
   only the engine subkey; the override pass touches only exports + site.template, never
   options. Guarded end-to-end (the fixture's real youtube survives the whole pipeline).
4. **Dual layouts** (e.g. `tahiri/Paper/`) — layout enforcement must reject a *stray
   secondary* `myst.yml`, not just a missing top-level one. (Deferred to `oak validate`.)
5. **HTML needs the current-site pointer** ([R59], live run) — `loadConfig` fills the store's
   `sites` map but not `currentSitePath`, so `build` skipped HTML. `myst.ts` calls
   `findCurrentProjectAndLoad`/`findCurrentSiteAndLoad` before `build`. Offline canaries use
   `--exports-only` since HTML needs a network theme zip ([R60]).
6. **Instance brand needs a resolvable favicon + absolute asset paths** ([R61]/[R62], live run) —
   a missing site favicon is a *fatal* prerender error; relative `./logo.svg` doesn't resolve
   through `extends` (resolved vs the paper, not the brand dir). Interim fixture uses URLs; the
   owed fix is `compose()` absolutizing instance-relative paths (typst watermark needs real paths).

## Next

- **✅ Live [R18] validation — DONE (2026-07-12).** The frozen shim + release delivery ([R57])
  ran on a real runner; both composite-action spikes confirmed, Pages deploy green ([R58]–[R64]).
  Bugs found+fixed en route: `ci/run.sh` exec bit ([R64a]) + the site-pointer bug ([R59]).
- **✅ Slice 3 — `zenodo.ts` — DONE (2026-07-12).** Port of zenodo-deposit.py: paginated lookups
  [R20]/[R35], `deposit/` folder [R28], id-first identity [R7], tenant bytes → journal.yml [R19],
  version-agnostic prepare (the tag carries the version, at publish). `oak deposit`/`release`
  unstubbed. **Verified live against the Zenodo sandbox:** prepare→draft, publish→PDF + all bundle
  files + metadata parity, and id-first reuse across a simulated repo move (the [R7] guarantee).
- **Frontier now:** `deploy-preview`/`notify` (slice 2-shim) + `validate` (slice 4) still stubbed.
  Slice-3 loose ends: geetha's sentinel `id` still unfixed ([R12], blocks id-first in prod); the
  gh side effects (DOI PR / release asset / issue) are wired but only exercised in CI; pagination
  is unit-tested only (the sandbox account has <100 depositions).
- **Deferred here:** `--no-site-template` uses myst's default theme (network); a pinned
  local/cached theme + the cover-page/summary typst feature port are follow-ups.

## Dev

```
npm install
npm test         # vitest
npm run typecheck
```
