(design-brief)=
# The design brief

The argument the engine was built from. Like the [decision record](record.md), it is progressively rewritten into the pages around it, or deleted.

Source comments cite these sections as `design §N`, and the decisions in §11 as `dec. N`.

`ENGINE` is the `oaktree-sapling` repository, `INSTANCE-CONFIG` a journal's identity repository, and `PAPER` one paper's repository. §2 defines them.

---

(design-1)=
## 1. Vision & the core problem

We have a working zero-cost, journal-like environment built on MyST + GitHub Pages +
PR review + Zenodo DOIs. The goal is to let **anyone replicate it for their own
non-profit with minimal interaction** — a white-label product, not a one-off.

Three guiding principles rank the design: **open** (no proprietary service in the loop, hackable/forkable),
**free** (zero hosting cost, so neither a central server *we* operate nor a recurring cost for users), and **easy** (onboarding as light as forking a template; ideally a short form that ends in a customizing PR). They're in
tension — "easy" must never quietly cost a server, or it stops being "free" — and §14 works
that out.

Two problems block that today:

1. **No post-creation updates.** Every instance is a *copy*, and the platform version
   is smeared across ~21 hardcoded pins (`uses: …@v0.2.0` in 7 workflow files, `extends:`
   URLs, asset URLs). Updating means editing many files — several CODEOWNERS-gated — in N
   repos. So once a journal exists, there's no way to push improvements to it.

2. **Platform and instance data are conflated.** A shared actions repository mixes reusable
   workflows with one journal's edition data, and the website repository mixes the gallery
   plugin's *code* with that journal's brand. Neither can be shared as-is.

The fix is a clean **platform / instance split**, everything instance-side referenced
**by version** instead of copied, with the single version coordinate carried in the paper's
own `myst.yml` (myst's `options` passthrough) rather than smeared across files.


---

(design-2)=
## 2. The four roles

| Role | Owner | Contains | Lifetime |
|---|---|---|---|
| **ENGINE** (`oaktree-sapling`) | platform (you) | all logic: workflows, base configs, gallery plugin, zenodo script, bootstrap, copier template, typst template (generic parts) | one tagged repo, shared by every journal |
| **INSTANCE-CONFIG** | tenant | edition definitions, brand assets, paper registry — **data only** | always exists; the journal's identity |
| **WEBSITE** | tenant | gallery page + pages/; a *consumer* of INSTANCE-CONFIG + ENGINE | **optional** |
| **PAPER repo** | tenant (authors push) | content + `myst.yml` (`options.oaktree-sapling.version`) + a frozen CI shim | many; thin |

---

(design-3)=
## 3. Current state (where we are)

Recorded the repository layout this design started from: a website repo, a shared actions
repo mixing platform workflows with one journal's edition data, a typst template with a
tenant's branding baked in, and paper repos carrying scattered version pins. Every item is
migrated; §5 says where each went.

---
(design-4)=
## 4. Target topology (platform / instance split)

```
 ═══════════════════ PLATFORM — you own · one tagged repo ═══════════════════
  ┌──────────────────────────────────────────────────────────────────────┐
  │  ENGINE  @vX   — one tagged repo · all platform logic (layout: §12)   │
  └──────────────────────────────────────────────────────────────────────┘
       │ referenced BY NAME (no repo to maintain)        │ extended / ref @vX
       ▼                                                 ▼
   upstream MyST                              ┌─────────────────────────────────┐
    · book-theme        (site theme)          │  INSTANCE-CONFIG   tenant owns  │
    · lapreprint typst  (PDF export)          │   editions/*.yml (venue,funding)│
                                              │   brand/(logo,css)              │
                                              │   registry (papers · DOIs)      │
                                              │   no version manifest (per-repo)│
                                              └─────────────────────────────────┘
 ═════════════════════════ INSTANCE — tenant ════════════════ │ ═══════════════
          ┌────────────────────────────────┐    ┌─────────────┴───────────────┐
          │  WEBSITE   (OPTIONAL)          │    │  PAPER repos  (×N · thin)   │
          │   pages/ + gallery page        │    │   content + myst.yml        │
          │   reads INSTANCE-CONFIG +      │    │   options.oaktree-sapling.version  │
          │   ENGINE plugin/theme          │    │   frozen ci.yml shim → cli  │
          └────────────────────────────────┘    └─────────────────────────────┘
```

Key consequences:

- **The base MyST config lives in INSTANCE-CONFIG, not the website** → the website becomes
  one optional consumer. No site? Papers still build; the journal still has an identity.
- **ENGINE carries zero journal-specific bytes** → it is the thing every journal references.
- **One version coordinate.** Instances only know `options.oaktree-sapling.version`; theme/typst are
  external named deps, so there are no transitive pins to keep aligned.

---

(design-5)=
## 5. What moves where

The migration from that layout to this one, item by item. It is done, and the engine's own
`templates/` tree is now the answer to "where does this live".

---
(design-6)=
## 6. Updates — the manifest mechanism

The version of the platform lives in exactly **one field**, in the paper's own `myst.yml`,
under myst's sanctioned `options` passthrough — an untyped `Record<string,any>` myst stores
verbatim, so **no separate sidecar file is needed**:

```yaml
# myst.yml — the version coordinate rides in myst's options passthrough
project:
  id: author-one-2026-nmap-celegans     # native myst field — also the deposit identity
  options:
    oaktree-sapling:
      version: v0.3.0                       # ← the only knob (yq raw pre-build; loadConfig after)
      edition: micropublications-2026
# engine source URL is pinned in the gated ci.yml shim (§6a), never here
```

**Generalization (n>1).** "In the paper's own `myst.yml`" is the **repo=paper specialization**
of a more general rule: *the version lives in the build-unit's manifest.* When the build unit
is one paper, that manifest **is** the paper's `myst.yml` (above). When one repo holds many
papers (repo=edition/journal, §9), the CI shim checks out **one** engine per build and one
assembled site = one engine, so the version becomes **repo-level** — it moves to the co-located
`journal.yml`. Per-paper `myst.yml` still carries `edition` (papers may span editions, [R195])
but not a divergent `version`. §6's single-field rule is the n=1 slice of this.

(design-6a)=
### 6a. Workflow inversion (dodges the static `uses:` constraint)

GitHub Actions `uses:` for a reusable workflow **must be a literal** — no expressions. So
instead of *calling* a versioned workflow, the paper's workflow is a **frozen shim** that
checks out the engine at the version named in `journal.yml` and runs it:

```
  push / PR on a paper repo
        │
        ▼
  ┌──────────────────────────────────────────────┐
  │ frozen ci.yml  (generic · never edited)       │
  │   1. checkout paper repo                       │
  │   2. ref = options.oaktree-sapling.version (yq on myst.yml)  │
  │   3. checkout ENGINE@$ref → ./engine           │  (actions/checkout is static+generic)
  │   4. ./engine/ci/run.sh                         │
  └──────────────────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────────────────┐
  │ engine/ci/run.sh                              │
  │   · write _engine-extends.yml → ./engine/…     │  (local, version-matched, no network)
  │   · write DERIVED config beside the paper      │  (author's myst.yml read-only, [R204])
  │   · myst build --all --html                    │
  └──────────────────────────────────────────────┘
        │
        ▼  deploy (Pages, or Cloudflare preview on PR)
```

The author's `myst.yml` carries **zero version *pins*** — no scattered `@vX` `extends:` or
asset URLs. The single version coordinate is `project.options.oaktree-sapling.version`,
living in myst's untyped `options` bag (stored verbatim, zero validation warnings —
confirmed against the `mystmd` source). It's **data, not a workflow**, so it isn't
CODEOWNERS-gated and the upgrade bot bumps it in a one-line PR (YAML-aware write, never
`sed`).

