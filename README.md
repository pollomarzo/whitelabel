# oaktree-sapling — the white-label journal engine

The platform ENGINE (design.md §2): one tagged repo carrying **all** journal logic —
workflows, base configs, compose, the Zenodo deposit, the gallery plugin, the typst
template — referenced by every journal via a single `options.oaktree-sapling.version`
coordinate. This tree is the in-progress port from `isp-actions-config` +
`oaktree-sapling` scripts + `zenodo-deposit.py`.

**Home:** developed on `pollomarzo/oaktree-sapling` (interim, personal account) to avoid
the disruptive legacy-repo rename; moves to canonical `open-scholar-nexus/oaktree-sapling`
later via replayed commits on a clean branch ([R56], defers [R30]). Because the home is
named in exactly one place (`pins.yml` `engine_repo`), the move is a one-line owner swap +
re-cut releases (release *assets* don't replay with git).

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
| `src/myst.ts` | the mystmd edge (the one module importing bundled myst-cli — [R51]). |
| `src/cli.ts` | `oak` entry point; `build` implemented, other verbs stubbed by slice. |
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

## Next

- **Live [R18] validation (untested).** The frozen shim (`copier-template/`) and the
  release delivery ([R57]) are authored but not yet run against a real runner. Stand up
  the interim fixture repos and cut `v0.0.0-dev.1` per `../interim-fixtures/PROVISIONING.md`
  to close the two composite-action spikes ([R18]) — the one thing local parsing can't verify.
- **Slice 3 — `zenodo.ts`** (port of zenodo-deposit.py: paginate all lookups [R20]/[R35],
  `deposit/` folder [R28], id-first identity [R7], tenant bytes → journal.yml [R19]) + deploy;
  unstubs `oak deposit`/`release`. `deploy-preview`/`notify` (slice 2-shim) unstub alongside.
- **Deferred here:** `--no-site-template` uses myst's default theme (network); a pinned
  local/cached theme + the cover-page/summary typst feature port are follow-ups.

## Dev

```
npm install
npm test         # vitest
npm run typecheck
```
