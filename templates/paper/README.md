# The paper-repo template (frozen shim + starter content)

This is what `oak bootstrap paper` stamps a paper repo with (design §1, [R2]). The `.github/`
set is **frozen and generic** — never edited after creation, CODEOWNERS-gated — because all
*logic* lives in the engine behind `project.options.oaktree-sapling.version`, improvable by a
one-line version bump instead of a scaffold round across N repos ([R17]). Alongside it sits a
minimal starter `myst.yml`/`index.md`/`bib.bib` the author replaces. The journal scaffold is a
*separate* template — `templates/instance/`, stamped by `oak bootstrap journal`.

| File | Role |
|---|---|
| `.github/actions/engine/action.yml` | the ONE place logic touches: resolve ref → checkout ENGINE@ref → dispatch a verb (§1a) |
| `.github/actions/engine/pins.yml` | the trust boundary: `engine_repo` + `instance_repo`; only the *ref* floats (dec. 21, [R37]) |
| `.github/workflows/ci.yml` | Stage 1 build (no secrets, fork-safe) + Pages deploy on push ([R13]) |
| `.github/workflows/check.yml` / `check-post.yml` | two-stage journal checks: untrusted compute → base-context post (slice 4b) |
| `.github/workflows/preview-deploy.yml` | Stage 2 preview deploy in base context (workflow_run) + new-version reminder ([R16]) |
| `.github/workflows/prepare.yml` | editor dispatches DOI reservation ([R4], [R29]) |
| `.github/workflows/publish.yml` | tag push populates the Zenodo draft ([R24]) |
| `.github/workflows/version-bump.yml` | scheduled logic-ref bump: `oak upgrade --version-only` opens the one-line PR (§6b, dec. 17) |
| `CODEOWNERS` | gates `.github/` + itself to the editors |
| `myst.yml` / `index.md` / `bib.bib` | starter paper content (the author replaces the placeholders) |

`uses: ./.github/actions/engine` is a static *local* path, so no version literal is
reintroduced (§6a). The four workflows keep only what GitHub forces to be static —
triggers, permissions, concurrency, artifact plumbing; every step of logic (DOI-PR
opening, failure issues, sticky comments, token selection, preview-provider fallback)
lives in the engine CLI.

## What `oak bootstrap` renders (slice 5)

**No scaffolding tool, no stored template marker.** `oak bootstrap`/`oak upgrade` are
hand-rolled TypeScript over the `yaml` Document API — no Copier/cruft, no Python, no
`.copier-answers.yml`. Only three files are *rendered* per tenant; every other file is
byte-copied verbatim:

- `.github/actions/engine/pins.yml` → `engine_repo`, `instance_repo` (`.` when co-located, repo=journal)
- `CODEOWNERS` → the editors team/user (`@user` on a personal account, `@org/team` on an org)
- `myst.yml` → `project.options.oaktree-sapling.{version,edition}` (the engine coordinate)

## Upgrades = render-and-compare (no 3-way merge)

`oak upgrade` needs no `template_version` marker because the frozen files are fully
reconstructable from the answers already in the repo (`pins.yml` + `CODEOWNERS`). It renders
each frozen file at the target engine tag and **2-way diffs** against the file on disk:

- **`--version-only`** bumps `options.oaktree-sapling.version` in `myst.yml` (data — the
  scheduled `version-bump.yml` workflow's job).
- **`--files-only`** overwrites the drifted frozen files with the target render (reset-to-
  template: any hand-edit is divergence). The PR touches only `/.github/` (+ `/CODEOWNERS`),
  so it lands on the CODEOWNERS gate.
- **`--both`** does both.

Either way the output is a reviewable PR (branch → commit-as-bot → push → `gh pr create`),
never a silent push.