**Security boundary.** The shim executes engine code at a ref read from `myst.yml`, so that
value's trust level matters. Pin the engine *source* (org/repo) in the CODEOWNERS-gated
`ci.yml` — so only the **ref** (`options.oaktree-sapling.version`) floats. Validate that
the ref resolves inside the pinned repo — but "inside a *public* repo that accepts PRs"
includes `refs/pull/N/merge` of any **unmerged** PR, i.e. arbitrary contributor code, so the
boundary is *repo + ref-class*, not the repo alone ([R196], [R41]). The floating author path
accepts only refs that are **ancestors of a released tag or on the engine default branch**;
raw SHAs and PR-merge-refs stay allowed for engine-PR dogfooding **only** on same-repo
(non-fork) PRs or a maintainer allowlist. This keeps the one-line bump ergonomic and the
dogfooding path open *and* closes both the "point the engine at my fork" hole and the
"point at anyone's unmerged engine PR" hole. (Blast radius is bounded either way — Stage 1 is
secretless — but running arbitrary *code* in CI is a strictly worse floor than rendering
arbitrary *content*, which fork PRs can already do.) Secrets (e.g. Zenodo token, preview token)
are passed as env vars from the workflow to the engine CLI; the shim controls which secrets
are injected. Never expose the Zenodo draft token to PR-triggered engine execution (deposit
runs post-merge / behind a required-reviewer environment).

**PR previews — the build/deploy split.** Fork PRs get **no** secrets (§8), and the repo=journal
tier is fork-dominated (§9, §14), so the preview deploy cannot live in the `pull_request`
run. The engine splits every preview into two stages, applied **uniformly** to fork and
branch PRs alike — so there is no "green for the maintainer, red for the contributor"
asymmetry a tenant would have to debug:

```
  STAGE 1 · on: pull_request              NO secrets · read-only token
    shim → checkout ENGINE@ref (PR myst.yml, validated above)
         → engine build (untrusted content + repo-pinned ref)
         → upload artifact: _build/html + .pr-number
           └ PR# stashed: workflow_run.pull_requests is EMPTY for forks
    ▼ completes — no deploy, nothing sensitive touched

  STAGE 2 · on: workflow_run[Stage 1] completed   preview token PRESENT
    (workflow file + engine ref taken from BASE default branch)
    download Stage-1 artifact by run-id (github-token)
         → engine deploy → Cloudflare preview + comment .pr-number
           uploads inert artifact only; never rebuilds fork content
```

**Two trust boundaries, composed — not stacked.** `workflow_run` guarantees the *workflow
file* comes from the base default branch; the shim then runs `engine/ci/run.sh` at a ref read
from `myst.yml`. Stage 2 must therefore take its engine ref and deploy logic from the **base
branch's** `myst.yml` (never the PR head's), and do nothing to the artifact but upload the
pre-built static files. Re-running `engine build` on fork content with the token present would
reopen the injection hole through the shim's back door and defeat the split. Stage 1 is
unchanged from the shim above — untrusted ref + untrusted content, zero secrets, inert output.

**Motivation is functional, not security** — contrast the deposit split (§8): the scoped
preview token is low blast-radius, so we don't split to protect it; we split because fork PRs
get *no* token and the preview would otherwise simply fail to run.

`workflow_run` brings three well-known costs, all one-time in the engine: it **activates only
once merged to the engine default branch** (harmless — it ships with the tag); the PR number
must be **stashed in the artifact** because `workflow_run.pull_requests` is empty for forks;
and the cross-run fetch needs **run-id + token** (`actions/download-artifact`), with a
**concurrency** key on the head branch so a new push cancels a stale preview. Because this
lives in ENGINE (§5, §12) and the shim is frozen, every tenant inherits a working fork-PR
preview with zero per-tenant CI wiring — the white-label leverage point.

(design-6b)=
### 6b. Two update cadences

```
  FREQUENT — logic / config                  RARE — repo structure / scaffold
  ┌──────────────────────────────┐           ┌────────────────────────────────┐
  │ ENGINE cuts vY               │           │ ENGINE template changes        │
  │     │                        │           │     │  (file renamed, field added)
  │     ▼ upgrade bot            │           │     ▼ copier update            │
  │ PR: oaktree-sapling.version vX → vY │    │ PR: 3-way merge vs tenant edits│
  │     │ (preview build runs)   │           │     │ (conflicts surfaced)     │
  │     ▼ editor reviews + merges│           │     ▼ editor reviews + merges  │
  └──────────────────────────────┘           └────────────────────────────────┘
   one line · pinned · reproducible            occasional · reviewed merge
```

- **Logic/config** (workflows, base configs, theme/typst versions): bump `options.oaktree-sapling.version`.
  A scheduled upgrade bot opens the PR; the preview build shows the result before merge.
  Pinned → published papers stay reproducible (the tag is recorded at publish time).
- **Structure** (the *shape* of the generated repos): ~~plain cookiecutter would go stale;
  **Copier** (or cruft) tracks the template version in the generated repo and replays
  template changes as a reviewable 3-way-merge PR.~~ **Superseded by [R29]:** no scaffolding
  tool and no stored template marker — `oak upgrade` renders the target from the repo's own
  answers (`pins.yml`+`CODEOWNERS`) and 2-way diffs the frozen files, resyncing the drift as a
  `/.github/`-gated PR. Same "reviewable, pinned, reproducible" property, hand-rolled in TS.

---

(design-7)=
## 7. Externalized dependencies (why ENGINE is a single repo)

