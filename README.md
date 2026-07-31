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
Since then `oak conformance` certifies the paper CI on every release cut ([R78]).

> **`[R#]` tags** throughout this repo reference the design ledger (`implementation.md`), which is
> maintained **separately and is not part of this repository**. They are provenance anchors, not
> links — nothing here requires the ledger to be at hand. `RELEASING.md` is self-contained.

## Status — slices 0–5 (every verb built)

Done and green (`npm test` → **215 passing**, `npm run typecheck` clean; the integration
test renders a real PDF through the bundled CLI):

| File | Slice role |
|---|---|
| `src/schema.ts` | zod contracts for the `oaktree-sapling` options key, `journal.yml`, the registry, `pins.yml`; id-shape + id-uniqueness checks (design dec. 20). Additive-only (dec. 24). JSON-Schema export. |
| `src/compose.ts` | **pure** compose(): assembles the engine‹edition‹brand extends chain + computes the engine `ownOverride` (asset URLs). Unit-tested. |
| `src/ref.ts` | engine-ref classification + the floating-author trust policy (dec. 23 / [R41]); syntactic half only — ancestry check is CI-side. |
| `src/assets.ts` | version-matched typst-template + theme-zip URLs (closes [R5]). |
| `src/yaml-io.ts` | config round-trips (Document API, never sed — [R3]) + `DERIVED_CONFIG_FILE`. The author's `myst.yml` is read-only; writes go to the derived `myst.oak.yml` ([R71]). |
| `src/build.ts` | **`oak build`**: the two-pass orchestrator ([R52]); myst edge injected for testing. |
| `src/myst.ts` | the mystmd edge (the one module importing bundled myst-cli — [R51]); sets the current project+site pointers via `findCurrent*AndLoad` so `build` renders HTML ([R59]). |
| `src/cli.ts` | `oak` entry point; every verb implemented (`build`, `validate`, `check-post`, `deposit`, `release`, `deploy-preview`, `notify`, `bootstrap`, `upgrade`, `conformance`) — nothing stubbed. |
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

`oak build` falls back to `templates/typst` in the checkout (no release zip needed) — the
**bottom** of the template precedence chain ([R79]): `--typst-template <path>` (explicit) ›
the author's own `exports[].template` › the journal's `typst_template:` in `journal.yml` ›
this engine default. `--no-site-template` uses myst's default theme until the fork release
exists. The two-pass ([R52]): write `extends:` → `loadConfig` → write the
complete engine typst entry + theme → `build`. **Both writes go to the DERIVED config
`myst.oak.yml` ([R71])** — the author's `myst.yml` is an input and is never modified.
myst is pointed at the derived file via `new Session({ configFiles })`; it is gitignored
by the frozen template and NOT auto-deleted (myst's HTML build `process.exit(0)`s on
success, so no cleanup hook can reliably run). compose also pins the export `output:` (`TYPST_OUTPUT`), so the PDF
lands at `_build/exports/paper.pdf` for every paper — myst would otherwise
derive both the directory and (for multi-article exports) the filename from the
declaring config's name, coupling artifact paths to an engine-internal filename.

### Releasing — a runnable engine ⟺ a release ([R57], `RELEASING.md`)

CI runs **released tags only**; a paper pins a tag in `options.oaktree-sapling.version`,
never a branch. `dist/cli.cjs` is gitignored on `main` and **committed onto the tag's
leaf commit** by `scripts/cut-engine-release.sh vX.Y.Z` (or the `cut-engine-release`
workflow) — so `main` stays clean (no pull-after-push), local == CI is byte-identical
(same committed object), and the bundle *replays* on the canonical home move (it's a git
object, unlike Release assets). A branch/unreleased pin fails loud in the shim (above).
Testing the pipeline = cut a `vX.Y.Z-dev.N` pre-release (accumulate + prune). Rationale +
rejected options: `RELEASING.md`.

