# Working notes

Internal notes for people changing the engine: the module map, the build internals, and findings
baked into the code that a reader would otherwise have to reverse-engineer. Not part of the npm
package (`files` in `package.json` is an allowlist). `README.md` is the front door; this is the
part that only matters once you are in the source.

> **`[R#]` tags** throughout this repo reference the design ledger (`implementation.md`), which is
> maintained **separately and is not part of this repository**. They are provenance anchors, not
> links; nothing here requires the ledger to be at hand. `RELEASING.md` is self-contained.
> The roadmap lives with that ledger too, so it is deliberately not duplicated here.

## Home

Developed on `pollomarzo/whitelabel` (interim, personal account; renamed from `oaktree-sapling`
2026-07-12, [R58]) to avoid a disruptive legacy-repo rename; moves to a canonical org repo later.
The home is named in two places (`pins.yml` `engine_repo` + the `cli.ts` fallback), so the move is
a one-line owner swap + re-cut releases (`dist/cli.cjs` replays, committed at the tag; only true
Release assets don't, [R57]). The repo *name* is one of three independent roles of
"oaktree-sapling": only the repo changed; the `options.oaktree-sapling.*` myst key and the npm
package/bin are unchanged ([R58]). `package.json`'s `repository` field tracks the interim home and
moves with it; `--provenance` requires it to match the publishing repo.

## Module map

| File | Role |
|---|---|
| `src/schema.ts` | zod contracts for the `oaktree-sapling` options key, `journal.yml`, the registry, `pins.yml`; id-shape + id-uniqueness checks (design dec. 20). Additive-only (dec. 24). JSON-Schema export. |
| `src/compose.ts` | **pure** compose(): assembles the engine‹edition‹brand extends chain + computes the engine `ownOverride` (asset URLs). Unit-tested. |
| `src/ref.ts` | engine-ref classification + the floating-author trust policy (dec. 23 / [R41]); syntactic half only; ancestry check is CI-side. |
| `src/assets.ts` | version-matched typst-template + theme-zip URLs (closes [R5]). |
| `src/yaml-io.ts` | config round-trips (Document API, never sed, [R3]) + `DERIVED_CONFIG_FILE`. The author's `myst.yml` is read-only; writes go to the derived `myst.oak.yml` ([R71]). |
| `src/materialize.ts` | the `MystEdge` seam + the two-pass `materializeDerived` that writes `myst.oak.yml`. Shared by `build` and `validate` ([R82]); its own module so those two do not import each other. |
| `src/build.ts` | **`oak build`**: the two-pass orchestrator ([R52]); myst edge injected for testing. |
| `src/myst.ts` | the mystmd edge (the one module importing bundled myst-cli, [R51]); sets the current project+site pointers via `findCurrent*AndLoad` so `build` renders HTML ([R59]). |
| `src/cli.ts` | `oak` entry point; every verb implemented (`build`, `validate`, `check-post`, `deposit`, `release`, `deploy-preview`, `notify`, `bootstrap`, `upgrade`, `conformance`); nothing stubbed. |
| `src/zenodo.ts` | **`oak deposit`**: the zenodo-deposit.py port (prepare/publish/status); paginated + id-first lookups, `deposit/` bundle, tenant bytes from journal.yml. HTTP + git/gh injected as seams; no myst-cli import. |
| `src/gh.ts` | git/gh side effects (`GitContext` + DOI PR / release asset / comment / issue), kept out of `zenodo.ts` so the deposit logic stays network-free under test. |
| `src/messages.ts` | every tenant-facing CLI string, centralized ([R86]). |
| `templates/typst/` | the engine's generic typst template (seeded from lapreprint-typst; used by path for offline PDF, design dec. 2). |
| `test/fixture-*`, `test/integration.test.ts` | the release-safety canary (design §12 step 0). |

`paper-base.yml` is the engine-owned data compose wires in; `ci/run.sh` is the ~5-line shim
dispatcher.

**`plugins/gallery.mjs`** is the one engine artifact that is *not* engine TypeScript: the journal
site's `paper-cards` directive, which myst loads at runtime by tag-pinned raw URL
(`project.plugins:` accepts remote `.mjs`). It never enters `dist/cli.cjs`, so `myst.ts` stays the
only importer of myst-cli. Its unit tests import the `.mjs` directly (`test/gallery.test.ts`).

**`templates/site/`** is the third template root: the journal site scaffold, unioned with
`templates/instance/` by `oak bootstrap journal --external` ([R80], [S8] variant A′). The site is a
**plain myst build in the instance-config repo** (`oak` never runs there) so the engine has no
site build kind and no `nexus-base.yml`; the theme pin is stamped into the scaffold's `myst.yml` at
bootstrap instead of served from a frozen file. It is one-shot: the tenant owns it outright and
`oak upgrade` does not touch it.

**Template files are stamped under a different name than they ship under**: today just
`gitignore` → `.gitignore`, because npm strips a dotted `.gitignore` from every tarball. See
`STAMP_RENAME` in `src/bootstrap.ts`.

## Building locally / testing with a local template

```
npm run bundle           # esbuild → dist/cli.cjs (CJS, ~9MB, [R51])
npm run build:fixture    # builds the fixture paper via the in-engine typst template, OFFLINE
```

`oak build` falls back to `templates/typst` in the checkout (no release zip needed); the
**bottom** of the template precedence chain ([R79]): `--typst-template <path>` (explicit) › the
author's own `exports[].template` › the journal's `typst_template:` in `journal.yml` › this engine
default. `--no-site-template` uses myst's default theme until the fork release exists. The two-pass
([R52]): write `extends:` → `loadConfig` → write the complete engine typst entry + theme →
`build`. **Both writes go to the DERIVED config `myst.oak.yml` ([R71])**; the author's `myst.yml`
is an input and is never modified. myst is pointed at the derived file via
`new Session({ configFiles })`; it is gitignored by the frozen template and NOT auto-deleted
(myst's HTML build `process.exit(0)`s on success, so no cleanup hook can reliably run). compose
also pins the export `output:` (`TYPST_OUTPUT`), so the PDF lands at `_build/exports/paper.pdf` for
every paper; myst would otherwise derive both the directory and (for multi-article exports) the
filename from the declaring config's name, coupling artifact paths to an engine-internal filename.

Keep `typst` on PATH locally: `oak build` and the integration test use it directly. In CI it comes
from the release tag (`ci/run.sh` puts `$engine/bin/typst` on PATH), which is why a checked-out tag
renders a PDF with no runner install. Full rationale in `RELEASING.md`.

## Findings baked into these fixtures/code

Recorded in the ledger too; kept here because they explain code that otherwise looks arbitrary.

1. **`id` ≠ `slug` ≠ `location`**: three distinct registry coordinates. Real ids are
   `isp-`-prefixed/semantic (suheylgulenc → `isp-micropublication-decisive-times`), never the repo
   slug. `RegistryEntry` carries all three; the `id_sentinel` a paper is rejected for is
   **instance-defined** (`journal.yml`), not a global constant.
2. **Typst export is engine-owned and WHOLE** ([R52]/[R53]): myst merges `exports` by id,
   whole-entry, base-wins, NO field merge; splitting a skeleton in paper-base from
   `articles`/`template` in the edition races and drops fields (caught in the first real build). So
   the complete export lives in `paper-base.yml`, editions carry none, compose swaps only
   `template:` on the derived config's base slot (deterministic win, [R71]).
3. **`project.options.youtube` coexists with `options.oaktree-sapling`**: schema reads only the
   engine subkey; the override pass touches only exports + site.template, never options. Guarded
   end-to-end (the fixture's real youtube survives the whole pipeline).
4. **Dual layouts** (e.g. `tahiri/Paper/`): layout enforcement must reject a *stray secondary*
   `myst.yml`, not just a missing top-level one. (Done: `checkLayout` in `oak validate`.)
5. **HTML needs the current-site pointer** ([R59], live run): `loadConfig` fills the store's
   `sites` map but not `currentSitePath`, so `build` skipped HTML. `myst.ts` calls
   `findCurrentProjectAndLoad`/`findCurrentSiteAndLoad` before `build`. Offline canaries use
   `--exports-only` since HTML needs a network theme zip ([R60]).
6. **Instance brand needs a resolvable favicon + absolute asset paths** ([R61]/[R62], live run): a
   missing site favicon is a *fatal* prerender error; relative `./logo.svg` doesn't resolve through
   `extends` (resolved vs the paper, not the brand dir). **Fixed** ([R68]): `compose()` absolutizes
   instance-relative brand assets, and `oak validate` warns on an absent/unresolvable favicon or
   watermark. (A URL is fine for HTML but not typst, which cannot fetch.)