- **Theme:** keep the custom `myst-theme` fork for now. Brand color + logo become
  `site.options` / frontmatter supplied by INSTANCE-CONFIG, but the upstream
  color-customization + zip-on-release changes are merged in `main` and haven't been
  released in stock `book-theme` yet. Defer the drop until the next upstream release;
  the fork stays a referenced release-zip asset.
- **Typst:** the template is already parameter-driven (theme color, logo, `summary` part,
  cover page). Only the *default* logo-watermark is tenant-specific; the icons are neutral template assets. The generic template moves into the ENGINE
  repo (`oaktree-sapling/templates/typst/`) and is released as a **zip asset** attached to
  each engine tag. The paper's committed `myst.yml` carries no template URL — `compose()`
  injects the version-matched zip URL at build time. This keeps the template in-repo
  (minimizing splits) while staying version-pinned via the single `options.oaktree-sapling.version`
  coordinate.

**Reproducibility caveat:** by-name = floating. Fine for the living site. For DOI'd PDFs the
anchor is the **Zenodo deposit** (immutable artifact). Template pinning is *not* the
reproducibility anchor.

(design-7a)=
### 7a. Toolchain — everything rides the engine tag (settled 2026-07-08)

The conda environment dissolves after the TS port: `mystmd` becomes a **regular npm
dependency of the engine**, bundled into `dist/cli.js` per tag and invoked
programmatically through `myst-cli`'s exports (no separately-installed CLI — one myst
version, pinned by the engine tag; pinning-by-dependency, not source vendoring).
`pyyaml` served the deposit script (now `zenodo.ts`); `jupyter-book` was redundant;
`tectonic`/`latexmk` are unused (all exports are typst). Platform baseline = **node (on
the runner) + the typst binary** (single static executable, version pinned in the engine).
**micromamba survives only as the opt-in per-paper execution hook**: the shim sets it up
iff the paper ships `paper-environment.yml` (papers that execute code bring their own
scientific stack); no file → no Python anywhere. This closes the conda-vs-uv question —
neither, in the platform path. *Bundling risk (slice-1 spike):* esbuild may choke on
myst-cli's dynamic requires; fallback = committed lockfile + prebuilt `node_modules`
tarball attached to the tag. CLI naming: package `oaktree-sapling`, bin **`oak`**
(author-facing only; CI calls `dist/cli.js` directly).

---

(design-8)=
## 8. Secrets & publishing

The key realization: the CI-resident Zenodo token is **draft-only** (`deposit:write`), and
publishing (`deposit:actions`) is **intentionally human** — the deposit script never holds
the publish capability; an editor clicks Publish / New version in the Zenodo UI.

```
  AUTHOR (push)            EDITOR                    ZENODO  (dedicated
  ────────────            ──────                      per-journal account)
  edit content
  open PR ──────► review / preview   (NO secrets needed for PR builds)
                           │
  CI (deposit:write) ────► create/upload DRAFT, reserve DOI
       if token leaks: vandalize THIS JOURNAL's drafts — recoverable, not public
                           │
                           ▼
                 editor opens draft in Zenodo UI
                 clicks Publish / New version  ◄── needs deposit:actions,
                           │                        which is NEVER in GitHub
                           ▼
                    public DOI minted
```

Token tiers:

| Secret | Scope | Where | Blast radius if leaked |
|---|---|---|---|
| Zenodo draft | `deposit:write` (the floor — no narrower scope exists) | CI, org-inherited or repo-level | this journal's drafts (recoverable) |
| Zenodo publish | `deposit:actions` | **human only**, Zenodo UI | n/a — not in GitHub |
| Cloudflare preview | scoped Pages token | org-inherited or repo-level (public repos) | low (scoped) |

Consequences:

- **No central publisher repo is needed for security.** Because the only dangerous,
  irreversible operation (minting a public DOI) is a human action needing no GitHub secret,
  the GitHub-resident token is low-stakes. Centralize publishing only if you later want it
  for *editorial* workflow reasons.
- **Narrowest available hardening is operational, not scope-level:** give each journal a
  **dedicated Zenodo (bot) account** — a leak then can't reach an editor's other deposits.
  Optionally a Zenodo **community** whose curator-acceptance is a second human gate.
- **Public-from-start** (§11-Q1 settled): review targets are public repos, so the preview
  secret can be inherited at the org level (no per-repo provisioning needed), or set per-repo
  if the tenant prefers. This supersedes the earlier private-during-review model.
  **But org-inheritance buys *provisioning* (set-once / N-repos-inherit), not *availability*:**
  GitHub withholds *all* secrets — repo, org, and environment alike — from any `pull_request`
  run originating from a **fork**, and downgrades `GITHUB_TOKEN` to read-only, no matter how
  the secret is provisioned. So "a PR build holds the preview secret" is true *only* for
  same-repo branch PRs (push-authors); fork PRs get nothing. That is why the preview must be
  deployed from a separate `workflow_run` stage running in base-repo context (§6a). It bites
  the **repo=journal tier hardest**: on a personal account (§9, §14) there is no org, external
  contributors fork by default, and push can't be granted to drive-by contributors — so the
  "easiest" tier is the *most* fork-exposed, not the least. (Distinct from the *deposit*
  two-job split below, which is security-motivated and merely nice-to-have; the *deploy* split
  is **functional and mandatory** — without it fork previews simply do not run.)
- **Tenant self-provisions** their own Zenodo token; the platform never holds it.
- **Privilege split unchanged & correct:** authors are `push` (content + respond to review);
  tags / workflows / secrets / settings stay editor-only.
- The build/deposit two-job split (token absent while building untrusted content) drops from
  *essential* to *nice-to-have*, since a leak now costs drafts, not a publish credential.
- **Org ≠ safer secret — it's DRY provisioning.** In repo=paper the Zenodo token is often
  org-*inherited*, i.e. reachable from every paper repo's CI — exactly as reachable as a
  single repo secret. (It can also be set per-repo; the reachability is the same.) Whoever
  can trigger a token-bearing run can exfiltrate it in either model; one leak = all this
  journal's drafts. The org buys *set-once / N-repos-inherit*, not blast-radius. So
  secret-safety doesn't argue for repo=paper — isolation and build-decoupling do (§9).

---

(design-9)=
## 9. The core invariant: project = paper; the repo is a container

**MyST project = paper. Always.** A MyST project is a single *citable* unit — shared
bibliography namespace, shared cross-reference namespace, project-level frontmatter
resolution, one export/deploy boundary. Two papers in one project can cite each other's refs
and resolve each other's labels, which independent citability forbids. So: **one `myst.yml`
(one AST boundary) per paper.** The only exception is a "publish-the-block" proceedings
*volume* with a single volume DOI — niche; not optimized for.

