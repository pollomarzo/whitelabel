# The frozen shim (paper-repo template)

This is the `.github/` set every paper repo is stamped with (design §1, [R2]). It is
**frozen and generic** — never edited after creation, CODEOWNERS-gated — because all
*logic* lives in the engine behind `project.options.oaktree-sapling.version`, improvable
by a one-line version bump instead of a copier round across N repos ([R17]).

| File | Role |
|---|---|
| `.github/actions/engine/action.yml` | the ONE place logic touches: resolve ref → checkout ENGINE@ref → dispatch a verb (§1a) |
| `.github/actions/engine/pins.yml` | the trust boundary: `engine_repo` + `instance_repo`; only the *ref* floats (dec. 21, [R37]) |
| `.github/workflows/ci.yml` | Stage 1 build (no secrets, fork-safe) + Pages deploy on push ([R13]) |
| `.github/workflows/preview-deploy.yml` | Stage 2 preview deploy in base context (workflow_run) + new-version reminder ([R16]) |
| `.github/workflows/prepare.yml` | editor dispatches DOI reservation ([R4], [R29]) |
| `.github/workflows/publish.yml` | tag push populates the Zenodo draft ([R24]) |
| `CODEOWNERS` | gates `.github/` + itself to the editors |

`uses: ./.github/actions/engine` is a static *local* path, so no version literal is
reintroduced (§6a). The four workflows keep only what GitHub forces to be static —
triggers, permissions, concurrency, artifact plumbing; every step of logic (DOI-PR
opening, failure issues, sticky comments, token selection, preview-provider fallback)
lives in the engine CLI.

## What copier fills (slice 5)

The files are otherwise static; only these vary per tenant, so they become copier
questions written into `.copier-answers.yml` (which seeds the §6b update path):

- `pins.yml` → `engine_repo`, `instance_repo` (`.` when co-located, repo=journal)
- `CODEOWNERS` → the editors team/user

Copier-vs-cruft is still the slice-5 decision (design §11); these files are the frozen
source regardless of the templating tool.

## Spikes to close before a real fixture repo ([R18])

Two GitHub-runner behaviors the composite action leans on, to pin against a live repo:
`if:` + `hashFiles()` inside composite steps, and step-level `env:` on the `uses:` step
propagating into the composite's steps (the token/secret hand-off in Stages 2/prepare/
publish depends on this).