The pinned **typst** binary rides the same tag leaf ([R34]/[R66]):
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
   swaps only `template:` on the derived config's base slot (deterministic win, [R71]).
3. **`project.options.youtube` coexists with `options.oaktree-sapling`** — schema reads
   only the engine subkey; the override pass touches only exports + site.template, never
   options. Guarded end-to-end (the fixture's real youtube survives the whole pipeline).
4. **Dual layouts** (e.g. `tahiri/Paper/`) — layout enforcement must reject a *stray
   secondary* `myst.yml`, not just a missing top-level one. (Done: `checkLayout` in `oak validate`.)
5. **HTML needs the current-site pointer** ([R59], live run) — `loadConfig` fills the store's
   `sites` map but not `currentSitePath`, so `build` skipped HTML. `myst.ts` calls
   `findCurrentProjectAndLoad`/`findCurrentSiteAndLoad` before `build`. Offline canaries use
   `--exports-only` since HTML needs a network theme zip ([R60]).
6. **Instance brand needs a resolvable favicon + absolute asset paths** ([R61]/[R62], live run) —
   a missing site favicon is a *fatal* prerender error; relative `./logo.svg` doesn't resolve
   through `extends` (resolved vs the paper, not the brand dir). **Fixed** ([R68]): `compose()`
   absolutizes instance-relative brand assets, and `oak validate` warns on an absent/unresolvable
   favicon or watermark. (A URL is fine for HTML but not typst, which cannot fetch.)

## Next

Every slice (0–5) is built and live-proven: the shim on a real runner ([R18]/[R58]–[R64]), the
Zenodo deposit chain against the sandbox ([R65]/[R67]), preview + notify on real
Cloudflare/GitHub ([R69]/[R70]), typst + `engine.zip` delivery ([R66]), and `oak conformance`
certifying all four paper-CI trigger classes on every release cut ([R78]).

The frontier is rollout and deferred decisions, not verbs:

- **The real rollout** — stand up the public instance (`oak bootstrap journal --external`) and
  migrate-vs-archive the 12 real 2026 papers, including a codemod stripping the boilerplate venue
  `template:` URLs those papers carry ([R79]).
- **npm packaging** ([R73]) — `typstTemplateUrl()` still points at a `typst-template.zip` no
  release cuts; an npm-installed `oak` has no `templates/typst`, so either cut the zip or ship the
  template in the tarball. Remote templates being first-class ([R79]) makes cutting it coherent.
- **Layer-B sees the author's config, not the composed one** ([R71]) — arguably wrong, since the
  composed config is what gets published; deliberately not changed on a refactor because it can
  flip a merge verdict.
- **Deferred:** the untested token-exfil / ref-trust path ([R41]); C5, the conformance
  promotion gate ([R78]); a pinned local/cached theme (today `--no-site-template` falls back to
  myst's default, which needs the network) and the cover-page/summary typst feature port.

## Editorial checks (Layer B)

`oak validate` has two layers. **Layer A** (`src/validate.ts`) is the engine's own invariants
(id sentinel/shape/uniqueness, the n=1 paper layout, brand favicon/watermark resolvability).
**Layer B** (`src/checks.ts`) is the journal-selected editorial checks (`journal.yml` `checks:`):
authors exist / have ORCIDs / have valid CRediT roles, abstract exists, keywords defined, and
more.

The Layer-B checks are provided by the MIT-licensed
[`@curvenote/check-implementations`](https://www.npmjs.com/package/@curvenote/check-implementations)
and [`@curvenote/check-definitions`](https://www.npmjs.com/package/@curvenote/check-definitions)
(see `package.json`). The engine supplies the *runner* (`runChecks` — which of the catalog checks
a journal selects, and how an optional check is treated) and the GitHub Check-Run *reporter*
(`toCheckRun`).

## Dev

```
npm install
npm test         # vitest
npm run typecheck
```