Consequence: because the project boundary is pinned at "one paper," **"what is a repo" is a
hosting question, not an AST question.** A repo is a *container* of one-or-more independent
paper-projects. The frightening version (papers sharing an AST) was never a real option — so
the granularity choice forecloses nothing, *provided the engine never assumes repo == paper.*

**Granularity ladder** (a tenant knob, not a fixed decision):

| | repo = paper (ISP today) | repo = edition | repo = journal / lab |
|---|---|---|---|
| Org required? | yes | optional | **no** (personal account) |
| Zenodo secret | org-inherited | repo secret | repo secret |
| Pages | N project-sites + hub | one site / edition | one site |
| Gallery | federates by link | site index | site index |
| Per-paper DOI | trivial | map changed dir → paper | map changed dir → paper |
| Author isolation | strong (own repo) | shared repo, per-PR threads | shared repo |
| Build failure | isolated to one paper | couples the edition | couples |
| Fits | many external authors | mid | a lab / small venue |

A **lab without editions is the degenerate case**: repo = journal, one perpetual "edition."
It is the cheapest to provision (no org, one secret, one site), so it's the intended
**ease-onboarding** target — but **build order leads with repo=paper** ([R188]): the existing
papers are all repo=paper, so that is the proven, dogfoodable topology and the port targets it
first; repo=journal is sequenced after.

**Two orthogonal dimensions, not a linear ladder.** The rungs vary along two independent axes:
(1) **instance location** — external (`pins.yml` names `instance_repo`, cloned) vs co-located
(`instanceRoot = "."`); (2) **papers per build-unit** — n=1 (repo=paper) vs n>1
(repo=edition/journal → discovery + `assemble()`, deferred). Every rung is a *combination*; the
pins/instance resolver ([R194]) handles axis 1 uniformly, and axis 2 is the deferred assemble
work. Because `edition` is a **per-paper** coordinate, a co-located n>1 repo can hold **multiple
editions at once** ([R195]) — the fullest form of repo=journal and the natural shape for a
recurring venue; single-edition is just "all papers declare the same edition," not a simpler
code path.

|  | instance | papers/repo | editions/repo |
|---|---|---|---|
| repo=paper | external | 1 | 1 (declared) |
| repo=edition | external or co-located | n | 1 |
| repo=journal (editionless) | co-located | n | 1 (perpetual) |
| repo=journal (multi-edition) | co-located | n | **n** — free (`edition` per-paper) |

**Design for optionality — don't foreclose.** Don't *build* multi-per-repo now; just don't
*bake in* 1-per-repo. Buy these contract shapes now (implement only the n=1 path):

| Don't bake in | Cheap generalization (n=1 today) |
|---|---|
| `myst.yml` at repo root *is* the paper | engine **discovers** paper-projects → a list (length 1) |
| deposit identity = the repo | deposit keyed to a per-paper `id:` |
| registry = list of repos | registry = list of papers `{slug, location:(repo,path), doi}` |
| deploy = push `_build` to Pages root | deploy = **assemble a set** of built projects + index |
| deposit reads org-context secret | deposit reads a plain secret env var |

**Load-bearing rule:** the engine addresses papers **by discovery and per-paper identity,
never by repo position.** For n=1 today, `discoverProjects(root)` returns a list of length
1 (the single `myst.yml` at repo root), `build` produces one output, and `assemble(builds)`
is a **passthrough** (the single `_build/html` is the site). For n>1 the assemble step would
index papers under `/<slug>/` and generate an index page — not built now, but the
indirection is the contract. SciPy runs exactly this in production (`path: papers/*` +
`id-pattern-regex` + `enforce-single-folder`, one `myst.yml` per `papers/<slug>/`) — proof
the granularity stays reachable.

The per-paper `id:` (deposit/registry key) is **myst's native `project.id`**, read via the
loader — every existing paper already has one, so no duplication and no extra field (same as
SciPy). See §12.

The template-as-base clean-diff trick is a repo=paper affordance — keep it, but the engine
must not *depend* on it (a multi-paper PR adding `papers/<slug>/` is already a clean diff).

**Freeze is anchored by Zenodo, not the repo** (corrects an earlier worry): the DOI'd
artifact is immutable at deposit time regardless of repo shape; only live HTML re-renders at
the current `options.oaktree-sapling.version`. So reproducibility is a weaker argument for repo=paper than
isolation and build-decoupling are.

---

(design-10)=
## 10. Lessons from other MyST publishing pipelines

The SciPy proceedings pipeline runs MyST at venue scale and settles two things for us.

- **Three-tier `extends:`** (venue → collection → paper) is the same shape as
  INSTANCE-CONFIG → edition → paper. In a monorepo the chain is relative and local, so no
  version pins are needed and the manifest machinery is simpler there than here.
- It **validates the project=paper container model** and the discovery contract (§9).

What we took from it, ranked by leverage:

1. **A stable `id:` per paper, mandated now.** One line per repo, and it becomes the
   per-paper deposit and registry key that keeps multi-paper repositories reachable.
2. **Author-suppressible checks.** A per-paper escape hatch for a false positive, applied
   in the author's own pull request rather than by mail to an editor.
3. **The editorial flow as label transitions** (`draft` → `approved`), with Actions
   triggered on the label. It maps onto the deposit split in §8.
4. **`{include}` assembly offered, not mandated.** Section files give section-level diffs;
   the cost is more layout surface to normalise, so a single `index.md` stays valid.
5. **JATS and MECA exports**, which mystmd does natively.

Per-paper citability also avoids continuous pagination across a bound volume, and the
build-count-rebuild cycle that goes with it.

---
(design-11)=
## 11. Decisions log

### Settled

(r174)=
- **[R174] Public-from-start.** Review targets are public repos. (§8)

(r175)=
- **[R175] Typst in ENGINE.** Generic template lives in `oaktree-sapling/templates/typst/`, ~~released as zip asset; `compose()` injects version-matched URL~~. **Corrected 2026-07-21 ([R73]): no `typst-template.zip` has ever been cut** — the release ships `dist/cli.cjs` + `bin/typst` only, and `compose()` injects the **absolute local path** to the engine checkout's `templates/typst` (auto-detect always wins). `typstTemplateUrl()` is dead code that would 404; the URL path is a fallback for npm-installed `oak`, decided at npm-packaging time. The *engine owns the template* half of this decision stands. (§5, §7, impl [R73])

(r176)=
- **[R176] Keep `myst-theme` fork.** Upstream color-customization hasn't landed; defer drop. (§5, §7)

(r177)=
- **[R177] Registry upkeep = manual.** Editor adds entry on publish; website is optional. (§5)

