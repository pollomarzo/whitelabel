# Handoff — the engine `dist`/release delivery story (RESOLVED 2026-07-11 → [R57])

> **RESOLVED.** Decision: **a runnable engine ⟺ a release.** The release process commits the
> built `dist/cli.cjs` onto the tag's leaf commit; CI runs *released tags only* (floating-branch-
> in-CI is deliberately dropped — constraint 4 relaxed to local-only); `oak build` is the local
> working-tree inner loop; **testing = cut a `vX.Y.Z-dev.N` pre-release** (accumulate + prune).
> Full rationale in `../implementation.md` **[R57]**; dev process in `RELEASING.md`. The problem
> statement below is kept for provenance.

---

**Purpose.** Frame *one* decision for a separate investigation. This document deliberately
states **only the problem, constraints, and open questions** — it proposes **no** solutions.
The investigating agent should generate and evaluate options against the constraints below.

---

## The decision to make

**How does a runnable engine bundle (`dist/cli.cjs`, plus the pinned typst binary) come to
exist at every engine ref that CI checks out — the floating default branch *and* release
tags — without violating the constraints below?**

---

## Why this problem exists (the hard requirement)

The paper-repo shim runs the engine by *checkout*, not install ([R51], design §0/§12):

```
composite action:  actions/checkout  ENGINE_REPO @ <ref>  → ./.engine
                    .engine/ci/run.sh <verb>
run.sh:            exec node "$engine/dist/cli.cjs" "$@"      # no npm install, no network
```

So whatever ref a paper pins in `project.options.oaktree-sapling.version` must resolve to a
checkout that **already contains a runnable `dist/cli.cjs`**. The ref is floating and spans
two classes:

- **a branch** — interim dogfooding pins `version: main` ([R56]); [R41] permits the engine
  default branch as a trusted floating ref.
- **a tag** — `vX.Y.Z` once releases are cut.

A plain `git checkout` of a **branch** carries only *committed* files. GitHub **Release
assets** attach to a release/tag, **not** to an arbitrary branch checkout — so a mechanism
that serves tags does not automatically serve the floating branch ref, and vice-versa.

---

## Current state (facts, not choices)

- `dist/` is **gitignored** in the working tree (`whitelabel/engine/.gitignore`).
- Bundle command: `esbuild src/cli.ts --bundle --platform=node --format=cjs --outfile=dist/cli.cjs`,
  currently **~12.5 MB** CJS (settled: esbuild→CJS, programmatic myst — [R51]; this decision
  is about *delivery/placement*, not how to bundle).
- Local build today: `npm run bundle` then `node dist/cli.cjs …` (see `scripts/build-fixture.mjs`).
- `ci/run.sh` also expects an **optional** engine-shipped typst binary at `.engine/bin/typst`
  ([R34]) — so the typst static binary is a *second* artifact-at-ref, same problem class.
- Artifacts in scope: **`dist/cli.cjs`** (mandatory), the **typst binary** ([R34]), and a
  **`node_modules` tarball** documented only as a fallback ([R51]).
- Interim engine home: `pollomarzo/oaktree-sapling` (personal account); moves to canonical
  `open-scholar-nexus/oaktree-sapling` later via replayed commits — **release assets do NOT
  replay** with git ([R56]).

---

## Hard constraints (a solution MUST satisfy all)

1. **No forced pull-after-push (user's explicit ask).** Pushing to `main` must never require
   the developer to `git pull` afterward because an automated job (CI/bot) added a commit on
   top of what they just pushed. The classic "CI commits build output back to the working
   branch" antipattern is disqualified on this ground alone.
2. **Strong local–CI coupling.** The engine bundle CI runs and the one local `oak build` runs
   must be the **same version/bytes** — no drift where local and CI silently diverge. This is
   the "one build, three edges swapped" invariant (design §12a, [R38]).
3. **No `npm install` / no network on the CI build hot path** ([R51], [R34], dec. 18): the
   checked-out engine must be immediately runnable.
4. **The floating branch ref must be runnable**, not only tags (see the "why" section) — this
   is the crux the tag-only mechanisms miss.
5. **Reproducibility rests on Zenodo, not the engine tag** ([R56]); interim tags are ephemeral,
   so the mechanism must tolerate throwaway/re-cut releases and the eventual home move.

---

## The core tension (why it's not obvious)

Putting the ~12.5 MB bundle *in* `main` keeps the floating `version: main` ref runnable and
coupling tight — but grows history with large regenerated binaries and, **if a CI job
produces it, trips constraint 1**. Keeping it *out* of `main` keeps history clean — but leaves
a branch checkout with **no runnable bundle** (constraint 4), and release assets cover tags
only. Size, git hygiene, the floating-branch requirement, and the no-auto-commit rule all pull
against each other.

---

## Questions the investigation must answer (neutral — do not pre-answer here)

- Where does a runnable bundle live for **(a)** the floating default-branch ref and **(b)** tag
  refs? Same mechanism or two?
- **Who** builds the bundle and **when**, and does that path ever create a commit on a branch
  the developer pushes to (constraint 1)?
- How is **local == CI** version/byte equality *guaranteed* (constraint 2), not just hoped?
- How is the **~12 MB (+ typst binary)** handled re: repo/history growth, clone time, and the
  home move where assets don't replay ([R56])?
- Does the answer **differ for interim** (personal repo, `version: main`) vs **canonical** (tags)?
- How does it interact with **[R41] ref-trust** (forks may pin only tags / the default branch),
  the **copier/upgrade** path, and the paper author's zero-setup expectation?
- What is the **developer loop**: after editing `src/`, what does the user run before pushing —
  and does it stay one step?

## Explicitly out of scope

- Re-opening *how* to bundle (esbuild→CJS is settled, [R51]) — this is about **delivery**.
- Re-opening [R34]/[R56]/§12a decisions — work **within** them.
- The stubbed CLI verbs (slices 2-shim/3) — orthogonal.

## Success criterion

A single delivery mechanism (or an explicitly-justified split between branch and tag refs) that
satisfies **all five** hard constraints, with the **developer loop** and the **exact git
hygiene** spelled out, and the **interim → canonical** migration addressed.

## Pointers (read these first)

- `whitelabel/engine/.gitignore`, `whitelabel/engine/package.json` (the `bundle` script),
  `whitelabel/engine/ci/run.sh`, `whitelabel/engine/copier-template/.github/actions/engine/action.yml`
- `whitelabel/implementation.md` — review notes **[R51], [R34], [R56], [R38]**; §0, §12a
- `whitelabel/interim-fixtures/PROVISIONING.md` §1 (states this as the push prerequisite)