(r178)=
- **[R178] Deposit-in-PR deferred.** PRs are build + preview only for now; deposit stays post-merge/tag-triggered (sandbox then prod). Zenodo drafts persist indefinitely (no auto-expiry); `find_by_github` reuses the same draft across pushes. (§13)

(r179)=
- **[R179] Deploy-as-assembly n=1.** `discoverProjects()` → list (len 1), `assemble(builds)` → passthrough for n=1; contract buys multi-per-repo without building it now. (§9)

(r180)=
- **[R180] Ref validation.** Allow tags, SHAs, and PR merge refs within the pinned engine repo; trust boundary is the repo, not the ref type. (§6a)

(r181)=
- **[R181] Engine release safety = mandatory.** ENGINE CI builds a fixture paper + fixture instance-config before any tag is cut. (§12)

(r182)=
- **[R182] ENGINE = `oaktree-sapling`.** At `open-scholar-nexus/oaktree-sapling` (platform org, fresh repo; legacy repo renamed away — impl [R30]) — no default config/papers; showcase instance created separately. (§2)

(r183)=
- **[R183] Three principles: open · free · easy.** "easy" must not cost a central server. (§1, §14)

(r184)=
- **[R184] Engine substrate: TypeScript CLI + JS MyST plugins.** ; bash only for the shim. (§12)

(r185)=
- **[R185] mystmd is the config oracle.** `loadConfig`; no sidecar; `options` passthrough for engine coordinates. (§6, §12)

(r186)=
- **[R186] Always-split PR previews.** Every preview builds (no secrets, `pull_request`) then deploys from a separate `workflow_run` stage in base-repo context; uniform for fork + branch PRs (functional, not security) (§6a, §8)

(r187)=
- **[R187] Toolchain rides the engine tag.** Mystmd = bundled npm dep (programmatic invocation); baseline = node + pinned typst binary; no conda/uv in the platform path; micromamba = opt-in per-paper execution hook; bin name `oak`. (§7a)

(r188)=
- **[R188] Build order leads with repo=paper.** Port and dogfood the proven repo=paper topology on the existing papers first (zero new assemble code); repo=journal (incl. `assemble(n>1)`) is sequenced *after* the port is validated on reality — build order follows the real-paper dogfood corpus, not onboarding ease. A single-paper repo=journal is a near-free by-product of the co-located `instanceRoot` contract ([R192]), and the multi-paper journal shares its index machinery with the gallery (slice 4), so it is un-deferred *onto* slice 4, not built from scratch. (§9, §14)

(r189)=
- **[R189] INSTANCE-CONFIG is public.** Stage-1 fork builds clone it tokenless (no secret in `pull_request`), so a private instance repo would break fork previews; `bootstrap` enforces public. **Amended 2026-08-31 ([R118]):** `validate` does not and cannot, it is handed an already-cloned `--instance <path>` and never sees a repo; the tokenless clone in `ci/run.sh` is what fails. (ratified 2026-07-09) (§8, §9)

(r190)=
- **[R190] Upgrade path = per-repo bump workflow.** Each paper repo self-bumps `options.oaktree-sapling.version` via a scheduled workflow shipped in the template (Dependabot-style; zero central credential/custody). A central bot + Copier scaffold-update stay deferred (unfamiliar; slice 5). (ratified 2026-07-09) (§6b, §14)

(r191)=
- **[R191] Typst binary is an engine release asset.** The pinned static binary is attached to each engine tag (fetched from the engine checkout/release, not from typst's own GitHub releases at build), closing the last live external network dependency on the build hot path. (ratified 2026-07-09) (§7, §7a)

(r192)=
- **[R192] Instance-config resolves by path, not by "clone".** `compose(instanceRoot)` is agnostic to whether `instanceRoot` is a **cloned sibling** (repo=paper: separate shared instance repo, cloned depth-1 in CI, cloned-to-cache or `--instance <path>` locally with the repo hint from `.copier-answers.yml`) or the **repo root itself** (repo=journal: `journal.yml`/`editions/`/`brand/` co-located, zero clone). Every CI-faithful build needs instance-config *materialized* — not just its YAML but its **binary brand assets** (logo, watermark) as real files typst/theme load by path. `--no-instance` yields an explicitly-unbranded quick-build escape hatch. (ratified 2026-07-09) (§9, §12)

(r193)=
- **[R193] id validation is two checks with different locality.** (A) sentinel + id-pattern (id ≠ the template placeholder; matches id-pattern-regex) is a pure function of the paper's own `myst.yml`, hard-fails everywhere with no instance-config — this is the check that actually catches the sentinel-id class; (B) registry-uniqueness needs `registry/papers.yml`, so it hard-fails in CI (fresh registry clone, authoritative) and in any local *build* (instance already present for compose), and soft-warns only in a bare local `oak validate` with no instance. Rides the [R192] resolver. (ratified 2026-07-09) (§10, §12)

(r194)=
- **[R194] Pins live in `.github/actions/engine/pins.yml`.** `engine_repo` + `instance_repo` move out of the composite action's `env:` into a plain gated data file that **both** the CI shim (`yq`) and local `oak` read, so CI and local share one source of truth (no parallel local config can drift). Covered by the existing broad `.github/` CODEOWNERS gate → no new gated path; `instance_repo` is `.`/omitted when instance-config is co-located (repo=journal). Known wart, accepted: local `oak` reading a value out of `.github/` is slightly odd — tolerated because a second config store is worse (it can silently disagree with CI). Refines [R1]/[R17]. (ratified 2026-07-09) (§12, impl §1a)

(r195)=
- **[R195] Multi-edition monorepo is free.** `edition` is a *per-paper* coordinate, so one co-located repo can hold many papers across many editions; compose selects `editions/<edition>.yml` per paper, one engine version per repo, project=paper intact. Not a distinct build effort — rides the deferred n>1 `assemble()` + an index grouped by edition; it is the *fullest* form of repo=journal and the target shape when that tier is built (single-edition = "all papers declare the same edition," not a simpler path). (ratified 2026-07-09) (§9)

(r197)=
- **[R197] `journal.yml` + registry are additive-only.** Instance-config floats ([R194]), but these two *engine-owned* files are read by a *pinned* engine's `schema.ts`/plugins (edition/brand YAML is MyST's compat domain, not ours — `compose()` only wires the `extends:` chain). Keep them additive and have zod ignore unknown keys, so a field rename can't silently break papers still on an older engine. (ratified 2026-07-09) (§3, §12)

(r198)=
- **[R198] Onboarding is honest about the secret floor.** `GITHUB_TOKEN` can't create Actions secrets, so the zero-server template-button surface opens the *branding* PR only; previews (Cloudflare) degrade to artifact links and deposit is deferred until the tenant pastes a token or runs the CLI (PAT = the true full-provision path). A GitHub-authed website that makes the CLI's changes in-browser is the **deferred** device-flow stretch. (ratified 2026-07-09) (§14, §5)

(r199)=
- **[R199] Execution boundary gets a slice-0 fixture.** Papers don't execute code yet but will; a second fixture paper exercises the micromamba↔bundled-node-myst kernel handoff in engine CI from slice 0, so the conda/node seam is a canary, not a contributor's first-PR surprise. (ratified 2026-07-09) (§7a, §12)

(r200)=
- **[R200] The engine repository's name is not a coordinate.** It may be renamed without touching the `options.oaktree-sapling.*` key or the npm package name, which are what tenants pin. (§2)

(r201)=
- **[R201] `compose()` must absolutize instance-relative brand-asset paths.** Relative `./logo.svg` in an extended `brand.yml` resolves against the *paper*, not the brand dir, so it fails to load (real ISP used absolute URLs); [R192]/[R38]'s "brand assets as local files by path" (needed for the typst watermark) requires compose to rewrite them to `<instanceRoot>/brand/…`. Interim fixtures use URLs. (found in live run) (§3 (impl), [R62])

(r202)=
- **[R202] `bootstrap`/`upgrade` substrate = hand-rolled TS + render-and-compare; no scaffolding tool, no stored marker.** Settles the deferred "Copier vs cruft" + "upgrade bot placement" rows. `oak bootstrap paper|journal` and `oak upgrade` are plain TypeScript over the `yaml` Document API (no Copier/cruft, no Python, no `.copier-answers.yml`); the frozen shim's only rendered files are `pins.yml` (engine_repo/instance_repo) + `CODEOWNERS` (owner), and the starter `myst.yml` (engine coordinate) — everything else byte-copied. Upgrade needs **no `template_version` marker**: the frozen files are reconstructable from the repo's own `pins.yml` + `CODEOWNERS`, so it renders the target and does a **2-way** diff (reset-to-template; frozen files are policy-never-edited, so any divergence resets and a hand-edit still shows in the review diff) — not the 3-way merge §6b sketched. Every mutation is a PR (bootstrap seeds/ingests + provisions idempotently; upgrade's resync PR is `/.github/`-gated; the version-only bump is ungated data). Ingest restores the **entire** editor-side `.github/` from `main` (incl. `pins.yml`), not just workflows+CODEOWNERS as the old ISP script did. **Supersedes** the older §14/impl "create must seed `.copier-answers.yml`" and §6b "Copier 3-way-merge update" references. (ratified 2026-07-19) (§6b, §11, §14)

(r203)=
- **[R203] The id gate is merge-time, not build-time.** Layer A splits into `structural` (index.md/myst.yml present, no stray myst.yml) which blocks the build, and `identity` (id present/shape/uniqueness) which does **not**. A placeholder/invalid id no longer stops `oak build`, so a freshly-bootstrapped repo **renders a preview** the author can see; the id stays enforced at **merge** via the failing `Journal checks` Check Run (already reported by `oak validate` — the verdict is unchanged, only the *gate* moved). `oak validate` also stops short-circuiting Layer B on an id error (only structural errors skip it), so the author gets the full fix-list at once. Load-bearing coupling: `oak bootstrap` now wires `"Journal checks"` as a required check on `protect-main` (default-on, `--no-require-checks` opts out) so the relocated gate is actually enforced; solo-admin bypass remains the personal-tier caveat. Refines dec 20 / [R21]. (ratified 2026-07-20) (§10, §12, impl [R21])

(r204)=
- **[R204] The author's `myst.yml` is READ-ONLY; the engine builds from a derived config.** `oak build` currently injects the extends chain + engine override into the paper's own `myst.yml` and never restores it, so locally the author's committed source ends up carrying machine-local absolute paths ("never *committed*" ≠ "never *modified*"; the guarantee was authored on the CI diagram, where the ephemeral checkout makes it complete). Restore-in-`finally` is rejected — myst's HTML build `process.exit(0)`s, so `finally` never runs on the success path ([R67.3]), inverting the failure mode. Instead compose writes a **derived config beside the paper** and the engine passes `new Session({ configFiles: [...] })` (a first-class mystmd option, verified against 1.10.1). Shape: the author's own config is **materialized** into the derived base; `paper-base`/edition/brand **stay as `extends:`** (myst remains the oracle, [R185]) — i.e. the merge model is unchanged, only the write target moves. Deriving by `extends:`-ing the author's file is rejected: it demotes their config from base to a racing sibling, making author-overrides-venue precedence non-deterministic. Turns a procedural guarantee into a structural one. **BUILT 2026-07-21 (PR #5): derived file `myst.oak.yml`, gitignored by the template; author config asserted byte-identical after a build. compose also pins the export `output:` since myst derives it from the config filename.** (ratified + built 2026-07-21; **merged to `main` `c3d0b9b` 2026-07-27**) (§3, §12a, impl [R71])

(r205)=
- **[R205] Extends siblings race; the engine's layers are safe only by key-disjointness.** Myst folds `extends` entries under `Promise.all` with a shared accumulator, so precedence follows *load-completion* order, not declaration order (demonstrated: same array order, winner flips on I/O depth). §10's SciPy-derived "three-tier extends (venue → collection → paper)" therefore oversells what myst provides **between siblings** — today's three layers work only because `paper-base`/edition/brand happen to own disjoint keys. `oak validate` gains a disjointness check; inter-layer override is a recorded limitation. Flattening the chain (which would fix it, and is *not* blocked by [R185] — `fillProjectFrontmatter` is public API) is **rejected for now**: it breaks the path fields myst currently rebases correctly (`bibliography`/`index`/`plugins`/`projects[].path` — `plugins` being exactly why §1a gates the instance repo), reverses [R42]/[R197], and destroys per-key provenance. Named remedies if a tenant ever needs override: flatten, or nest the chain (a chain has no siblings, so no race). **BUILT 2026-07-21 (PR #5): `oak validate` `config`-klass finding, leaf-level for `*.options`, gates merge not build.** (ratified + built 2026-07-21; **merged to `main` `c3d0b9b` 2026-07-27**) (§10, §12, impl [R72])

(r206)=
- **[R206] Export-template ownership: ONE-DECLARER, and the source may be name/path/URL.** Exactly one layer of the extends chain may declare the typst export ([R53] generalized by [R72]: two same-id entries in two *siblings* race and the loser's fields vanish whole). [R53] satisfied that by making the ENGINE the declarer; that is one of two valid resolutions, and **who declares is reopened** now that tenant journals need their own templates — A: engine declares + compose raw-lifts the edition's `template:` (the [R68] precedent, low disruption); B: the **edition** declares the complete entry and compose fills `template:` only when absent (myst-native — the venue-declares-exports shape §10 already cites, and what ISP did pre-port; costs boilerplate + a silent no-PDF if omitted). Source policy is settled regardless: myst's `template:` takes **name. (path | URL** and the engine supports all three (restricting to local paths would re-narrow a myst mechanism); compose absolutizes only *relative* values (URLs/absolute pass through — the `BRAND_ASSET_KEYS` rule, needed because myst does **not** rebase `exports[].template`); the deposit archives the **resolved** `templatePath` whatever its origin (replacing today's accident that it happens to ride inside `engine.zip`); and `oak validate` warns on a **floating** template, not a remote one ([R5] was about unpinned, not about URL-ness). Tenant templates are built ([R76]/[R79]): precedence is `--typst-template` > author > tenant > engine, with `assetOverrides.typstTemplate` a first-class seam. (ratified 2026-07-21) | §5, §7, §10, impl [R74])

### Deferred to later slices / own workstreams

| # | Topic | Deferred to |
|---|---|---|
| — | ~~**Copier vs cruft**~~ — **settled ([R29])**: no scaffolding tool; hand-rolled TS render-and-compare | Slice 5 (built) |
| — | ~~**Upgrade bot placement + scope**~~ — **settled ([R29])**: per-repo scheduled `version-bump.yml` runs `oak upgrade --version-only`; central bot still out of scope | Slice 5 (built) |
| — | **Editorial checks** — settled against the `error_rules` basis this row once recorded: the journal's `checks:` in `journal.yml` selects from a catalog the engine runs, because `error_rules` is author-overridable and so cannot be the journal's contract. | Built |
| — | **Hosted-form feasibility** — device-flow only; out of scope unless stateless | Stretch (§14) |
| — | **INSTANCE-CONFIG final name + year convention** — cosmetic, doesn't block design | User decides at creation time |
| — | **Auto-prepare on approved merge** — replace the prepare `workflow_dispatch` with `oak deposit prepare --if-needed` firing when an `approved`-labeled PR merges to main (trusted push context; same reviewable DOI PR; guard = discovered paper without `project.doi`). Label transition, not raw merge — first merge ≠ acceptance (template-content merges would prepare placeholder metadata). Needs a `journal.yml` default env (checkbox disappears; [R29] rule becomes load-bearing); keep the dispatch as manual/sandbox escape hatch. Rejected alternative: reserve-on-PR-creation — needs the token in Stage 2 reading PR-head metadata, pollutes the account with drafts for abandoned PRs, and the DOI can't be written back to a fork branch | Post-slice-5, with the label-transition workstream |

---

(design-12)=
## 12. Implementation

**Substrate (decided): a TypeScript CLI + JS MyST plugins; bash only for the frozen shim.**
The parts that *must* be JS (the plugins) are already JS, mystmd is node, node is already on
the runner — so one toolchain, one test suite, and one `journal.yml` schema shared across the
CLI, the validator, and author editor tooling. mystmd is a bundled engine dependency invoked
programmatically (§7a) — no shell-out to a separately-installed `myst`; the *logic* leaves bash.



Principles:

- **No structured-doc surgery outside `compose.ts` / a YAML lib.** Never `sed`/`grep` a
  `myst.yml`. Text-editing a structured document is the failure mode this avoids.
- **mystmd is the config oracle; we never model the myst config shape.** Resolve/read myst
  config through myst's own loader (`loadConfig` in `myst-cli`); never hand-merge `myst.yml`
  or re-read it with our own YAML parser. **No separate sidecar exists.** The one engine-owned
  coordinate — `options.oaktree-sapling.version` (+ `.edition`) — rides in myst's sanctioned `options`
  passthrough at `project.options.*` (untyped `Record<string,any>`, stored verbatim, zero
  validation warnings — confirmed in `myst-frontmatter/src/site/validators.ts`). Read it via
  `loadConfig(...).project.options` after the engine is present, and via raw `yq` in the shim
  *before* it is. The engine source URL is pinned in the gated shim (§6a); the per-paper `id:`
  is myst-native (`project.id`). zod validates only our `options` keys, not the myst config.
- **One read from the document — deposit metadata.** Zenodo needs title/authors/reserved DOI;
  take these from myst's *resolved* frontmatter (loader) or a myst-emitted metadata artifact,
  depending at most on myst's field names — never a shape we define. The reserved DOI flows
  *back* into the build via the engine fragment, not by editing `myst.yml`.
- **Schema-first.** `schema.ts` (zod) is the manifest contract; reused by `validate` and
  exported as JSON Schema for author editor autocomplete. (Includes the per-paper `id:` and
  registry shapes from §9.) **`journal.yml` + registry are the only *engine-owned* files a
  floating instance-config serves to a pinned engine (edition/brand YAML is MyST's compat
  domain), so zod parses them additive-only — unknown keys ignored, never rejected — so a
  future field can't break a paper still pinned to an older engine ([R197], [R42]).**
- **Bundle per tag.** `dist/cli.js` is released with each engine tag → reproducible,
  network-free runner step, without a checked-in `node_modules`.
- **Engine PR testing.** The fixture paper (§12 step 0) is the primary test harness. For
  dogfooding against a real paper, the shim allows `options.oaktree-sapling.version` to be a commit SHA or
  PR merge ref (`refs/pull/42/merge`) — all validated to resolve within the pinned engine
  repo. The trust boundary is the repo, not the ref type.
- **One tool, two entry points.** Same CLI runs in CI (`build`/`deposit`) and locally for
  onboarding (`bootstrap`, given a GitHub PAT + Zenodo token) — realizes the "one command"
  north star.


(design-12a)=
### 12a. Local build — the same CLI, three edges swapped

The default author loop needs **no local toolchain**: push → PR → Stage-1 build + Stage-2
preview (§6a) renders faithfully with zero setup — the whole point of a self-contained, pinned
engine build. Local `oak build` is the **power path** (fast iteration) and runs the *same*
`build` code CI runs; only three resolvers differ, all at the edges:

> **A fourth delta used to exist, in *effects* rather than inputs, and it was a bug ([R204],
> [R71]):** `build` injected into the paper's own `myst.yml` and never restored it. CI's ephemeral
> checkout hid it; locally it mutated the author's git working tree. The engine now builds from a
> **derived config** and never writes the author's file, so local and CI differ *only* in the three
> rows below.

| Edge | CI | Local |
|---|---|---|
| engine version | shim reads `options.oaktree-sapling.version` → checkout engine@ref | installed `oak` honors the pin (warn on mismatch, or re-exec `npx oaktree-sapling@<pin>`) |
| instance-config | `run.sh` clones `instance_repo@default-branch` (from `pins.yml`) | reads the **same** `pins.yml`; clone-to-cache (`~/.cache/oak/…`) or co-located root |
| `BASE_URL` | `/<repo>` (Pages subpath) | `""` (served at root) — `compose(env)` already takes this |

Typst binary + theme zip are cached by engine version on first run, then offline ([R191]).
`oak build` one-shots (no engine-run server; you serve `_build/html`). `instanceRoot` resolution
order: `--instance <path>` › a `~/.config/oak` per-repo override (opt-in, for people *editing*
the instance repo) › the committed `pins.yml` (= CI) › co-located `journal.yml` at root ›
`--no-instance` (explicitly unbranded). The normal author does nothing — the committed `pins.yml`
line is the default, so **local can never drift from CI** (single source of truth), at the
accepted cost of local `oak` reading a file under `.github/` ([R194]).

---

(design-13)=
## 13. Dry-run principle & environments

**Constraint: every irreversible / outward-facing action has a test tier that runs the *same
code path* against a disposable target, selected consistently across the pipeline.**

| Action | prod target | test target |
|---|---|---|
| Web deploy | Pages (live) | PR preview (Cloudflare / Pages preview) |
| Zenodo deposit | real account, draft → human Publish | **Zenodo sandbox** (pseudo-DOI, throwaway) |
| *(future outward action)* | … | its sandbox equivalent |

**The crux — separate reversible from irreversible.** The deposit is *already* reversible: it
creates a Zenodo **draft**, and the only irreversible act (human Publish, §8) needs no GitHub
secret. What's hard to rewind is **merge-to-main + tag**.

**Status: PRs are build + preview only for now.** Deposit stays a post-merge / tag-triggered
act (sandbox first, then prod). The full sandbox deposit-on-PR is a future enhancement, not
a blocker — Zenodo drafts persist indefinitely (no auto-expiry), and the existing
`find_by_github()` logic already reuses the same draft across pushes, so there's no risk of
DOI pollution. The engine-bump PR is verified by the fixture-paper build (§12 step 0), not
by a sandbox deposit.

```
  PR  ─►  web preview  (build + preview only; no deposit side-effects)
            │  merge a green PR
            ▼
  main ─►   editor dispatches prepare  →  sandbox concept DOI reserved, myst.yml PR opened
            │  merge the DOI PR
            ▼
  v* tag ─► identical code, --env prod  →  real Zenodo DRAFT (still reversible)
                                           → editor clicks Publish  (the one human gate)
```

Rules:

- **One code path, env-selected.** `test` vs `prod` differ *only* in endpoint + credential
  (`deposit --env`). No logic branches on env, or the dry-run stops testing prod. main/tag is
  a thin trigger that calls the same env-agnostic CLI with `--env prod`.
- **The test tier never mutates a shared, hard-to-rewind ref** (main, tags). That property —
  not deposit reversibility — is what makes a test trivially revertible.
- **PR builds hold no secrets; the preview token lives in the separate `workflow_run` deploy
  stage** (§6a). The production draft token never appears in any PR-triggered run; engine
  source stays pinned (§6a) so the ref can't redirect the build to exfiltrate a token.
- **Deposit is idempotent, keyed by the per-paper `id:` (§9), scoped by env.** Re-running
  prepare find-or-updates the *same* draft via `find_by_github()`.

---

(design-14)=
## 14. Onboarding surfaces — the "easy" principle

**Irreducible human floor** (no UI removes these; collapse everything *else* to a click + a
short form):

1. a GitHub account (an **org** only for the repo=paper tier);
2. a Zenodo account + token — tenant self-provisions (§8), we never hold it. The biggest
   friction, and it **cannot be automated** (a human act on Zenodo). A form can deep-link +
   *validate* the token, not create it;
3. paste that token once (API-settable after auth).

North-star UX: *zero → live journal with one publish-ready paper, in a click + a short form +
those two human acts.*

**The ladder — one provisioning logic, many thin triggers, none a server we run:**

| Surface | What it is | Server? | Best for |
|---|---|---|---|
| **Template button** (primary) | "Use this template" → thin repo; a one-shot setup Action reads a GitHub **issue-form** (name, brand, edition) and opens a **customizing PR** | none — Actions in *their* repo | repo=journal/single-repo (§9) |
| **CLI** (power path) | `npx engine bootstrap` (wraps Copier + GitHub API) | none — their machine | repo=paper tier (org, secrets, N repos); reproducible |
| **Hosted web form** (stretch) | static page + GitHub **device-flow** auth; token stays in the user's browser, never on us | only if stateless + tokenless | the magical path |

**Recommendation:** template-button + issue-form is the real "easy" surface (no server, no
token custody, output is a reviewable PR). CLI is the power path. The hosted form is a
*stretch* and the one place "free/no-server" is at risk — pursue **only** via device flow
(no backend secret, no token custody), else it quietly violates "free."

**Honest secret floor ([R198], [R43]).** `GITHUB_TOKEN` in a from-template repo **cannot
create Actions secrets** (and only touches environments/branch-protection with widened
permissions), so the zero-server button can open the *branding* PR but cannot finish §5's
provisioning. The button surface therefore ships with previews degraded to artifact links
([R6]) and deposit deferred until the tenant pastes a token; the **CLI (PAT)** is the honest
"one command" full-provision path, and the in-browser GitHub-authed form that would run the
CLI's changes for you is exactly the deferred device-flow stretch above — not a shortcut
around the token step.

Syntheses (why this fits the rest of the design):

- **Version-by-reference is *why* template/fork is safe here.** A copy is normally the
  copy-rot anti-pattern (§1), but our template is *thin* (shim + starter `myst.yml`), all
  substance referenced by `options.oaktree-sapling.version`, updates via the bump + Copier (§6b). Easy-create
  doesn't reintroduce can't-update.
- **Onboarding *produces a PR*, never a silent mutation** — same reviewable-from-start
  principle as authoring.
- **The logic lives once** (engine CLI + Copier); every surface is a thin trigger over it.
- ~~**Create must seed Copier state** (`.copier-answers.yml`) so the §6b update path works
  later.~~ **Superseded by [R29]:** no answers file — the update path reads the repo's own
  `pins.yml` + `CODEOWNERS` and renders-and-compares, so there is no separate state to seed.
- **Two distinct flows:** new *journal* (template/form/CLI) vs new *paper* within a journal
  (`create-submission-target` → engine `bootstrap`, opens the submission PR). Both stay
  one-step.
- **Easy reinforces single-repo** (§9): one repo / one secret / one site = fewest
  human acts; the org/repo=paper tier is inherently more setup.
