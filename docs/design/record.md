(design-record)=
# The decision record

The record of LLM-drafted justification behind the decisions in these pages. It is progressively rewritten into the design pages, or deleted. When this page is empty, it gets deleted.

Entries are marked `[R#]` and cited from source comments, so an id keeps resolving wherever its entry currently lives. `design §N` refers to a section of the [design brief](brief.md) published alongside; `design.md` below is that document's name before publication.

---

## 0. Toolchain decisions (settled 2026-07-08)

- **CLI name.** npm package `oaktree-sapling`, bin **`oak`** (`oak build`, `oak deposit
  prepare`). CI never uses the name (`run.sh` → `node dist/cli.js`); it's author-facing
  only. *Registry check (2026-07-08): settled.* Package name `oaktree-sapling` is free.
  The `oak` bin is claimed by an unrelated npm package (Electron kiosk framework, dormant
  since 2022) — accepted: bin names only collide on global co-install (EEXIST, fixable
  with `npx`/`--force`); local installs and `npx oaktree-sapling` resolve by package name
  and are unaffected. Fallback names are moot (`sapling`, `oaks` taken as package names).
- **mystmd is a bundled engine dependency, not a runner install.** The engine already
  imports `loadConfig` from `myst-cli` (design §12); installing a second myst via conda
  would mean two independently-versioned copies (library vs CLI). Instead: mystmd is a
  regular npm dependency, the build is invoked programmatically through `myst-cli`'s
  exports (no shell-out), and the myst version is pinned by the engine tag. Closes [R11];
  pinning-by-dependency, not source vendoring — upstream release train unchanged.
  *Risk (slice-1 spike):* esbuild-bundling myst-cli may choke on dynamic requires/workers;
  fallback = committed lockfile + prebuilt `node_modules` tarball attached to the tag.
- **No conda/uv in the platform path.** Post-port, `environment.yml`'s contents dissolve:
  mystmd → engine bundle, pyyaml → `zenodo.ts`, jupyter-book redundant, tectonic/latexmk
  unused (all exports are typst). Platform baseline = **node (on the runner) + the typst
  binary** (single static executable, version pinned in the engine, fetched by `run.sh`
  or a pinned setup action). `environment.yml` is deleted from the engine.
- **micromamba survives only as the opt-in per-paper execution hook.** Papers that execute
  code during build may ship `paper-environment.yml`; the shim sets up micromamba *only if
  that file exists* (conda-forge suits the scientific stack authors bring). No file → no
  Python anywhere. Revisit uv later only for locked/faster paper envs, same hook.

---

## 1. The frozen shim set (paper repo `.github/`)

The YAML below is the shim as first specified. The shipped files are `templates/paper/.github/`, and they have moved since: actions are pinned by full commit SHA ([R75]) rather than by the mutable tags shown here, and `prepare.yml` takes no `--version` ([R65], [R98]). Read the snippets as the argument, not as something to copy.

design §6a speaks of "a frozen ci.yml" — in practice the shim is **five frozen files**:
one local **composite action** (`.github/actions/engine/action.yml`) that owns the pins and
the resolve-ref → checkout-engine → dispatch dance, plus **four near-declarative workflow
files**, because GitHub events (`workflow_run`, tag push, `workflow_dispatch`) must each
have their own workflow file **[R2]**. All five are generic, stamped by copier, never
edited after creation, and CODEOWNERS-gated.

The workflow files keep only what GitHub forces to be static — triggers, permissions,
concurrency, artifact plumbing. Every step of *logic* (sandbox detection, DOI-PR opening,
failure issues, sticky comments, token selection) lives in the engine CLI behind
`options.oaktree-sapling.version`, so it's improvable by a version bump instead of a copier
round across N repos **[R17]**. `uses: ./.github/actions/engine` is a static *local* path,
so no version literal is reintroduced.

### 1a. `.github/actions/engine/action.yml` — the one place the pins live

The two pins (the trust boundary, per §6a) **[R1]** live in a plain gated data file
**`.github/actions/engine/pins.yml`** (`{engine_repo, instance_repo}`) that this action reads
with `yq` — and that **local `oak` reads too**, so CI and local share one source of truth and no
parallel local config can drift ([R37], design [R194]). Keeping it under `.github/` means the
existing broad CODEOWNERS gate covers it with **no new gated path**; `instance_repo` is `.`
(omitted) when instance-config is co-located (repo=journal). Rationale for gating the pins rather
than putting them in `myst.yml`: edition/brand configs can name MyST plugins (JS executed at
build time), so the instance repo is a code-adjacent source, same trust argument as the engine
source. The *edition name* stays in `options.oaktree-sapling.edition` (data, author-bumpable).

**Considered and rejected pin locations [R17]:** `myst.yml` (author-writable — an author
could redirect token-bearing runs to unreviewed code, and [R9]'s free ref-validation loses
its anchor); `vars.*` (moves the trust boundary into unreviewed, unversioned repo
settings); an action hosted in the engine repo (`uses: org/engine/...@vX` must be a static
literal — reintroduces the scattered-pin problem §6a exists to kill).

```yaml
name: engine
inputs:
  args: { required: true }              # verb + args for run.sh
runs:
  using: composite
  steps:
    - id: ref
      shell: bash
      run: | # quoted key (hyphen) + guard: a missing options block must fail loudly, not as a baffling checkout error [R14]
        ref=$(yq '.project.options["oaktree-sapling"].version // ""' myst.yml)
        if [ -z "$ref" ] || [ "$ref" = "null" ]; then
          echo "::error::project.options.oaktree-sapling.version missing from myst.yml"; exit 1
        fi
        echo "ref=$ref" >> "$GITHUB_OUTPUT"
    - id: pins
      shell: bash
      run: | # pins.yml = single source of truth, read by CI *and* local oak ([R194]) [R37]
        echo "engine=$(yq '.engine_repo' .github/actions/engine/pins.yml)" >> "$GITHUB_OUTPUT"
        echo "instance=$(yq '.instance_repo // "."' .github/actions/engine/pins.yml)" >> "$GITHUB_OUTPUT"
    - uses: actions/checkout@v4         # pinned repository ⇒ ref provably resolves inside ENGINE_REPO [R9]
      with:
        repository: ${{ steps.pins.outputs.engine }}   # ENGINE pin from pins.yml [R30]; only the ref floats
        ref: ${{ steps.ref.outputs.ref }}
        path: .engine
    - uses: mamba-org/setup-micromamba@<sha>          # OPT-IN paper execution env only (§0)
      if: hashFiles('paper-environment.yml') != ''
      with: { environment-file: paper-environment.yml, cache-environment: true }
    - shell: bash
      env:
        INSTANCE_REPO: ${{ steps.pins.outputs.instance }}   # from pins.yml; '.' when co-located (repo=journal)
      run: .engine/ci/run.sh ${{ inputs.args }}
```

Trust note: on `pull_request` the action code runs from the PR merge ref — the same is
already true of the workflow file itself on that event; Stage 1 is secretless by design,
and CODEOWNERS gates what *merges*. On `workflow_run` / `workflow_dispatch` / tag push the
preceding checkout is a trusted ref, so the action code is trusted exactly when secrets
are present. Debuggability: the action and `run.sh` must echo what they resolved (engine
ref, instance repo) at the top of every run — the tenant's first broken build is read
through this indirection.

Two runner behaviors to pin in the slice-2 spike **[R18]**: `if:` + `hashFiles()` inside
composite steps, and step-level `env` on the `uses:` step propagating into the composite's
steps.

### 1b. `ci.yml` — Stage 1: build (PR + push), deploy Pages (push)

```yaml
name: Paper CI
on:
  pull_request:
  push: { branches: [main] }
  workflow_dispatch:

permissions:
  contents: read  # job-level grants below; the untrusted build job never holds pages/id-token [R13]

concurrency:
  group: ${{ github.event_name == 'pull_request' && format('ci-{0}', github.head_ref) || 'ci-main' }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  build: # NO secrets, read-only token — safe for fork PRs
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/engine
        with: { args: build }
      - name: Stash PR number # workflow_run.pull_requests is EMPTY for forks (§6a)
        if: github.event_name == 'pull_request'
        run: echo "${{ github.event.pull_request.number }}" > _build/html/.pr-number
      - uses: actions/upload-artifact@v4
        with: { name: paper-build, path: _build/html, if-no-files-found: error }

  deploy-pages:
    if: github.event_name != 'pull_request'
    needs: build
    permissions: { pages: write, id-token: write } # deploy perms live here, not on build [R13]
    environment: { name: github-pages, url: ${{ steps.d.outputs.page_url }} }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { name: paper-build, path: site }
      - uses: actions/upload-pages-artifact@v3
        with: { path: site }
      - id: d
        uses: actions/deploy-pages@v4
```

Notes:
- **Validation is a phase of `oak build`, not a separate job [R21].** Today's `deploy.yml`
  gates build on `validate-paper.yml`; the shim above has no validate job, so `oak build`
  must run `validate` first (schema + error_rules) and fail fast — otherwise the port
  silently drops PR validation.
- Exports (typst PDF) run inside `run.sh build`; PDF failures fail Stage 1, so a fork PR
  still gets full validation with zero secrets.
- The micromamba hook keys on a paper-owned file (§0), so the shim stays frozen. The
  platform toolchain (mystmd, typst) rides the engine checkout — no runner install to
  version.
- `run.sh build` internally: fetch engine-pinned typst binary → clone `INSTANCE_REPO`
  (public, depth 1, default branch) → `node .engine/dist/cli.js build` (compose + myst
  build invoked programmatically, HTML + exports).

### 1c. `preview-deploy.yml` — Stage 2: deploy preview (workflow_run)

```yaml
name: Preview deploy
on:
  workflow_run: { workflows: ["Paper CI"], types: [completed] }

permissions:
  contents: read
  actions: read        # download cross-run artifact
  pull-requests: write # sticky preview comment + notify reminder [R16]

concurrency:
  # head_branch alone collides across forks (two forks both PRing from `main`
  # would cancel each other's previews) — key on head repo too [R15]
  group: preview-${{ github.event.workflow_run.head_repository.full_name }}-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: true

jobs:
  deploy:
    if: >
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # BASE default branch ⇒ engine ref AND action code from base (§6a trust rule)
      - uses: actions/download-artifact@v4
        with:
          name: paper-build
          path: site
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ github.token }}
      - uses: ./.github/actions/engine # deploys inert artifact — never rebuilds fork content (§6a)
        with: { args: deploy-preview site }
        env:
          GH_TOKEN: ${{ github.token }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

`deploy-preview` reads `.pr-number` from the artifact — and **deletes it before
deploying** [R26], or it ships as a publicly served file on the preview — deploys via
wrangler (node dep, bundled in the engine's `dist/`), and posts the sticky comment via
`gh api`. The Cloudflare project name + preview branch naming (today hardcoded
`impact-scholars` / `paper-<repo>-<pr>`) become `journal.yml` preview fields [R27].
**Preview provider is a journal knob** **[R6]**: if no Cloudflare secrets are present,
`deploy-preview` degrades to commenting a link to the build artifact instead of failing —
the repo=journal tier must work with zero Cloudflare setup.

**The new-version reminder (today's `notify-newversion.yml`) also runs here [R16]**, as a
CLI step inside `deploy-preview` — *not* in Stage 1: its sticky comment + label need
`pull-requests: write`, which fork-PR runs never get. It works today only because ISP
authors are push collaborators; in the fork-dominated lab tier it would fail on every
external PR. Everything it reads (tags on base, base `myst.yml` doi) is base-repo context,
so Stage 2 is also the *correct* trust context. One fewer shim file than today.
Detail [R23]: today's notify reads tags via `git tag --merged origin/main` on a
`fetch-depth: 0` checkout; the Stage-2 checkout above is shallow, so the CLI reads tags
via the GitHub API (`gh api repos/{repo}/tags`) instead of requiring full history.

### 1d. `prepare.yml` — editor dispatches DOI reservation

```yaml
name: Prepare Zenodo deposit
on:
  workflow_dispatch:
    inputs:
      version: { required: true, type: string }
      sandbox: { type: boolean, default: true }
permissions: { contents: write, pull-requests: write }
jobs:
  prepare:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/engine
        with: { args: "deposit prepare --version ${{ inputs.version }} ${{ inputs.sandbox && '--sandbox' || '' }}" }
        env:
          GH_TOKEN: ${{ github.token }}
          ZENODO_TOKEN: ${{ inputs.sandbox && secrets.ZENODO_TOKEN_SANDBOX || secrets.ZENODO_TOKEN }}
```

Outcome unchanged from today: reserve/reuse draft, open the one-file `myst.yml` PR writing
`project.doi` — but the PR is opened by the CLI via `GH_TOKEN` (replacing the peter-evans
action; the write is a YAML round-trip inside the CLI, never sed) **[R3]**. `--env` stays
explicit here because the human is choosing **[R4]**. One behavior change: a **prod**
prepare may replace a committed *sandbox* DOI (the scripted sandbox→prod handoff today's
"refuse if doi set" blocks); same-env re-prepare still refuses, and prod→sandbox is
forbidden **[R29]**.

*Deferred (design §11):* this dispatch is slated to be automated away — `oak deposit
prepare --if-needed` firing when an `approved`-labeled PR merges to main, with this
workflow kept as the manual/sandbox escape hatch. Pure CLI change behind the version
knob; no shim change needed beyond passing the token to the push-gated job.

### 1e. `publish.yml` — tag push populates the draft

```yaml
name: Publish Zenodo deposit
on: { push: { tags: ["v*"] } }
permissions: { contents: write, issues: write }
jobs:
  publish:
    environment: zenodo-publish # required-reviewer gate — provisioned by bootstrap [R10]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 } # git archive + PR discovery need history
      - uses: ./.github/actions/engine
        with: { args: "release --tag ${{ github.ref_name }}" } # build + deposit publish + commit comment / failure issue
        env:
          GH_TOKEN: ${{ github.token }}
          ZENODO_TOKEN: ${{ secrets.ZENODO_TOKEN }}
          ZENODO_TOKEN_SANDBOX: ${{ secrets.ZENODO_TOKEN_SANDBOX }}
```

**The debug bundle moves from a workflow artifact to a GitHub Release asset [R24].**
Today publish-zenodo.yml uploads `_bundle/` via `actions/upload-artifact` (30-day
retention); the CLI can't do that upload (upload-artifact rides a runner-internal token,
not `GITHUB_TOKEN`), and keeping it declarative would add a shim step. Instead `oak
release` attaches the bundle to the tag's GitHub Release via `gh release` — CLI-doable,
durable past 30 days, and it puts the exact deposited bytes next to the tag.

Both tokens are passed; sandbox-vs-prod stays **derived from the committed `project.doi`
prefix**, but the selection moves into the CLI (loader-based read, kills the awk sniff)
**[R4] [R8]** — a tag can never hit the wrong env. Building with the token present is
acceptable: tagged content is post-review, and §8 already downgraded the build/deposit
split to nice-to-have. Failure-issue and commit-comment logic move into the CLI (`gh`),
where a bad message is fixed by a version bump, not a copier round.

---

## 2. Engine CLI surface (maps the 7 current workflows)

| Today (isp-actions-config) | Engine |
|---|---|
| `build-paper.yml` | `oak build` (compose → myst build, invoked programmatically per §0) |
| `build-and-deploy.yml` / `deploy-paper.yml` | shim `deploy-pages` job + `oak deploy-preview` |
| `validate-paper.yml` | `oak validate` (schema.ts + error_rules plugin; replaces grep checks; enforces per-paper `id:` sanity [R12]) |
| `prepare-zenodo.yml` | `oak deposit prepare --version X [--sandbox]` (opens the DOI PR itself) |
| `publish-zenodo.yml` | `oak release --tag vX` (build + `deposit publish`, env from DOI prefix; failure issue + commit comment via `gh`) |
| `notify-newversion.yml` | `oak notify new-version` (step inside Stage-2 `deploy-preview` [R16]) |
| `create-submission-target.sh` | `oak bootstrap paper` |
| *(new)* | `oak bootstrap journal`, `oak upgrade` |

All subcommands are `dist/cli.js` verbs; `ci/run.sh` is a ~5-line dispatcher
(`exec node "$(dirname "$0")/../dist/cli.js" "$@"`).

## 3. `compose()` contract

Inputs: paper root, engine root, **`instanceRoot`** (resolved via `pins.yml` — a cloned sibling,
or the repo root when co-located; [R192]/21, [R37]/[R38]), `options.oaktree-sapling.edition`, env.

1. Read the paper config via `loadConfig` (mystmd oracle; never own YAML parsing of myst.yml).
2. Build the extends chain, all **local paths** (no network at build):
   `engine/paper-base.yml` ← `instance/editions/<edition>.yml` ← `instance/brand/brand.yml`.
3. Inject version-matched asset URLs the committed files never carry:
   - typst export `template:` → engine tag's typst zip asset (kills today's floating git URL **[R5]**)
   - `site.template` → theme zip (fork release for now, per §7)
   - `BASE_URL` from repo name (or `""` for previews)
4. ~~Write the merged fragment to `_build/engine/_composed.yml` and point the build at it via
   working-tree injection (never committed).~~ **Superseded twice:** by [R52] (a trailing
   `_composed.yml` extends entry *races* the edition's same-id export — inject into the own config
   instead), then by **[R71]**: the injection target is a **derived config beside the paper**, read
   via `new Session({ configFiles: [...] })`. The author's `myst.yml` is **read-only** — "never
   committed" was never the same guarantee as "never modified" ([R204]).
5. Pure function of (paper, engine, instance, env) → unit-testable against the fixtures.

Instance-config layout consumed by compose:

```
isp-config/                  # INSTANCE-CONFIG
  journal.yml                # name, url, granularity tier, defaults
                             #   preview: {provider, cf_project_name, branch_pattern} [R27]
                             #   zenodo: {community, description_blurb} [R19]
  editions/*.yml             # today's isp-micropublication-2025.yml etc., minus engine pins
  brand/  logo.svg  brand.yml (colors, footer, nav)  logo-watermark.svg (typst param)
  registry/papers.yml        # [{slug, location: {repo, path}, doi, edition}]  (§9 shape)
```

## 4. Zenodo port notes (`zenodo.ts`)

- Straight port of `zenodo-deposit.py` (prepare/publish/status, `find_by_github`,
  bundle build, related_identifiers).
- **Tenant bytes are baked into the script today [R19]** — `build_metadata` hardcodes the
  description blurb ("created as part of the Neuromatch Impact Scholars Program 2025")
  and `communities: [{identifier: neuromatch}]`. These are exactly the platform/instance
  conflation design §1 exists to kill; they move to `journal.yml` `zenodo:` fields
  (blurb optional, community optional — a fresh tenant has neither).
- **Deposit lookup is capped at 100 records [R20]:** `list_my_depositions` passes
  `size=100` with no pagination, in both the query and the list-everything fallback. Once
  the journal account crosses 100 depositions (each version is a deposition), lookup can
  silently miss → `prepare` creates a **duplicate concept DOI**. The port must paginate
  (or rely on the id-first query of [R7], still paginated).
- **The prepare diff is three fields, not one [R22]:** `cmd_prepare` writes `project.doi`,
  `project.github`, *and* stamps `project.date` if absent — the DOI PR spec in §1d should
  say so. Also: prepare runs without a build, so `abstract_paragraphs()` returns None and
  the draft description lacks the abstract until publish overwrites it — acceptable
  (publish is authoritative), but the port should keep that overwrite guarantee.
- **Bundle contents are an implicit root-glob → replace with a `deposit/` folder [R28]:**
  today `SUPP_PATTERNS` sweeps repo-root `*.csv/png/txt/zip/bib` into the deposit — e.g. a
  stray root `figure.png` (present in one 2026 paper) gets deposited. Replace the glob with
  a convention: files in the paper's **`deposit/` directory upload verbatim** (author-
  controlled, no config, reviewable in the PR like everything else). The engine always
  adds its own four: `paper.pdf`, `source.zip` (git archive — which already contains
  `deposit/` *sources*, fine), `myst.yml`, `publication-provenance.json`; name collisions
  between `deposit/` files and those four are a validate error. Empty/absent folder →
  just the four. Copier template ships the folder with a README explaining it.
- **Identity migration [R7]:** deposits are found today by the `github:` URL in
  `related_identifiers`. Add the myst `project.id` as an additional related identifier
  (or keyword) on every prepare; lookup matches id-first, github-URL fallback. This makes
  the deposit key survive a repo move/merge (the §9 multi-paper contract).
- **Fix the live id collision before lookup goes id-first [R12]:**
  an ISP 2026 paper still carries the template's own
  `id: isp-micropublication-template`. Under id-first lookup, its deposit and any future
  paper that forgets to edit `id:` would resolve to the *same* draft. Fix that paper's id
  (coordinate with its existing deposit), make `oak validate` reject the template's
  sentinel id and any id already present in the registry, and have `bootstrap paper`
  stamp a fresh id.
- Keep: JSON result envelope with `status` field (the workflows' error-reporting contract),
  idempotent draft reuse, `--sandbox` endpoint switch.
- DOI write-back stays a committed `myst.yml` change via a reviewable PR — see [R3].

## 5. Provisioning checklist (`oak bootstrap`) [R10]

What the current setup did by hand and bootstrap must automate (GitHub API):

- create repo from template (copier stamp incl. `.copier-answers.yml`, §14)
- Pages `build_type: workflow`
- `zenodo-publish` environment + required reviewers (editors team/user)
- branch protection on `main` + CODEOWNERS (`.github/`, `CODEOWNERS` itself)
- labels: `editor-action-needed`, `zenodo-publish-failed`
- secrets: `ZENODO_TOKEN`, `ZENODO_TOKEN_SANDBOX` (org-allowlist or repo), optional Cloudflare pair
- **allow GitHub Actions to create + approve PRs** (`actions/permissions/workflow`
  `can_approve_pull_request_reviews: true`) — without it the DOI-PR flow's `gh pr create`
  fails with "GitHub Actions is not permitted to create or approve pull requests", even with
  the job's `pull-requests: write` (a separate hard gate). Found live, [R67].
- author collaborator invite at `push`
- (repo=paper tier) approve first fork workflow runs remains manual — document it

## 6. Slices → acceptance criteria

0. **Fixtures.** `test/fixture-paper/` + `test/fixture-instance/`. CI job builds fixture
   through the real shim path (`act` or a workflow in the engine repo); tags blocked on it.
   Because prepare/publish logic now lives behind the version knob too (§1), the fixture
   must also exercise the deposit verbs against the Zenodo sandbox, not just `build`.
   *Done when: an engine PR that breaks the fixture build or a sandbox deposit cannot be
   tagged.*
1. **schema + compose.** zod schema for `options.oaktree-sapling.*` + `journal.yml` +
   registry; compose unit tests over fixtures (edition/brand/typst-URL injection). Includes
   the **bundling spike** (§0): esbuild-bundle myst-cli + engine into `dist/cli.js` and
   build the fixture with it; if it fails, fall back to lockfile + node_modules tarball.
   *Done when: composed config for fixture-paper is snapshot-stable, the bundled CLI builds
   the fixture, and the bundling approach is decided.*
2. **`oak build` through the shim.** The five shim files land in the copier template;
   fixture-paper repo (real GitHub repo) builds + Pages-deploys + fork-PR previews via the
   workflow_run split. Includes the **composite-action spikes** [R18]: `if:`/`hashFiles()`
   in composite steps, step-level `env` propagation. *Done when: a fork PR against the
   fixture repo gets a preview comment with no secrets in Stage 1.*
3. **`zenodo.ts` + deploy.** Sandbox end-to-end on the fixture: dispatch prepare →
   DOI PR → tag → draft populated. *Done when: sandbox record shows PDF + metadata parity
   with a `zenodo-deposit.py` run on the same input.*
4. **Plugins.** `gallery.mjs` port reading `registry/papers.yml`; `validate.mjs` carrying
   the tidy-isp-submission audit rules as `error_rules` + the id-sanity checks [R12].
   The current plugin hardcodes the org (`GITHUB_RAW_BASE`/`GITHUB_PAGES_BASE` constants)
   and derives every URL from it — the port derives thumbnail/site URLs from registry
   entries (`location`), never from an org constant.
   *Done when: website fixture renders the gallery from the fixture registry.*
5. **bootstrap + upgrade. — BUILT (slice 5, 2026-07-19; local-green).** `oak bootstrap
   paper` (bare + `--from` ingest) / `oak bootstrap journal` (`--external` + `--co-located`)
   and `oak upgrade` (render-and-compare: `--version-only`/`--files-only`/`--both`) are
   implemented over the `bootstrap.ts`/`upgrade.ts` modules + idempotent `gh.ts` provisioning
   seams; the scheduled `version-bump.yml` ships in the frozen template. Substrate is
   hand-rolled TS, no scaffolding tool, no stored marker ([R29]). *Remaining before "done":
   the live-verification loop on `pollomarzo` (cut a `v0.0.0-dev.N`, run the five steps) — the
   remote half. Migration of the real 2026 papers is a **separate workstream** (§6, below),
   out of slice-5 scope.*

**Per-paper env-file naming drift [R25]:** the opt-in hook keys on `paper-environment.yml`,
but real papers ship `environment.yml` (e.g. one 2026 paper) — which the current pipeline
*also* ignores (the reusable workflow's default input is `paper-environment.yml`), so those
files are silently dead in CI today. Migration must rename them (or confirm the paper
doesn't execute code and delete them), and `oak validate` should (a) warn on a stray
`environment.yml`, (b) reject `mystmd`/`typst`/`nodejs` pins inside `paper-environment.yml`
— the platform toolchain rides the engine tag (§0); a second copy in the paper env
reintroduces the floating-toolchain bug [R11].

**Migrate-vs-archive the 12 real 2026 papers: open decision.** Either (a) migrate after
slice 3, one PR each (shim swap + `options` block + drop `extends:` URLs), preview parity
before merge — fix that paper's `id:` first [R12]; or (b) leave them archived on the frozen
v0.2.0 pipeline: they keep rendering via the existing pins, the registry federates them
(its shape doesn't care which pipeline built an entry), but rebuilds are at-your-own-risk
(unpinned mystmd in the old `environment.yml`, floating typst template [R5]) — acceptable
since Zenodo is the reproducibility anchor. If archiving, consider a one-time tag on the
typst template to close [R5] for the frozen tier. Note [R12]'s validate check is needed in
*either* case: that paper's deposit lives in the same Zenodo account new papers will search,
so a sentinel-id paper on the new pipeline can still mis-match it.

---

## Review notes (design.md deltas)

(r1)=
- **[R1] Instance wiring was unspecified** — design.md never said where a paper build finds
  its INSTANCE-CONFIG. Decision here: repo pinned in the gated shim (trust: editions can
  name plugins = code), ref floats on the instance default branch (it's living data),
  edition name in `options`.
(r2)=
- **[R2] "Frozen ci.yml" is five files** — workflow_run/tag/dispatch triggers can't share
  one file; the shim is a *set* (one composite action + four workflows, per [R17]), all
  frozen.
(r3)=
- **[R3] DOI write-back contradiction** — §12 says "via the engine fragment, not by editing
  myst.yml"; §13 and the working prepare flow commit `project.doi` via PR. Keep the PR: the
  DOI must persist in the citable source, the write is YAML-lib round-trip (what §12's rule
  actually bans is sed/grep), and it's reviewable. §12's sentence should be amended.
(r4)=
- **[R4] Env selection split** — explicit `--env` on prepare (human choice), derived from
  DOI prefix on publish (prevents tag/env mismatch). §13's "one code path, env-selected"
  holds; the *selector* differs per verb.
(r5)=
- **[R5] Typst template floats today** — the edition config points at the template repo's
  default branch (unpinned). The zip-per-engine-tag design fixes a live bug, not just
  aesthetics.
(r6)=
- **[R6] Cloudflare is a hidden 4th human-floor item** — §14 counts GitHub + Zenodo only.
  Preview provider must be optional with artifact-link fallback.
(r7)=
- **[R7] Deposit key migration** — today keyed by github URL; per-paper `id` must be
  *written into* deposit metadata to become the key (Zenodo has no arbitrary-key field).
(r8)=
- **[R8] Banned-pattern carryovers** — `awk` DOI sniff (publish-zenodo.yml) and `yq` DOI
  read (notify) are the §12 anti-pattern; they die in the port, don't copy them.
(r9)=
- **[R9] Ref validation is free** — `actions/checkout` with pinned `repository:` already
  guarantees the ref resolves inside that repo (tags, SHAs, `refs/pull/N/merge` alike);
  no extra validation code needed in the shim.
(r10)=
- **[R10] Provisioning surface** — the live setup includes a `zenodo-publish`
  required-reviewer environment, Pages-via-API, labels, CODEOWNERS; none were in design.md's
  bootstrap notes. Now enumerated in §5 above.
(r11)=
- **[R11] mystmd is unpinned** — `environment.yml` says bare `mystmd`, so even a pinned
  engine tag builds with a floating toolchain. *Resolved by §0:* mystmd becomes a bundled
  npm dependency of the engine (pinned per tag); `environment.yml` is deleted and the
  conda-vs-uv question is closed (neither in the platform path; micromamba stays as the
  opt-in per-paper execution hook).
(r12)=
- **[R12] Template-id collision is live** — an ISP 2026 paper kept the
  template's `id: isp-micropublication-template` verbatim (found 2026-07-08; all other
  2026 papers have unique ids). The design keys deposits id-first [R7], so this is a
  correctness bug waiting to fire, and it will recur every time an author skips editing
  `id:`. Fixes: validate rejects the sentinel/duplicate ids, bootstrap stamps a fresh id,
  the colliding id fixed before id-first lookup ships (§4, §6).
(r13)=
- **[R13] Job-scoped permissions** — the original ci.yml sketch granted `pages: write` +
  `id-token: write` workflow-wide, so the untrusted build job held them on branch PRs.
  Workflow default is `contents: read`; deploy perms live on the deploy job only.
(r14)=
- **[R14] yq read hardened** — quoted key form (`["oaktree-sapling"]`; unquoted hyphenated
  keys are yq-version-sensitive) plus an explicit missing-key guard, so a paper without
  the `options` block fails with a clear error instead of a baffling checkout failure.
(r15)=
- **[R15] Stage-2 concurrency across forks** — keying on `head_branch` alone collides when
  two different forks PR from identically-named branches (canceling each other's
  previews); key on head repo + branch.
(r16)=
- **[R16] notify-newversion belongs in Stage 2** — its sticky comment + label need
  `pull-requests: write`, which fork-PR runs never get; folding it into Stage-1 ci.yml
  (the earlier plan) would fail on every external PR in the fork-dominated lab tier. It
  rides `deploy-preview` (base context — also correct trust-wise, since it reads base tags
  + base doi).
(r17)=
- **[R17] Shim shape: local composite action** — the pins + resolve/checkout/dispatch dance
  live once in `.github/actions/engine/action.yml` (static local `uses:`, still
  CODEOWNERS-gated); the four workflows become near-declarative, and step *logic*
  (peter-evans PR, failure issues, comments, token pick) moves into the CLI where a
  version bump fixes it. Rejected pin locations: `myst.yml`, `vars.*`, engine-hosted
  action `@vX` (see §1a).
(r18)=
- **[R18] Composite-behavior spikes** — two GitHub-runner behaviors the shim leans on,
  to pin with the slice-2 fixture: `if:` + `hashFiles()` inside composite steps, and
  step-level `env` on the `uses:` step propagating into composite steps.
(r19)=
- **[R19] Tenant bytes in the deposit script** — `zenodo-deposit.py` hardcodes the ISP
  description blurb and the `neuromatch` Zenodo community; they become optional
  `journal.yml` `zenodo:` fields (§3, §4).
(r20)=
- **[R20] Deposit lookup caps at 100** — `list_my_depositions` never paginates; past 100
  depositions `find_by_github` can miss and prepare mints a duplicate concept DOI. Port
  paginates (§4).
(r21)=
- **[R21] Validate was dropped from the shim** — today's paper `deploy.yml` gates build on
  `validate-paper.yml`; the new ci.yml has no validate job, so validation becomes a
  mandatory first phase of `oak build` (§1b).
(r22)=
- **[R22] Prepare's real diff is doi + github + date** — and prepare-time drafts lack the
  abstract (no build artifact); publish's metadata overwrite is the guarantee to keep (§4).
(r23)=
- **[R23] Stage-2 notify can't use git history** — the tag check moves from
  `git tag --merged` (needs fetch-depth 0) to a GitHub API read in the CLI (§1c).
(r24)=
- **[R24] Bundle artifact → Release asset** — `actions/upload-artifact` is unavailable to
  the CLI (runner-internal token) and expires in 30 days; `oak release` attaches the
  bundle to the tag's GitHub Release instead (§1e).
(r25)=
- **[R25] Paper env-file naming drift** — real papers ship `environment.yml`, which the
  current default input already ignores (silently dead in CI); migration renames, and
  validate rejects platform-toolchain pins in `paper-environment.yml` (§6).
(r26)=
- **[R26] `.pr-number` would deploy publicly** — deploy-preview strips it from the
  artifact before the wrangler push (§1c).
(r27)=
- **[R27] Preview naming is instance data** — Cloudflare project name + preview branch
  pattern (hardcoded today) move to `journal.yml` `preview:` (§1c, §3).
(r28)=
- **[R28] Deposit supplements: `deposit/` folder replaces the root glob** — files under
  the paper's `deposit/` upload verbatim alongside the engine's four fixed files
  (`paper.pdf`, `source.zip`, `myst.yml`, provenance); collisions are a validate error;
  today's implicit `*.csv/png/txt/zip/bib` root sweep dies in the port (§4).
(r29)=
- **[R29] Sandbox→prod transition is unspecified** — today `prepare` refuses whenever
  `project.doi` is set, *regardless of env*, and publish routes by DOI prefix [R4]. So
  after a sandbox rehearsal (sandbox DOI merged into `myst.yml`), there is no scripted
  path to production: it takes a hand-edit removing the sandbox DOI. design §13's
  diagram ("v* tag → identical code, --env prod") glosses over this — the tag *follows*
  the committed prefix; it can't flip env. Rule for the port: `oak deposit prepare`
  refuses only a *same-env* re-prepare; a **prod prepare may replace a committed sandbox
  DOI**, opening the normal reviewable DOI PR that swaps it (and vice versa is forbidden —
  never downgrade a prod DOI). The sandbox rehearsal then ends with one extra
  prepare-dispatch, not a manual YAML edit (§1d, design §13).
(r30)=
- **[R30] Engine canonical home: `open-scholar-nexus/oaktree-sapling`** — the platform
  org, not the tenant's (`impact-scholars` is one journal; pinning the engine there would
  repeat the platform/instance conflation at the org level, baked into every tenant's
  shim). Prerequisite: the *existing* repo at that name is the legacy monorepo (journal
  bytes in history, a `v0.1.0` tag that would collide with engine version pins, a live
  old-preview Pages site). Rename it away (`oaktree-sapling-2025-site`; git/web redirect,
  Pages URL breaks — check links first), then create the engine as a **fresh repo** under
  the freed name, deliberately severing the redirect (§1a, design §2).

---

## Ratified deltas (2026-07-09)

(r31)=
- **[R31] Build order leads with repo=paper.** A single-paper repo=journal defers the
  load-bearing part (`assemble(n>1)`), and **all 21 real papers are repo=paper** — so the
  proven port is what gets built and dogfooded first. Resolution (design decision 15):
  **port + dogfood repo=paper first** on the real papers (slices 1-4, zero new assemble
  code); sequence repo=journal after. `assemble(n>1)` shares its index machinery with the
  gallery, so when repo=journal *is* built it rides slice 4 rather than being a from-scratch
  slice.
(r32)=
- **[R32] INSTANCE-CONFIG must be public.** Stage-1 fork-PR builds hold no secrets (§1b) and
  clone `INSTANCE_REPO` with a plain tokenless `git clone`; a private instance repo silently
  breaks fork previews. It is brand + data, so public is fine — `oak validate` warns and
  `oak bootstrap` enforces public visibility (design decision 16).
(r33)=
- **[R33] Upgrade = per-repo bump workflow, not a central bot.** A central cron in
  instance-config iterating the registry needs a cross-repo write token (PAT/App) — the
  credential custody the platform principles minimize. Ship a Dependabot-style scheduled
  workflow *in the copier template* so each paper self-bumps `options.oaktree-sapling.version`
  (N crons, zero central credential). Copier scaffold-update + optional central bot stay
  deferred to slice 5 (design decision 17).
(r34)=
- **[R34] Typst binary ships as an engine release asset.** `run.sh build` must **not** fetch
  typst from its own GitHub releases each run (rate limits; a yanked release 404s the whole
  pipeline). Attach the pinned static binary to each engine tag next to `dist/cli.js`, or
  `actions/cache` it by version — closing the last live network dependency on the build hot
  path (design decision 18, §1b amended).
(r35)=
- **[R35] Zenodo port hardening (three items beyond [R20]/[R23]):**
  1. **Paginate all three lookup call sites.** [R20] named `find_by_github`'s two `size=100`
     calls; `latest_version_dep_id` (`zenodo-deposit.py:378`) has the same unpaginated cap —
     paginate it too, or lookup can miss past 100 depositions and mint a duplicate concept DOI.
  2. **`discover_review_pr` must use `gh api`, not a log-subject regex.** Today it greps the
     last 20 commit subjects for `#\d+` (`:334`) — any stray `#123` misattributes the review
     PR, and this value is *deposited into provenance*. Read the PR associated with the tagged
     commit via the API (same move [R23] makes for tags).
  3. **Split `oak validate` into pre-flight + in-build.** `error_rules` fire *during* the myst
     parse, not before it. Run schema.ts + id-sanity/registry-collision as a fast pre-flight
     (fails a bad `version`/`id` in seconds without a full typst render); `error_rules` remain
     in-build. Refines [R21].
(r36)=
- **[R36] Passthrough claim verified in mystmd source (2026-07-09).** `project.options` reaches
  the project via `SiteFrontmatter` (`myst-frontmatter/src/project/types.ts:56`) and the
  validator at `site/validators.ts:162-170` copies each option key's value **verbatim**
  (`output.options[key] = val`, no recursion) — so the nested `oaktree-sapling: {version,
  edition}` map survives `loadConfig` untouched. Two slice-1 guards: (a) a regression test
  asserting the key isn't stripped (a myst bump rides the engine tag, and `:167` rejects
  *reserved* option keys); (b) `compose()` asserts the resolved `options.oaktree-sapling`
  equals the raw `yq`-read value, so a stray `project.options` in an extended edition config
  can't make the shim (raw, pre-extends) and CLI (loader, post-extends) disagree.
(r37)=
- **[R37] Pins move to `.github/actions/engine/pins.yml`.** The `engine_repo`/`instance_repo`
  pins leave the composite action's `env:` for a plain gated data file both the CI shim (`yq`)
  and local `oak` read — one source of truth, so a local build can never point at a different
  instance than CI. Alternatives rejected: an in-repo `oak.yml` / `.oak.yml` (a *second* config
  that can silently disagree with the CI pin — the exact "why is it building for X when Y is
  configured?" trap); a **root** `oak.yml` (adds a new gated path, fragmenting the "just
  CODEOWNERS `.github/`" gate, and reopening [R17] if the entry is forgotten); a first-run prompt
  (non-portable across clones). Keeping it under `.github/` inherits the broad gate for free.
  Accepted wart (user-flagged): local `oak` reading a file out of `.github/` is slightly odd —
  tolerated because every parallel-store alternative is worse. Refines [R1]/[R17]; design [R194].
(r38)=
- **[R38] Local build = the same `build`, three edges swapped.** The default author never builds
  locally (push → PR preview is zero-setup); local `oak build` is the power path and is
  byte-identical to CI except engine-version resolution (installed `oak` honors the pin),
  `instanceRoot` resolution (reads the same `pins.yml`; `--instance` / `~/.config/oak` override
  › `pins.yml` › co-located root › `--no-instance`), and `BASE_URL` (`""` local vs `/<repo>`
  Pages). Typst/theme cached by engine version. Every CI-faithful build needs instance-config
  *materialized* — including **binary brand assets** (logo, watermark) as real files, not just
  the YAML, so it can't be reduced to URL `extends:`. Design §12a.
(r39)=
- **[R39] Version coordinate generalizes to the build-unit manifest.** §6's "version in the
  paper's `myst.yml`" is the **n=1 specialization**. One engine is checked out per build and one
  assembled site = one engine, so for n>1 repos (edition/journal) the version is repo-level and
  lives in the co-located `journal.yml`; per-paper `myst.yml` keeps `edition` but not a divergent
  `version`. Nothing to build for the repo=paper-first slices — flagged so the shim's `yq` read
  location (paper `myst.yml` vs `journal.yml`) is a known branch when those tiers land. Design §6, [R195].
(r40)=
- **[R40] Multi-edition monorepo falls out of per-paper `edition`.** Because
  `options.oaktree-sapling.edition` is a per-paper coordinate, a single co-located repo can hold
  papers spanning many editions with **no new resolution logic** — compose already selects
  `editions/<edition>.yml` per paper. It is the fullest form of repo=journal (target shape when
  that tier is built) and adds only an index grouped by edition (today's `papers.txt` already
  groups by cohort year), riding the deferred n>1 `assemble()`. Design §9, [R195].

---

## Ratified deltas (2026-07-09, round 2)

(r41)=
- **[R41] Engine-ref trust narrowed (refines [R7]/[R9]).** [R9] rested on "`actions/checkout`
  with a pinned `repository:` guarantees the ref resolves inside the engine repo" — true, but
  for a *public* engine that accepts PRs, "inside the repo" includes `refs/pull/N/merge` of any
  **unmerged** PR, i.e. arbitrary contributor code. A fork paper-PR could set
  `options.oaktree-sapling.version: refs/pull/<malicious-engine-pr>/merge` and Stage 1 would run
  it. Blast radius is bounded (Stage 1 is secretless → Actions-minutes abuse + a poisoned
  artifact Stage 2 deploys to a preview subdomain whose *content* the attacker already controls),
  but running arbitrary *code* in CI is a strictly worse floor than rendering arbitrary
  *content*. Rule for the port: the floating author path (`oak validate` + the shim) accepts only
  refs that are **ancestors of a released engine tag or on the engine default branch**; raw SHAs
  and PR-merge-refs are gated to **same-repo (non-fork) PRs or a maintainer allowlist** for
  dogfooding. Ancestry is a cheap CI-side check (`gh api` / `git merge-base --is-ancestor`) in
  `oak validate`. Design [R196].

(r42)=
- **[R42] Instance/engine compat is narrow — `journal.yml` + registry only (trims an
  overreach).** An earlier framing worried the whole floating instance-config could skew against
  a pinned engine. It can't: `editions/*.yml` and `brand.yml` are **MyST config**, wired into the
  `extends:` chain by `compose()` and resolved by MyST — their compat is MyST's domain, keyed by
  the myst version that already rides the engine tag. The only *engine-owned* files a floating
  instance-config serves to a pinned engine are `journal.yml` (zod) and `registry/papers.yml`
  (gallery + registry-uniqueness). Policy is therefore just zod hygiene: **parse those two
  additive-only, ignore unknown keys**, so a future field can't break a paper still on an older
  engine. Plugins named in an edition (§1a) execute against the bundled myst — still a
  myst-plugin-API-vs-myst-version contract (engine-tag-pinned), and tenant-authored either way.
  Design [R197].

(r43)=
- **[R43] Onboarding floor undersold the secret step.** §14 frames template-button + issue-form
  as "click + form + two human acts," but §5's provisioning ([R10]) includes Actions secrets, a
  required-reviewer environment, and branch protection — and `GITHUB_TOKEN` **cannot create
  Actions secrets** (and only touches environments/branch-protection with widened permissions).
  So the zero-server button opens the branding PR but cannot finish provisioning: the human still
  pastes ≥2 secrets, or runs the CLI (PAT). Reconciliation (no code change, doc-honesty): the
  button ships with previews degraded to artifact links ([R6]) and deposit deferred until a token
  is present; the CLI is the honest "one command" full-provision path. The intended
  install-nothing web surface that would make the CLI's changes in-browser is the **deferred**
  device-flow stretch (§14) — it removes the *install*, not the *token*. Design [R198].

(r44)=
- **[R44] Execution boundary needs a slice-0 fixture.** All ten 2026 papers ship
  `environment.yml` (git-tracked, one paper under `Paper/`), but the opt-in hook keys
  on `paper-environment.yml` ([R25]) and no paper executes code yet — so the
  micromamba↔bundled-node-myst path is **dead and untested**. It's on the roadmap (user,
  2026-07-09), and kernel discovery / jupyter-server availability across the conda-vs-node
  boundary is the "builds locally, dies in CI" seam. Add a **second fixture paper** executing one
  trivial cell through the hook to slice-0 CI so the boundary is a canary, not a contributor's
  first-PR surprise. Design [R199].

(r45)=
- **[R45] Subprocess-of-bundled-myst is a co-equal build path, not just a fallback.** §0/[R11]
  plan to invoke myst *programmatically* through `myst-cli` exports; verified the export exists
  (`build()` in `myst-cli/src/build/build.ts`, re-exported from the package index) *and* the
  package ships a bin. So the slice-1 bundling spike should **benchmark both** — programmatic
  `build()` vs subprocessing the bundled myst bin — since esbuild-bundling the full myst-cli
  (plugins, exec, workers, dynamic requires) is the actual risk, and subprocess sidesteps it
  while keeping myst pinned by the engine dependency. `loadConfig` stays programmatic regardless
  (config read, not build). Decide in slice 1 by which bundles cleanly, not by purity. Refines
  §0, [R11].

(r46)=
- **[R46] Two cheap housekeeping guards (approved).** (a) **Preview teardown** — the shim gains
  an `on: pull_request: [closed]` step that deletes the Cloudflare preview branch
  (`paper-<repo>-<pr>`), so previews don't accumulate unbounded. (b) **Registry-resolves +
  layout checks in `oak validate`** — validate (and instance-config's own CI) asserts every
  `registry/papers.yml` entry resolves to a real repo with a DOI (catches manual-registry drift,
  [R177]) [**amended 2026-08-31 ([R118]): the registry-resolves half is NOT an `oak validate`
  check and should not be; it is instance-side, per the parenthesis in this very line**], and
  **hard-enforces the canonical paper layout** (top-level `myst.yml`/`index.md`) —
  not just warns — so a broken layout like the `Paper/` subdir case fails fast instead of
  costing a manual `tidy-isp-submission` pass. Ties to §6 migration + [R25].

---

## Ratified deltas (2026-07-09, round 3 — slice 0/1 build + bundling spike)

Surfaced while grounding the design against the code and building the pure core
(`engine/`, slices 0+1 green: 31 tests, clean `tsc`).

(r47)=
- **[R47] `id`, `slug`, `location` are THREE registry coordinates, not one.** §9's registry
  tuple `{slug, location, doi}` omits `id`, but [R7]/[R12] make **`id`** the deposit dedup key.
  Verified against reality: real ids are `isp-`-prefixed and sometimes *semantic*
  (one paper carries `id: isp-micropublication-decisive-times`), never the repo slug;
  today's gallery conflates all three into the repo *name* (`paper-gallery.mjs:12-13`). The
  target splits them: `id` = deposit/dedup key (myst-native `project.id`), `slug` = `/<slug>/`
  URL + thumbnail path, `location` = `{repo, path}` (survives a repo move/merge, §9). Registry
  entry is `{id, slug, location, doi?, edition}` (implemented in `schema.ts RegistryEntry`).
  Corollary: the sentinel `oak validate` rejects ([R12]) is **instance-defined** — it lives in
  `journal.yml` `id_sentinel`, not a hardcoded engine constant (ISP's is
  `isp-micropublication-template`, the exact string that paper shipped).

(r48)=
- **[R48] The typst `template:` lives in the *edition* config today; compose must own it
  authoritatively.** §3 step 3 says compose "injects asset URLs the committed files never carry"
  — but `isp-micropublication-2025.yml:12` *does* carry one (`…isp-lapreprint-typst.git`, and it
  floats, [R5]), on the same export entry that carries `articles:`. So the compose contract is:
  **compose SETS the typst `template:` to the engine-pinned zip, overriding any edition value,
  while preserving `articles:`** — and migration must strip `template:` from edition configs.
  This raises a MyST-merge-semantics question for slice 2 (does myst merge `exports` by `id` or
  replace the list? — determines whether a fragment carrying only `{id, template}` keeps the
  edition's `articles`); resolve against the mystmd oracle before finalizing compose's IO half.
  (Pure `compose()` already sets template + preserves articles from the resolved export.)

(r49)=
- **[R49] `project.options.youtube` already coexists with `options.oaktree-sapling`.** An ISP 2026 paper
  ships `options.youtube` and `zenodo-deposit.py:162` reads it — live proof [R36]'s passthrough
  survives `loadConfig`, but also a hard constraint: `schema.ts` validates only the
  `oaktree-sapling` subkey (`readEngineOptions`) and `compose()` never emits `project.options`,
  so sibling keys are never clobbered. Guarded by tests; `youtube` is in the fixture paper.

(r50)=
- **[R50] Dual layouts are stray-content, not double-project.** One 2026 paper's `Paper/` subdir has duplicated
  content + a stray `environment.yml` but **no** `myst.yml`, so `discoverProjects` won't return
  length > 1 there. [R46]'s layout enforcement is milder than framed but still needed as: reject a
  *stray secondary* `myst.yml` anywhere under the paper root (would break the n=1 invariant),
  distinct from a *missing top-level* one.

(r51)=
- **[R51] Bundling spike resolved: CJS + programmatic `build()` (no subprocess needed).**
  A bundling spike already proved (2026-07-09) that esbuild bundles `myst-cli` into a
  single **`.cjs`** (`--format=cjs` mandatory; ESM emits `require("node:…")` Node rejects) and
  that `loadConfig`, `build(session, [], {all, html})`, and the typst export all run from the
  ~11MB bundle — no dynamic-require crashes, no worker issues, and it even papers over a live
  `docx`/`myst-to-docx` interop crash on Node 24. So [R45]'s "benchmark both" collapses to a
  decision: **programmatic, bundled to CJS**; the `node_modules` tarball stays a documented
  escape hatch, not the path. API surface: `new Session()` → `loadConfig(session, dir)` →
  `{project, site, extend}`; `build(session, files, opts)`. Untested and gated behind flags when
  enabled: `myst-execute` (Jupyter, ties [R44]), DOCX (the fragile path), JATS/MECA. `run.sh`
  stays `exec node dist/cli.cjs "$@"` — no `npm install` in CI. Refines/closes [R45], §0.

(r52)=
- **[R52] compose injects into the paper's OWN config, not a trailing `_composed.yml`
  extends (corrects design §3 step 4).** Verified against the mystmd oracle: MyST merges
  `exports` **by `id`, whole-entry, `base` wins, with NO field-level merge**
  (`myst-frontmatter/src/utils/fillPageFrontmatter.ts:241-250`). Two consequences that
  break §3's "write the merged fragment to `_composed.yml` and add it as the last extends
  entry":
  1. **No field override by layering.** You cannot "just set `template:`" on a lower layer;
     whichever config wins an export `id` supplies the *complete* entry, so `articles` must
     travel with the engine's typst template. (Resolves the open question in [R48].)
  2. **Extends-vs-extends precedence is non-deterministic.** In `loadConfig` the paper's own
     config is the final `base` (deterministic base-wins), but the extends are folded under
     `Promise.all` (`myst-cli/src/config.ts:207-231`), so a trailing `_composed.yml` would
     *race* the edition's same-id typst export — sometimes winning, sometimes not.

  Corrected mechanism: compose emits `ownOverride` (exports + `site.template`) merged into
  the **working-tree own config**, where base-wins is deterministic; the `extends:` chain
  stays `[paper-base, edition, brand]` with no engine fragment appended. The edge does a
  **two-pass**: (1) write `extends:` → `loadConfig` → read the resolved typst export (now
  carrying the edition's `articles`); (2) write the complete engine typst entry + theme
  `site.template` into the own working-tree config → `build`. Neither write is committed;
  both are YAML round-trips ([R3], never sed). Migration still strips the floating
  `template:` from edition configs ([R48]) so nothing competes at the extends level.
  Design §3 step 4 + §12a should be amended to this. (Pure `compose()` + tests updated;
  the two-pass IO half is the first slice-2 task.)

(r53)=
- **[R53] Export fields cannot be split across configs — the complete typst export lives
  in `paper-base.yml`, editions carry none (found in the slice-2 end-to-end build).** A
  live corollary of [R52]'s by-id/whole-entry/base-wins rule. The ported layout had a
  *skeleton* typst export `{format, id}` in `paper-base.yml` and `articles:` on the
  same id in the edition (mirroring today's `isp-micropublication-2025.yml:9-16`). The
  first real fixture build **dropped `articles`** (PDF fell back to the generic
  `myst.pdf` instead of `index.pdf`): the two same-id entries raced in the extends fold
  and paper-base's article-less entry won whole. Fix: the **complete** canonical export —
  `{format: typst, id: typst-pdf, articles: [{file: index.md, level: 0}]}` (the n=1
  default) — lives wholly in `paper-base.yml`; editions declare **no** `exports:`; compose
  swaps only `template:`. A multi-article paper overrides the whole entry in its own
  myst.yml (own wins by id). This tightens the [R48] migration step: editions drop BOTH
  `template:` and `articles:` (their whole `exports:` block), not just the URL. Verified:
  after the fix the injected entry carries `articles` + the engine template and renders
  `index.pdf`. Design §5 (paper-base contents) + §3 should note the export is engine-owned
  and whole.

(r54)=
- **[R54] `oak` runs only bundled; `dist/cli.cjs` uses `__dirname`, not `import.meta.url`.**
  The esbuild CJS bundle ([R51]) does not polyfill `import.meta.url` (it resolved to
  `undefined` and crashed `engineRoot()` on the first real run). Since CI (`ci/run.sh`) and
  local both invoke `node dist/cli.cjs`, the CLI resolves its own location via CJS
  `__dirname` (the bundle's dir) — no ESM dance. Engine root is found by probing for
  `paper-base.yml` up from the bundle. Noted so a future "run the TS directly" path knows
  it must reintroduce an ESM-safe shim.

(r55)=
- **[R55] The frozen shim set is authored; `run.sh` does CI *materialization*, the bundle
  does *logic* (resolves the §12-vs-§1b tension).** The six-file shim now exists under
  `engine/templates/paper/.github/` (composite `action.yml` + `pins.yml` + `ci.yml` +
  `preview-deploy.yml` + `prepare.yml` + `publish.yml`) plus `CODEOWNERS`, faithful to
  §1a–1e. Design §12 calls `run.sh` "~5 lines"; §1b hands it instance-cloning + typst +
  base_url. Resolution: `run.sh` owns exactly the CI-environment *materialization* that
  needs the runner (typst on PATH from an engine-shipped `bin/` [R34]; instance-config
  `git clone --depth 1` when `INSTANCE_REPO != .`; `BASE_URL` = `''` on `pull_request`
  else `/<repo>`), then `exec node dist/cli.cjs "$@" <resolved flags>`; ALL decision logic
  stays in the bundle (version-bumpable). Two known gaps flagged, not blocking: (a) until
  the myst-theme fork *release* exists, a CI HTML build 404s on `site.template` — a real
  fixture *repo* must pass through `--no-site-template` or the release must be cut first
  (ties the deferred pinned-theme item); (b) `dist/cli.cjs` must be present at the
  checked-out engine ref — the engine release process commits/attaches the bundle so
  `actions/checkout .engine` is immediately runnable ([R51], no `npm install` in CI). The
  [R18] composite-behavior spikes (`if:`/`hashFiles()` in composite steps; step-`env` on a
  `uses:` step reaching composite steps — the Stage-2/prepare/publish secret hand-off) stay
  open until a live fixture repo; they can't be exercised by `act`-less local YAML parsing.

(r56)=
- **[R56] Engine home is interim `pollomarzo/oaktree-sapling` first; canonical move
  deferred (defers [R30]).** The [R30] plan (rename the legacy `open-scholar-nexus/
  oaktree-sapling` away, cut a fresh repo) is disruptive now — it breaks the live
  old-preview Pages site and collides the `v0.1.0` tag. Decision (user, 2026-07-10):
  develop the engine on a personal-account repo `pollomarzo/oaktree-sapling` first, then
  move to canonical `open-scholar-nexus/oaktree-sapling` later by replaying commits onto a
  clean branch and PRing. The architecture makes this cheap by construction — the home is
  named in exactly ONE place (`pins.yml` `engine_repo`; asset URLs derive from it), so the
  move is a one-line owner swap per consuming repo. **Caveat: GitHub Release *assets*
  (`typst-template.zip`, `dist/cli.cjs`, the pinned typst binary) do NOT travel with
  `git cherry-pick`/rebase** — they attach to Releases, not commits — so interim engine
  tags are dev/ephemeral and releases get re-cut on canonical. Safe because Zenodo, not the
  engine tag, is the reproducibility anchor (§7, [R179]): just don't publish a paper whose
  deposit pins an interim tag you'll delete. Interim reflected in defaults: `pins.yml`
  `engine_repo`, `cli.ts` fallback, `CODEOWNERS` (personal repos have no org team → names
  `@pollomarzo` directly, itself a real test of the §9 no-org lab tier). Corrected en route:
  `THEME_REPO` is `impact-scholars/myst-theme` (the only real book-theme release zip, per
  the website's nexus.yml), not the speculative `open-scholar-nexus/myst-theme`.

---

## Ratified deltas (2026-07-11)

(r57)=
- **[R57] Bundle delivery: a runnable engine ⟺ a release. One invariant, no exceptions
  (resolves the delivery-story question).** The paper shim runs the engine by *checkout*, so
  `dist/cli.cjs` must already exist at whatever ref a paper pins. Decision (user, 2026-07-11):
  **the only way a *ref* becomes runnable is a release** — the release process builds the
  bundle and **commits it onto the tag's (leaf) commit** (a committed git object, so it
  **replays on the interim→canonical home move**, unlike a Release *asset* — sidesteps the
  [R56] asset caveat). Consequences, each chosen against five hard constraints:
  1. **No floating-branch-in-CI.** Constraint 4 ("the floating branch ref must be runnable")
     is deliberately **relaxed to local-only**: CI runs *released tags* only. A pin that isn't
     a release fails loud in the shim (`dist/cli.cjs` absent → `::error:: pin a release`), never
     a raw `Cannot find module`. This *dissolves* most of the [R41]/[R196] ref-trust surface —
     branch tips / raw SHAs / `refs/pull/N/merge` simply don't run in CI.
  2. **Two non-overlapping dev paths, nothing between them.** `oak build` = the local
     working-tree inner loop (logic; no ref, no network, not something anything pins).
     `oak release` = the *only* way to make a **ref** runnable, for CI / anyone pinning a
     version. There is no "pin a branch and have it built," no built-ref/force-push infra, no
     download-at-checkout path. (Rejected: commit-to-`main` per-commit — bloats the browsed
     history [user: "feels wrong"]; built refs / rolling assets — standing complexity for a
     rare need; download-at-checkout — reopens the [R34] network-on-hot-path dependency.)
  3. **Constraint 2 (local==CI) is guaranteed by construction**, not hoped: local and CI both
     *consume the same committed released bundle object* — byte-identity by git identity. Local
     only ever *builds* a bundle from your own working tree (`oak build`), where diverging from
     CI is the point.
  4. **Testing = cut a dev release.** To exercise the CI plumbing (the one thing `oak build`
     can't reproduce — composite-action `if:`/`hashFiles`, step-`env` propagation, fork-PR
     preview) you cut `vX.Y.Z-dev.N` pre-releases and pin them. **Dev releases accumulate +
     prune** (not a moving `dev` tag — a tag whose meaning silently changes is worse). This is
     the "release path is the product" bet: every test runs the real release path, so it stays
     healthy instead of being a rarely-run 2am surprise.
  5. **The engine-bundle release is small and distinct from the Zenodo publish path (slice 3).**
     `cut-engine-release` = *build bundle → commit to tag → push tag → GH pre-release* (a
     ~20-line workflow/script), buildable **now**, before the interim [R18] run — so the interim
     bootstrap becomes "cut a dev release," **not** the earlier commit-to-`main` shortcut.
     Decision (user): exercise the path from day one and keep it.
  6. **typst is out of scope of all this** — version-keyed cache/fetch, ref-agnostic, we rely on
     upstream ([R34]); the only artifact this delivery mechanism carries is `dist/cli.cjs`.
  Dev-facing process (cut/prune/pin, accumulate+prune policy) documented in
  `engine/RELEASING.md`. Design §12 "Bundle per tag" + §12a should note delivery = committed-at-tag.

---

## Ratified deltas (2026-07-12 — first live shim run)

Surfaced standing up the interim fixtures on a real GitHub runner (the first-live-run tiers 0–2):
engine pushed to `pollomarzo/whitelabel`, `v0.0.0-dev.3` cut, `pollomarzo/fixture-paper-repo`
(pins it) + public `pollomarzo/fixture-instance-config` provisioned, same-repo **and** fork PRs
run. **[R18] is closed.** The only red left is the documented slice-2/3 verb stubs.

(r58)=
- **[R58] Interim engine home renamed `pollomarzo/oaktree-sapling` → `pollomarzo/whitelabel`
  (refines [R56]).** User choice (2026-07-12). *Repo name only* — one of three independent roles
  of the string "oaktree-sapling": (1) the repo/`engine_repo` pin (changed); (2) the
  `options.oaktree-sapling.*` myst passthrough key (UNCHANGED — the per-paper contract, baked into
  `schema.ts`/`yaml-io.ts`/`compose.ts`/the shim `yq`); (3) the npm package `oaktree-sapling` +
  bin `oak` (unchanged). Swapped in exactly two places (`pins.yml` `engine_repo`, `cli.ts`
  fallback); asset URLs derive from it. Confirms the design's "home is one coordinate" claim.

(r59)=
- **[R59] Site-pointer bug — `oak build` rendered PDF but no HTML (fixed).** Bare
  `loadConfig(session, dir)` fills the store's `sites`/`projects` maps but does **not** set
  `currentSitePath`; `myst build` selects the site via `selectCurrentSiteConfig` → undefined →
  `🌎 No site configuration found.` and it skips HTML (PDF still renders, because exports
  re-resolve). The `myst` CLI sets the pointer via `findCurrentProjectAndLoad` /
  `findCurrentSiteAndLoad` (exported from `myst-cli`); `engine/src/myst.ts` now calls those before
  `build`. Masked until now because the integration test asserted only the PDF. Regression cover:
  the live CI HTML build + Pages deploy (an offline unit test can't build HTML — see [R60]).

(r60)=
- **[R60] HTML needs a network theme → `--exports-only` for the offline canaries.** A site build
  requires a web theme: real CI fetches the `book-theme.zip`; offline, myst's default theme spins a
  local prerender server that **fatally 500s on `/favicon.ico`**. So the two offline canaries (the
  integration test + `scripts/build-fixture.mjs`), which only ever needed the PDF, now pass
  `--exports-only` (typst export, no site — `build(session,[],{typst:true})`). Real CI / normal
  `oak build` are unchanged (full HTML+PDF). The need pre-existed; [R59]'s silent site-skip was
  hiding it.

(r61)=
- **[R61] An unresolved site `favicon` is FATAL.** myst's static prerender retries `/favicon.ico`
  3× and throws (exit 1) when the favicon can't resolve — even though HTML files were already
  written. The fixture brand shipped none; real `nexus.yml` sets `favicon:` for exactly this
  reason. Fix: instance brand must set a resolvable favicon. `oak validate` should warn when a
  `site` config has no resolvable favicon (cheap, prevents a baffling tenant failure).

(r62)=
- **[R62] Relative brand-asset paths don't resolve through `extends` (design gap).**
  `logo: ./logo.svg` in an extended `brand/brand.yml` is resolved by myst against the **paper**
  root, not the brand dir → `unable to resolve file: ./logo.svg`. This is why real `nexus.yml` uses
  absolute **URLs** for logo/favicon. It undercuts [R38]/dec.19's "brand assets as REAL files
  loaded by path" — which typst's watermark/logo *will* need (typst loads by path, can't take a
  URL). Resolution owed: **`compose()` must absolutize instance-relative asset paths** (rewrite
  `./x` under `brand.yml` to `<instanceRoot>/brand/x`) as part of the override pass, so local files
  work through the extends chain. Interim fixture uses URLs to stay green; the typst-watermark port
  can't.

(r63)=
- **[R63] Missing typst binary is NON-FATAL → the interim shim test is HTML-only.** With no typst
  on the runner ([R34] unimplemented), `myst build --all` logs `Error: The typst CLI must be
  installed…` but does **not** throw — `oak build` exits 0 and `_build/html` uploads; only the PDF
  and its download link are absent (a non-fatal `⛔️ Could not find …index.pdf in downloads`). So
  the fork-PR preview/plumbing is fully testable now; a green *PDF* awaits [R34]. (Verified across
  dev.2/dev.3 runs.)

(r64)=
- **[R64] [R18] CLOSED on a live runner + a first-run gotcha.** Both composite-action spikes
  confirmed: (i) `hashFiles('paper-environment.yml')` gates the micromamba step **inside** the
  composite → it skips (no such file); (ii) step-level `env:` on the `uses: ./.github/actions/engine`
  step **reaches** the composite's inner `run.sh` → `GH_TOKEN : present` in the Stage-2
  `deploy-preview` echo (`CLOUDFLARE`/`ZENODO` empty, none provisioned). Stage-1 build is
  secretless and identical for **same-repo and fork PRs** (fork run needs the one-time `[UI]`
  approval, exercised from a 2nd account); Stage-2 `workflow_run` downloads the Stage-1 artifact by
  run-id in base context and reaches `oak deploy-preview`, which exits as the slice-2 stub (the only
  red). **Gotcha [R64a]:** `ci/run.sh` was committed `100644` → `Permission denied` (exit 126) on
  the first run; fixed with the tracked exec bit (`git update-index --chmod=+x`). **Untested
  (noted):** the token-exfiltration/ref-trust path ([R41]) and any real deploy (stub).

(r65)=
- **[R65] Slice 3 DONE — `zenodo.ts` + `gh.ts`, sandbox-verified.** The zenodo-deposit.py port
  landed in the engine repo (`pollomarzo/whitelabel`; two commits). Faithful to §4 with the review
  deltas baked in: paginated `listMyDepositions` behind all three lookup sites ([R20]/[R35.1]);
  id-first identity via a `urn:oaktree-sapling:<id>` related identifier, github-URL fallback ([R7]);
  supplements from the paper's `deposit/` folder with a reserved-name collision guard ([R28]);
  tenant blurb + community read from `journal.yml` ([R19], gone from code); review PR via `gh api`
  ([R35.2]); the [R29] sandbox→prod transition. **Seams:** the Zenodo HTTP transport and the git/gh
  side (`gh.ts`) are injected so the deposit logic is unit-tested with no network/git — and
  `zenodo.ts` does **not** import myst-cli (abstract text is read from the `_build` JSON on disk),
  keeping `myst.ts` the only importer. 14 new unit tests (51 total).
  - **`--version` dropped from `prepare` (decision).** It was `"kept for parity; unused at prepare"`
    in the python; prepare is genuinely version-agnostic (it only reserves the concept DOI — the
    version is the tag, applied at publish). Removed the `required` workflow input and the arg; the
    DOI PR now uses a fixed `zenodo-doi` branch.
  - **Live sandbox run (2026-07-12):** `prepare` reserved concept `10.5072/zenodo.559356`; the
    `urn:` related identifier is **accepted + stored** by Zenodo (the one thing unverifiable offline);
    `publish` populated the draft with the PDF + all bundle files (incl. a `deposit/data.csv`) and
    metadata parity (version from tag, tenant blurb from journal.yml, valid ORCID kept / placeholder
    dropped). **id-first proven** by a simulated repo move: re-prepare under a *different* github URL,
    same `id`, no committed DOI → **reused the same draft** (github-only lookup would have missed and
    minted a duplicate). Pagination is unit-tested only (the account has <100 depositions).
  - **Open loose ends:** the sentinel `id` ([R12]) was still unfixed at the time of this delta —
    **fixed 2026-07-14**, so id-first is now prod-safe (the data
    precondition; `oak validate` enforcement of the sentinel is still owed, slice 4). Was the one
    precondition before id-first ships to *prod*. The `gh.ts` effects (DOI PR / release asset / commit comment / failure
    issue) are wired but only exercised in CI (locally they degrade to a warning + the working-tree
    myst.yml write, which is enough for a sandbox rehearsal). `reviewPr` leaks git's stderr when the
    repo has no `origin` (cosmetic; `review_pr` is correctly `null`).

(r66)=
- **[R66] [R34] RESOLVED — typst rides the engine tag; the deposit is self-contained.** Settled
  2026-07-13. Commit `bin/typst` (linux-x86_64 musl, pinned by a new engine-root `typst.version`
  file) onto the release-tag leaf by the same plumbing as `dist/cli.cjs` — `cut-engine-release.sh`
  fetches it, renders the canary *with the shipped binary* (test-what-you-ship), and force-adds
  `bin/typst` next to `dist/cli.cjs`; `bin/` is gitignored on `main`. `ci/run.sh` is unchanged (its
  `[ -x "$engine/bin/typst" ]` PATH pickup was already waiting). So a checked-out tag renders the
  PDF with no runner install and no hot-path fetch, closing [R63] (HTML-only).
  - **The load-bearing reason is reproducibility of the DOI'd artifact, not the network.** The
    *package deal*: a fifth reserved bundle name `engine.zip` in `zenodo.ts` — a `git archive` of the
    engine at the pinned ref, which at the tag leaf carries `bin/typst` + `dist/cli.cjs` +
    `templates/typst/` — so a reproducer needs only **linux-x86_64 + node + the deposit, nothing
    fetched**. Committing the binary is *necessary but not sufficient*; ship `engine.zip` too or the
    §7 "Zenodo is the reproducibility anchor" claim stays aspirational. `BundleProvenance` gains
    `platform: 'linux-x86_64'` + `typst_version`.
  - **Retires two weak framings this delta log leaned on** (do not re-cite them): (1) "*no network on
    the hot path*" as the reason for commit-at-tag — R51/R57 kill *install* (npm's flakiness +
    byte-level non-reproducibility), not network; the build path already fetches instance-config +
    theme zip. (2) "*replay-on-move*" ([R57]) — the canonical-home move is a one-time re-cut of
    releases, not an ongoing structural property. The surviving reasons to commit-at-tag are install
    pathology (`dist/cli.cjs`) and DOI-artifact reproducibility (`bin/typst`). **The principle:**
    commit at-tag the things that are (a) reproducibility-critical for the DOI'd artifact AND (b) not
    controlled by us — today exactly `bin/typst`. (`book-theme.zip`/`typst-template.zip` are ours +
    HTML-path/template, so they stay fetched-at-build; the template also rides inside `engine.zip`.)
  - **Rejected:** cache-and-fetch (reopens the one upstream dep we don't control; deposit stays
    non-self-contained); a `package.json`/version-file *pointer* as the delivery mechanism (still
    needs a fetch target); typst-inside-the-template-zip (couples binary to template lifecycle).
  - **Caveats (stated):** linux-x86_64 only (research-compute norm; recorded in provenance `platform`);
    node is *not* pinned ("everything except node" is the practical line — modern node runs an old
    bundle); a typst bump requires cutting an engine release (a feature — it rides the single
    `options.oaktree-sapling.version` review gate, like a myst-cli bump). The release workflow drops
    its hardcoded `TYPST_VERSION` (the script self-provisions from `typst.version` — one source).
  - **Cost accepted:** ~23 MB git-packed per *distinct* typst version (deduped across tags; dev tags
    pruned), ~25–30 MB `engine.zip` per published deposit. Docs synced: `engine/README.md`,
    `engine/RELEASING.md`. Verified: 51 tests green (typecheck
    clean), integration canary renders a real PDF, 0.14.2 musl fetch confirmed.

(r67)=
- **[R67] Deposit pipeline verified end-to-end on CI (sandbox), + 3 live findings.** Ran the full
  `prepare` → DOI PR → merge → tag → `publish` chain through the real workflows against the fixture
  paper (`pollomarzo/fixture-paper-repo`, pinned to engine `v0.0.0-dev.7`), Zenodo **sandbox**. Final
  state: draft `562234` populated with the five files (`paper.pdf`, `source.zip`, `myst.yml`,
  `publication-provenance.json`, `engine.zip`), `version` from the tag, `community` from `journal.yml`
  ([R19], the instance is cloned for `release`), and a GitHub Release carrying the same assets ([R24]).
  Three integration issues that unit tests + a local `deposit publish` couldn't surface (exactly the
  value of testing through workflows):
  1. **`openDoiPr` needs an inline git identity.** A CI runner sets no `user.name/email`, so the DOI-PR
     commit died with "Author identity unknown". Fixed by passing `-c user.name=… -c user.email=…`
     on the commit (`github-actions[bot]`). Engine commit `19bca68`.
  2. **Actions-create-PRs is a repo setting, not code.** `gh pr create` failed with "GitHub Actions is
     not permitted to create or approve pull requests" despite the job's `pull-requests: write` — a
     separate hard gate (`actions/permissions/workflow.can_approve_pull_request_reviews`). Enabled by
     hand for the test; added to the §5 `oak bootstrap` checklist.
  3. **`release` must build in a CHILD process.** myst's HTML/site build calls `process.exit(0)` on
     success; run in-process it killed `oak release` *after* the build but *before* the deposit — the
     job went green while depositing nothing. `cmdRelease` now spawns `oak build` as a subprocess and
     deposits in the parent (same working tree; the child's exit is isolated). Only `release` was
     affected — `ci.yml`'s `oak build` is the whole job, so an exit-after-build is harmless there.
     Engine commit `5280214`. Both fixes ride `v0.0.0-dev.6`/`-dev.7`.
  - **Minor:** existing bootstrapped paper repos carry the *pre-`--version`-drop* `prepare.yml` (a
    `required: version` input); the new CLI ignores a stray `--version`, so the old shim still works,
    but a template re-copy is owed on migration. The two `main` branches and `dev.5/6` tags are
    accumulating (prunable per RELEASING).

(r68)=
- **[R68] [R62] RESOLVED — `compose()` absolutizes instance-relative brand asset paths; the
  URL workaround is retired.** Investigation (source-read of the bundled myst-cli + reproduced
  offline via `oak build`) pinned the mechanism precisely, correcting the working hypothesis on
  two points:
  1. **The fields aren't "resolved against the paper dir through extends" — they're not resolved
     at config-load time at all.** `config.js`'s path-resolution stage
     (`resolveSiteConfigPaths`/`resolveProjectConfigPaths`) only rewrites `projects[].path`,
     `bibliography`, `index`, `plugins` — never `logo`/`favicon`/`style`. Those are resolved
     **lazily at build time**: the site build against `selectCurrentSitePath` (= paper root,
     `manifest.js:142`), the typst export against `dirname(sourceFile)` (= paper root,
     `typst.js`). The `unable to resolve file` string is `myst-templates/validators.js:31`.
     Net effect matches the hypothesis (relative → paper root) but there is **no myst-native
     base-path hook** to change it — absolute (or URL) values are the only fix.
  2. **Favicon ([R61]) is a *separate* root cause, not the same bug.** The logo failure is
     **non-fatal** (broken logo, build continues). The fatal one is `/favicon.ico`
     (`build/html/index.js:62` + `fetchWithRetry` throws on 3× non-2xx). Offline, an *unset*
     favicon makes the default theme fall back to `https://mystmd.org/favicon.ico` → unreachable
     → fatal; a **resolvable** favicon (local abs OR URL) → `GET /favicon.ico 200` → green. So
     absolutization fixes the favicon *only when the brand declares one*; a brand that declares
     none still needs the `oak validate` guard ([R61], still owed — `oak validate` is stubbed).
  - **Why URLs can't be the permanent answer (confirmed empirically):** the site build fetches +
     caches URL assets (`resolveToAbsolute`, `allowRemote:true`) so URLs work for HTML — but the
     **typst** option validator is called *without* `allowRemote` (`template.js:152`), so a URL
     falls through to `fs.existsSync` and errors `unable to resolve file: https://…`; the PDF
     renders with the logo silently dropped. Only a real local path works for typst.
  - **The fix (Option A / [R52] `ownOverride` channel):** the edge (`yaml-io.readBrandAssetOptions`)
     lifts the `{logo, logo_dark, favicon, style}` fields from `brand.yml` **raw** (not the merged
     config — so a paper's OWN relative asset is never reinterpreted as brand-relative); `compose()`
     rewrites any instance-relative value to `<instanceRoot>/brand/<x>` (URLs / absolute pass
     through) and emits them in `ownOverride.site.options`. Safe to set per-key because
     `site.options` merges **field-wise base-wins** (`fillPageFrontmatter.js:22`, unlike the
     whole-entry `exports` of [R53]) — the brand's other options survive. `applyOwnOverride` writes
     each key with `setIn(['site','options',key])`.
  - **Namespace split — HTML vs typst (initially missed, then wired).** The book-theme reads
     `site.options.{logo,logo_dark,favicon,style}`; the **typst** PDF reads a DIFFERENT field,
     `project.options.logo` (`typst.js:290` spreads project frontmatter `options` into the template
     options; `template.yml` declares `logo` as a `type: file`). Upstream `isp-lapreprint-typst`
     defaults that to a bundled neuromatch `logo-watermark.svg` (`template.typ` `else` branch); the
     engine port **deliberately dropped** the default + file to stay brand-neutral (design.md:160-161,
     322 — watermark is INSTANCE-CONFIG's job). So the engine PDF is watermark-less until the tenant
     supplies one. **Decision (user, dedicated-watermark option):** the brand ships
     `brand/logo-watermark.svg` and declares `project.options.logo: ./logo-watermark.svg` — a
     SEPARATE asset from the site-header `site.options.logo`. `BRAND_ASSET_KEYS` is now `{site:[…],
     project:['logo']}`; compose absolutizes the project asset into `ownOverride.project.options.logo`
     and `applyOwnOverride` writes it **per-key** (`setIn(['project','options','logo'])`) — the one
     engine/brand-owned project option, leaving author siblings (`youtube`, the `oaktree-sapling`
     coordinate) intact (finding 3 upheld, just refined from "never project.options" to "never
     clobber *author* project.options"). Because typst can't fetch a URL (`template.js` prepare has
     no `allowRemote`), the watermark MUST be a real file — the URL trick that works for HTML doesn't.
  - **Verified:** unit tests (site + project absolutization, `readBrandAssetOptions` per-namespace,
     per-key apply, sibling-preservation); end-to-end offline `oak build` of the fixture with
     **relative** brand paths → HTML: exit 0, `GET /favicon.ico 200`, no `unable to resolve`; typst
     `--exports-only`: exit 0, `project.options.logo` absolutized to the real watermark, no
     `unable to resolve`, PDF rendered (cover placement is the author's to eyeball). The engine
     `test/fixture-instance` now ships `logo.svg`/`favicon.svg`/`logo-watermark.svg` with relative
     decls (URL workaround dropped). **Still owed (the [R61] half):** an `oak validate` check — warn
     on a brand with no resolvable favicon, and (now) no typst watermark; blocked on `oak validate`
     being stubbed (slice 4).

(r69)=
- **[R69] `deploy-preview` + `notify` unstubbed (slice 2-shim).** New `src/preview.ts` ports
  today's `maybe_preview-deploy.yml` + `notify-newversion.yml` into the two verbs; `gh.ts` gains the
  real seams (`realGhPr`, `realPagesDeployer`), mirroring `zenodo.ts`'s `ZenodoTransport`/`GitContext`
  split. `myst.ts` stays the only myst-cli importer (preview.ts reads only the artifact + journal.yml).
  - **`deploy-preview <site>`:** reads `.pr-number` from the artifact and **deletes it before serving**
    ([R26]); `planPreview` picks Cloudflare vs artifact from `journal.yml` `preview:` ([R27]) —
    `provider: cloudflare` + both `CLOUDFLARE_*` secrets + a `cf_project_name`, else it degrades;
    branch name is `branch_pattern` with `{repo}`/`{pr}` slugified to a CF-safe alias. Deploys via
    `realPagesDeployer` (wrangler → `*.pages.dev` URL), posts the sticky preview comment, then runs
    the reminder inline. `notify` runs **inside** deploy-preview (not a second shim step) so it reuses
    the PR number already read — the frozen shim keeps its single `deploy-preview site` step. `oak
    notify new-version [--pr|--site]` also exists standalone (per the CLI table); it reads `.pr-number`
    **without** deleting (deploy-preview owns the [R26] strip).
  - **The [R16] degrade is CF-only, and it's not error-swallowing.** A Cloudflare failure / missing
    secrets posts a *different, useful* comment (a link to the Paper CI run's `paper-build` artifact) —
    that's the [R6]/[R16] "repo=journal tier works with zero Cloudflare" contract. Everything else is
    LOUD: a `gh` comment/label error throws and fails the run (a green check with no comment is the
    silent failure we refuse to ship); a `v*` tag with an absent/unparseable `project.doi` ("published
    but unlinked") is a hard `exit 1`, exactly as the original `notify-newversion.yml`. A notify
    failure propagates through `deploy-preview`'s exit code even after the preview comment posted.
  - **[R23] tags without full history.** `realGhPr.versionTags` reads `gh api repos/{repo}/tags`
    (`v*` filtered client-side). The Stage-2 checkout is shallow, so `git tag --merged origin/main`
    would see no tag history — the API read is the single honest path, matching the §1c shim note.
  - **One engine (non-shim) change:** `ci/run.sh` now also clones INSTANCE_REPO for `deploy-preview`
    (it needs `journal.yml` `preview:`; build/release already did). run.sh is engine code at the pinned
    ref, not a copied frozen-shim file, so this is a normal bump — no paper-repo re-copy.
  - **Unit tests:** 28 preview tests drive fake seams (`PagesDeployer`/`GhPr`); 89 total green, tsc clean.

(r70)=
- **[R70] `deploy-preview` + `notify` VERIFIED live end-to-end on real Cloudflare + GitHub
  (2026-07-14).** Engine `v0.0.0-dev.8`, fixture `pollomarzo/fixture-paper-repo` PR #5, instance
  `journal.yml` flipped to `provider: cloudflare` + `cf_project_name: oaktree-sapling-test`, both
  `CLOUDFLARE_*` secrets set on the paper repo. Stage-2 `deploy-preview` result:
  `{"preview":"cloudflare","url":"https://cf0f1023.oaktree-sapling-test.pages.dev",`
  `"branch":"paper-fixture-paper-repo-5","notify":{"reminder":"posted",`
  `"record_url":"https://sandbox.zenodo.org/records/562233"}}`. Confirmed: the `oak-preview` sticky
  (real `*.pages.dev` URL) + the `zenodo-newversion-reminder` sticky + the `editor-action-needed`
  label, all posted; the deployment URL, the `paper-fixture-paper-repo-5` branch alias, and the
  previously-fatal `/favicon.ico` ([R61]) all serve **HTTP 200**. **Sticky idempotency proven** —
  two successive real deploys left exactly one comment of each type (edit-in-place, not duplicated).
  The **wrangler-in-CI edge is closed:** `npx --yes wrangler pages deploy` fetches wrangler at
  runtime on the runner and returns the `*.pages.dev` URL, no engine bundling needed.
  - **Decision (user, 2026-07-14): keep `npx wrangler`; an HTTP-API `PagesDeployer` is a possible
    future change, NOT owed before prod.** The counter-argument (the [R51] "no runtime install"
    pathology + an unpinned wrangler dep-tree running with the CF token in env) is real but bounded:
    the token is **Pages-scoped**, so the blast radius is small. Against a rewrite: (a) hand-rolling
    CF Pages direct-upload (hash → check-missing → upload → create-deployment) tends to hide more
    protocol complexity than expected, and wrangler absorbs CF's protocol changes for us; (b) we may
    need **multiple preview providers** (Netlify/etc.), so the right move is to design that seam
    generalization deliberately — analyzing how provider-specific the CF API is — rather than commit
    to a bespoke CF client now and back into the abstraction. Revisit only if/when we add a second
    provider or the token scope has to widen. `bin/typst`-style bundling of wrangler stays rejected
    (sprawling node package, not one static binary).
  - **One live finding (shim bug, [R26] path):** `actions/upload-artifact@v4` **drops dotfiles by
    default** (`include-hidden-files: false`), so the Stage-1-stashed `_build/html/.pr-number` never
    reached the artifact and the first Stage-2 run correctly no-op'd (`no .pr-number in artifact`).
    This lay dormant while `deploy-preview` was stubbed. Fix: `include-hidden-files: true` on the
    `ci.yml` upload step — a **frozen-shim** change (`templates/paper/.github/workflows/ci.yml`, engine
    commit), so like [R67]'s `prepare.yml` drift, **existing bootstrapped paper repos owe a `ci.yml`
    re-copy** on migration. No `dev.8` re-cut needed (ci.yml is a paper-repo file, not bundled engine
    code). Not caught by unit tests (they exercise engine logic, not the shim's artifact upload) —
    exactly the class of gap the live run exists to find.

---

## Ratified deltas (2026-07-21 — pilot port, working-tree mutation)

Surfaced porting a real paper — the first time the engine ran against a
working tree someone cares about, rather than an ephemeral CI checkout.

(r71)=
- **[R71] `oak build` mutates the author's `myst.yml` and never restores it → move the injection
  to a DERIVED config file; the author's config becomes read-only.**

  **The finding.** `runBuild` (`build.ts`) writes the paper's `myst.yml` twice — `setExtends` +
  `writeDoc` (pass 1), then `applyOwnOverride` + `writeDoc` (pass 2) — with no restore anywhere.
  In CI this is invisible (ephemeral checkout). Locally the working tree *is* the author's git
  repo, so after one `oak build` their committed, citable source carries an `extends:` chain of
  **machine-local absolute paths** (`/…/engine/paper-base.yml`,
  `/tmp/instance/editions/….yml`), an engine-injected `project.exports` entry replacing their
  own `template:`, `site.template`, and absolutized brand asset options. A subsequent
  `git commit -am` commits all of it.

  **The docs said "never committed", which is not the same as "never modified"** (design.md:217,
  §3 step 4, [R52], `engine/README.md`). The phrase originated on the **CI pipeline diagram**,
  where it is a complete guarantee, and was carried into the general mechanism description without
  re-deriving what it means when the working tree is durable. design §12a — the section *about*
  local builds — enumerates the local/CI deltas exhaustively ("only three resolvers differ") and
  does not list this; the mutation-persistence difference is a **fourth** delta, in *effects*
  rather than inputs. Neither doc is wrong anywhere; together they build the wrong expectation.

  **Restore-in-`finally` was considered and REJECTED.** Six side effects, one disqualifying:
  1. **`process.exit(0)` defeats `finally`.** myst's HTML/site build exits the process on success
     ([R67.3], the reason `release` already spawns its build as a child), so `await edge.build()`
     never returns and `finally` never runs. The failure mode inverts: restore would run on
     *failed* builds (where the injected file is the evidence you want) and be skipped on
     *successful* ones (where you want it gone). Unit tests would not catch it — they drive a fake
     `MystEdge` that returns normally.
  2. SIGINT/SIGTERM miss `finally` and `exit` handlers alike; SIGKILL is unrecoverable → wants an
     on-disk stash + startup recovery to be robust.
  3. Restoring destroys the injected config exactly when it is most useful for debugging.
  4. Byte-exactness: must restore captured **bytes**, not `writeDoc(doc)` (a yaml round-trip can
     normalize formatting and leave a phantom diff).
  5. Deposit bytes change (below).
  6. mtime churn + clobbering between concurrent builds.

  **The mechanism that replaces it: `new Session({ configFiles: [...] })`.** mystmd takes the
  config filename as a first-class Session option (`session/session.js:70`, default
  `['myst.yml','myst.yaml']`), and every lookup routes through it — `configFromPath`,
  `defaultConfigFile`, `project/load.js:39`, `fromTOC.js:160,185`, `fromPath.js:22`. The only
  hardcoded `'myst.yml'` literals left are `build/site/manifest.js:116-117`, and they are
  `projConfigFile ?? …` fallbacks that do not fire (and resolve to the same dirname regardless).
  **Verified empirically** (spike, myst-cli 1.10.1 — the version the engine bundles): a paper dir
  holding both `myst.yml` (author's) and `myst.oak.yml` (derived) loads the **derived** one,
  ignores the author's entirely, resolves `toc`/content relative to the config's directory, and
  `findCurrentProjectAndLoad` ([R59]) works unchanged.

  **Shape (settled): materialize the author's config into the derived base; keep the engine layers
  as `extends:`.** i.e. exactly today's merge model, written to a different filename.
  - author's own config → **materialized** into the derived file (the base slot)
  - `paper-base` / edition / brand → **stay as `extends:`** (myst remains the config oracle, [R185])

  **Rejected: derive-by-`extends`-ing the author's `myst.yml`** (the tempting "point at the
  original" reading). `extends` *does* carry everything — id, title, keywords, `toc`, the nested
  `options.oaktree-sapling` passthrough, `exports` (verified) — so it is mechanically possible, but:
  1. **Naive form drops the author's `articles`.** A derived `{format, id: typst-pdf, template}`
     entry wins whole ([R52]/[R53]) and `articles: [index, supplementary]` vanishes — i.e. that paper's
     supplement silently disappears from the PDF. Reproduced in the spike. Fixable via the existing
     two-pass, so not fatal alone.
  2. **Fatal: extends siblings RACE.** `config.js:153-168` mutates a shared `project` accumulator
     inside concurrent async callbacks under `Promise.all`, each awaiting file I/O first, and
     `fillProjectFrontmatter(extProject, project)` places the newly-loaded entry in the **base**
     slot — so the entry that finishes **last** wins, and fold order is *completion* order, not
     array order. Demonstrated with array order held constant at `[A, B]`: moving a nested extends
     chain from A to B flipped the winner from `FROM-A` to `FROM-B`. Under this shape the author's
     config becomes just another racer against the edition, so *author-overrides-venue precedence
     becomes a coin flip decided by filesystem timing*. Materializing puts the author's frontmatter
     in the base slot (`config.js:172`, applied after the fold), where base-wins is deterministic —
     the property [R52] identified and the one that cannot be given up.

  **Consequences / still to decide:**
  - Derived file **must live at the paper root** — content paths (`toc`, `bibliography`, `index`,
    `plugins`, and the lazily-resolved brand assets) resolve relative to the config's directory;
    `_build/` would break them. So: paper root, different filename. Naming TBD.
  - It is therefore an **untracked file** in the author's repo → needs a `.gitignore` entry in the
    frozen template, and migrated papers owe one (same class of drift as [R67]'s `prepare.yml` and
    [R70]'s `ci.yml` re-copy). Much milder than a modified *tracked* file, but not free.
  - **`myst.ts` needs two sessions.** It builds one `Session` at module scope shared by
    `loadProject`, `build`, and `withProjectSession`; pass 1 reads the author's config and
    pass 2/build read the derived one — different `configFiles`. Interacts with the config-cache
    note in the [R59] comment.
  - **Decide what Layer-B checks see.** `withProjectSession` feeds the curvenote editorial checks;
    presumably the derived (composed) view. Implicit today, should be explicit.
  - **Regression test owed**, in the spirit of [R36]: assert a custom `configFiles` name is still
    honored, so an upstream myst change (which rides the engine tag) fails loudly in engine CI
    rather than silently at a tenant.

  **Fixed for free:**
  - **A live deposit inconsistency.** `zenodo.ts:472` builds `source.zip` via `git archive … HEAD`
    (the **commit** → clean file), while `:475` `copyFileSync`s `myst.yml` from the **working tree**
    (→ injected, carrying `/home/runner/work/…` paths). Every deposit therefore ships two
    disagreeing copies of the same file. Read off the code path, not off a Zenodo record — **worth
    confirming against the fixture's sandbox deposit** before treating it as established. Under the
    derived-config model both are the author's file, with no special-casing.
  - **The author's standalone `myst build` keeps working** — their `myst.yml` stays a valid,
    unmodified config, so plain `myst` gives an unbranded build. The current model destroys that the
    first time `oak build` runs.
  - Nothing downstream depends on the injected state persisting: `release`'s parent reads
    `project.doi` (an author field), the PDF from `_build/exports`, the abstract from
    `_build/site/content`; preview/Pages read `_build/html`; `oak validate` does not inject.

(r72)=
- **[R72] The engine's three extends layers are safe only because they are KEY-DISJOINT — an
  unwritten invariant, and design §10's "three-tier extends" framing oversells what myst provides.**
  A corollary of [R71]'s race finding. Verified today's layers do not overlap: `paper-base.yml` owns
  `project.thumbnail`/`exports`/`downloads` + `site.options.hide_toc`; the edition owns
  `subject`/`venue`/`license`/`open_access`/`funding`; `brand.yml` owns the `site.options` assets +
  `nav` + `project.options.logo`. (`site.options` merges field-wise base-wins per [R68], so distinct
  keys within it are fine.) The in-code comments explain the **exports** case as whole-entry merge
  semantics ([R52]/[R53]) but never state the general rule, and design §10's SciPy-derived
  "venue → collection → paper" tiering implies layered *override* semantics that myst does **not**
  reliably provide **between sibling extends entries**. The first tenant edition that tries to
  override a paper-base default (`hide_toc: false`, a different `thumbnail`) gets non-determinism,
  not an override.
  - **Decision: do NOT flatten the chain now.** Add a **disjointness check** to `oak validate`
    (~20 lines) and record inter-layer override as a known limitation.
  - **Flattening was considered** (compose folds paper-base+edition+brand+author into one derived
    config, no `extends:`). It would remove the race outright and is *not* blocked by [R185] in the
    way first assumed — `fillProjectFrontmatter` is public API (`myst-frontmatter` index →
    `utils/index.js`), so it would be **sequencing myst's own fold**, not reimplementing merge.
    Rejected for now on three costs: (1) **it breaks the path fields myst currently gets right** —
    `resolveProjectConfigPaths` correctly rebases `bibliography`, `index`, `plugins`,
    `projects[].path` relative to their source config, so flattening them to the paper root silently
    misresolves them; `plugins` is the sharp case, since §1a's whole rationale for gating the
    instance repo is that editions may name MyST plugins. That converts a bounded problem (the 5
    `BRAND_ASSET_KEYS` compose already absolutizes, [R68]) into open-ended ownership of path
    rebasing for every field any tenant might use. (2) It **reverses [R42]/[R197]**, which
    deliberately made edition/brand YAML MyST's compat domain so a floating instance-config cannot
    break a pinned engine. (3) Provenance gets *less* legible — a flat blob answers "what is the
    value" and destroys "where did it come from" (mitigable with emitted `# from:` comments, i.e.
    more machinery).
  - **Named remedies if a tenant ever does need inter-layer override:** flattening (above), or
    **nesting the chain** (siblings race; a chain does not — brand extends edition extends
    paper-base gives deterministic depth-precedence with no flattening, at the cost of the current
    "these files must not carry `extends:`; compose assembles the chain" invariant).

---

## Ratified deltas (2026-07-21, round 2 — templates)

Surfaced continuing the pilot: *what exactly is injected as the export template, and how would a
tenant journal ship its own?*

(r73)=
- **[R73] The typst `template:` is an absolute LOCAL PATH in practice; `typstTemplateUrl()` is dead
  code pointing at an asset that has never been built. design [R175] is factually wrong about what
  happens.**

  Three things get injected, and only one is a URL:

  | Injected | Form today | Notes |
  |---|---|---|
  | `project.exports[].template` (typst) | **absolute local path** `<engineRoot>/templates/typst` | auto-detect (`cli.ts:79-85`) always wins |
  | `site.template` (theme) | **URL** (`themeZipUrl()` → `impact-scholars/myst-theme@v0.2.0`) | must be remote — the theme is not in the engine checkout |
  | `project.options.logo` (typst watermark) | **absolute local path** | must be a file; typst's option validator runs without `allowRemote` ([R68]) |

  `assets.ts::typstTemplateUrl()` builds
  `https://github.com/<repo>/releases/download/<tag>/typst-template.zip`, per [R175]. But
  `scripts/cut-engine-release.sh` force-adds only **`dist/cli.cjs` + `bin/typst`** onto the tag leaf
  (`:78`) and creates a bare marker release (`:90`) — **no `typst-template.zip` is attached for any
  tag**. The branch never fires (`existsSync(<engineRoot>/templates/typst)` is always true in an
  engine checkout, locally and in CI), and would 404 if it did. [R55] flagged the missing release zip
  as temporary; the local auto-detect stuck and became the real mechanism.

  **There is no LaTeX path at all** — no `latex`/`tectonic`/`latexmk` anywhere in `src/` or
  `paper-base.yml` (§0 dissolved them; every export is typst). So there is exactly one injected
  export template, plus the theme.

  **Where it bites: npm packaging.** An npm-installed `oak` has no `templates/typst` (runtime
  assets are release-tag artifacts, not in the tarball), so `existsSync` fails, the URL branch
  fires, and 404s. The fallback exists for a distribution mode that does not exist yet and is broken.
  Two ways out, deferred to the npm-publish step: **cut `typst-template.zip` in the release** (the
  fallback becomes real), or **delete `typstTemplateUrl()`** and ship `templates/typst` in the npm
  tarball. Previously leaned toward deleting; **[R74] makes remote templates first-class, so keeping
  a genuine URL fallback is now the more coherent of the two.** Either way [R175]'s wording needs
  correcting — it describes a mechanism that has never run.

(r74)=
- **[R74] Tenant journals cannot ship their own typst template today. The load-bearing invariant is
  ONE-DECLARER; the source policy is pinned-and-archived, not local-only.**

  **Today: impossible.** `compose()` sets `template:` authoritatively (`compose.ts:218-224` — spread
  the resolved export, overwrite `template`), [R53] requires editions to declare no `exports:`, and
  even a paper's own entry gets its template swapped. Design §5's bet is *customize by parameter*
  (brand supplies watermark/colors as template options), which is defensible for micropublications
  but is a hard ceiling on the most visible thing a journal owns.

  **The invariant (settled) — exactly ONE layer in the extends chain may declare the typst export.**
  This is what [R53] actually discovered, now explained by [R72]: two same-id entries in two extends
  *siblings* race, and the loser's fields vanish whole. [R53] satisfied the invariant by making the
  ENGINE the declarer — but that is one of **two** valid resolutions, and it was chosen before the
  race was understood.

  **Open: who declares (A vs B).**
  - **A — engine declares (status quo), compose RAW-LIFTS the edition's `template:`.** The tenant
    writes myst's field in myst's place; the engine reads it directly rather than through the merge —
    exactly the [R68] `readBrandAssetOptions` precedent, adopted for the same reason (bypass the merge
    so there is no ambiguity about whose relative path it is). Zero boilerplate, no regression risk
    for tenants who do not customize, few lines.
  - **B — the EDITION declares the complete entry; `paper-base.yml` declares none.** compose's job
    shrinks from *set the template* to *fill it when absent*
    (`template: absolutize(resolved.template) ?? engineDefault`). This is the myst-native shape and
    the one design §10 already cites: in the SciPy/Curvenote model the **venue layer declares the
    exports entry, template included** — and ISP itself did this before the port
    (`isp-micropublication-2025.yml:12`). Costs: every edition carries the export block; an edition
    that omits it silently produces **no PDF**, so `oak bootstrap journal` must scaffold it and
    `oak validate` must require it; and "omit `template:` to get the engine's" becomes a documented
    contract, since a tenant cannot write the engine's absolute path.

  **Template source policy (settled).** myst's `template:` accepts **name | path | URL**; the engine
  supports all three. Restricting to local paths would re-narrow a myst mechanism, the same mistake
  as inventing a `journal.yml: typst_template` coordinate (both considered and rejected in
  discussion).
  1. **compose absolutizes only *relative* values**; URLs and absolute paths pass through — the
     identical rule to `BRAND_ASSET_KEYS` ([R68]), so no new logic shape. Required because
     `resolveProjectConfigPaths` rebases `bibliography`/`index`/`plugins`/`projects[].path` but
     **NOT `exports[].template`** (verified in `config.js:292-312`) — an edition-relative
     `./templates/typst` would otherwise resolve against the **paper** root, the [R62] bug class.
  2. **The deposit archives the resolved `templatePath`, whatever its origin.** `myst-templates`
     always materializes to a concrete directory — `<buildDir>/templates/<kind>/<sha256(url)>` for
     remote (`download.js:54-66`), the source dir used in place for local (`:81`, `:85`) — so ONE
     uniform bundler rule covers both. This *replaces* today's accident, where self-containment holds
     only because the template happens to sit inside what `git archive` already captures for
     `engine.zip`. Mandatory the moment a tenant supplies a template.
  3. **`oak validate` warns on a FLOATING template (branch-shaped ref), not on a remote one.**
     Correcting an overstatement made in discussion: [R5] was about the ISP template URL pointing at a
     **default branch**, i.e. unpinned — not about remoteness. A pinned tag/release URL is
     reproducible, and (per rule 2) does not threaten [R66].
  4. **Trust note (why the form is constrained rather than the origin forbidden):** an in-repo
     template is CODEOWNERS-gated *bytes*; a URL is a gated *pointer* to ungated content that can
     change if the target is mutable (a branch, or a replaceable release asset). Same shape as
     [R41]/[R196]'s engine-ref trust, and it argues for constraining the ref form, not banning
     remote.

  **Boundary worth stating so [R66] is not over-claimed:** self-containment is a **PDF** promise. The
  theme zip is already remote and unarchived, but it is HTML-path only, so the claim holds. A tenant
  template is squarely on the PDF path — which is exactly why rule 2 is not optional.


---

## Ratified deltas (2026-07-21, round 3 — [R71]/[R72] BUILT + the export-path pin)

Implemented on engine branch `feat/derived-config` (PR pollomarzo/whitelabel#5, **merged to `main`
`c3d0b9b` 2026-07-27**); 156 tests green,
tsc clean, the offline canary renders a real PDF. `dist/cli.cjs` bundle-driven suites verified.

- **[R71] BUILT — build from a derived `myst.oak.yml`; the author's config is read-only.**
  `runBuild` reads the author's `myst.yml` once and writes both two-pass outputs to
  `DERIVED_CONFIG_FILE` (`myst.oak.yml`, `yaml-io.ts`) beside it; `myst.ts` points myst at it via a
  per-filename-cached `new Session({ configFiles: [...] })` — the mechanism verified in the spike.
  The author path is never opened for writing (asserted byte-identical after a build, through the
  **real bundled CLI**, `integration.test.ts`). `writeDerivedDoc` stamps a generated-file banner.
  The derived file is **not** auto-deleted (myst's `process.exit(0)` defeats any cleanup hook, the
  same reason restore-in-`finally` was rejected) — `templates/paper/.gitignore` (new frozen file)
  ignores it, so **existing bootstrapped paper repos owe a re-copy** on migration (drift class of
  [R67]/[R70]). `withProjectSession` (Layer-B checks) explicitly stays on the author config; the
  compose-then-check question is a recorded follow-up in `myst.ts`, **owed not optional** (user).
  Fixed for free, confirmed: the [R71] deposit inconsistency is gone by construction (the
  working-tree `myst.yml` copied into the bundle is now the author's, matching `source.zip`).

- **[R72] BUILT — `oak validate` rejects overlapping extends layers (`config` finding klass).**
  `checkLayerDisjointness` + `declaredKeys` (`validate.ts`) compare the three layers'
  keys — `*.options` at the LEAF (those maps field-merge, [R68]), everything else at the top
  level (whole-entry / top-key merge). Wired through `runLayerA`/`runValidate` with `engineRoot` +
  `edition` threaded from `cli.ts` (`readEditionQuietly`, never throws). Gates **merge, not build**
  (overlap is non-deterministic, not impossible). A test pins the false-positive it must NOT raise
  (paper-base `site.options.hide_toc` vs brand `site.options.logo`).

- **[R71-out] The typst export `output:` is pinned by compose — `_build/exports/paper.pdf`.**
  Surfaced by the offline canary the moment the config filename changed: myst derives the export
  path from the *declaring* file (`getDefaultExportFolder`/`resolveOutput` in
  `myst-cli/build/utils/`), so the `myst.yml`→`myst.oak.yml` rename moved the directory
  (`_build/exports/<slug(config)>_typst/`) **and**, for MULTI-article exports, the filename
  (`resolveOutput` falls back to `sourceFile` when `articles.length > 1` — the multi-article shape). Left
  unpinned it would have leaked an engine-internal filename into every artifact path, worst for the
  multi-article papers. compose now sets `output` alongside `template` on the whole engine typst
  entry (`TYPST_OUTPUT`); **set in compose, not `paper-base.yml`**, because a paper overriding the
  entry wholesale (multi-article) would drop a base-only field — the [R53] whole-entry rule again.
  Consequences: single-article PDFs rename `index.pdf → paper.pdf` (matches the deposit's reserved
  `paper.pdf`); `findExportedPdf` already globs so the deposit path was never affected; the flat
  path leaves no `_typst` intermediates dir (explicit output *file*). Note the delivery mechanism is
  myst's own `output` field — not a bespoke coordinate.

- **[R71-ci] `npm test` bundles first; a STALE `dist/cli.cjs` now hard-fails.** The bundle-driven
  suites `describe.skipIf` on the bundle's *absence* (portability on a fresh clone, dist is
  gitignored) — but a **stale** bundle silently exercised old code and reported green (it hid the
  export-path move above until a manual rebundle). `test/bundle-state.ts` splits the two:
  absent → skip, stale (older than newest `src/**`) → `beforeAll` throw. `npm test` now runs
  `npm run bundle && vitest run`, so the guard only bites on `test:watch` / bare `vitest`. Minor
  coupling noted: `cut-engine-release.sh` now bundles twice (harmless — deterministic esbuild,
  identical output); a future minified-release bundle at that step would be clobbered by `npm test`.

---

## Ratified deltas (2026-07-27/28 — dep hygiene + GitHub Action SHA-pinning)

- **[R75-dep] Two open PRs cleaned up before the pilot port.** PR #4 (`chore/dep-hygiene`):
  vitest `^2.1.0` → `^4.1.10` (clears the critical esbuild/vite advisory; dev-only, never enters
  `dist/cli.cjs`), `originRepo` no longer leaks git stderr (the `fatal: not a git repository` noise
  in test runs; deliberately NOT applied to `reviewPr`, whose value is deposited into provenance so a
  `gh` failure must stay visible), and an advisory (non-required) `test.yml` PR workflow. Verified the
  vitest **major** bump against the current suite (156/156, tsc clean) before merge. Merged `b23faaf`.

(r75)=
- **[R75] Every GitHub Action pinned by full commit SHA at a close-to-latest major (shim template +
  engine CI).** Supply-chain: a mutable tag (`@v4`) lets a moved/compromised tag inject code into
  token-bearing tenant CI — the frozen shim runs in every paper repo with their secrets. Bumping to
  the current major also clears the node20→node24 runtime deprecation. Bumps: `checkout` v4→v7.0.1,
  `upload-artifact` v4→v7.0.1, `download-artifact` v4→v8.0.1, `upload-pages-artifact` v3→v5.0.0,
  `deploy-pages` v4→v5.0.0, `setup-micromamba` v2.0.7→v3.1.0, `setup-node` v7-tag→v7.0.0-sha,
  `checkout` (engine CI) v7-tag→v7.0.1-sha. (User preference, recorded: *close-to-latest, pinned by
  SHA*.)
  - **Verification — "test all of them" (user):** (a) every input we pass confirmed present in each
    target `action.yml` (esp. `download-artifact`'s `run-id`/`github-token` for the cross-run preview
    split); (b) `actionlint` clean on all workflows; (c) engine `test.yml` live-ran `checkout@v7.0.1`
    + `setup-node@v7.0.0` (PR #6, success); (d) shim actions live-exercised on `pollomarzo/fixture-
    paper-repo` — a push→main ran `ci` (build + `upload-artifact@v7`) → `deploy-pages`
    (`download-artifact@v8` same-run + `upload-pages-artifact@v5` + `deploy-pages@v5`, real Pages
    deploy) and `check`→`check-post` (`download-artifact@v8` **cross-run**, Check Run posted); a
    throwaway PR ran `preview-deploy` (`download-artifact@v8` cross-run + real Cloudflare
    `*.pages.dev` deploy). All green. `setup-micromamba@v3.1.0` is input-compat-verified only — the
    opt-in hook fires only if a paper ships `paper-environment.yml`, which none do.
  - **Re-copy drift ([R67]/[R70]/[R71] class):** the pinned actions live in the frozen
    `templates/paper/.github/`, so already-bootstrapped paper repos owe a re-copy on migration. These
    are paper-repo files (not bundled engine code), so **no `dev.N` re-cut** — and no real papers are
    stamped yet, so there is nothing to chase; the pins land before the migration workstream. The
    fixture paper repo was re-copied as part of the live test (its `main` now runs the pinned shim).
  - Merged engine PR #6 `26d639e`.

---

## Ratified deltas (2026-07-28 — template precedence, resolving [R206] / [R74])

(r76)=
- **[R76] Template precedence = author > tenant > engine, resolved by compose onto the
  own-wins-by-id export entry. Closes [R74]'s open A-vs-B.** Two inputs settled it: a pilot port
  (separate agent, during testing) confirmed **variant (a)** — a paper *keeps its own `exports:`
  entry, drops the floating `template:`, and compose swaps `template`+`output` onto that
  own-wins-by-id entry* (matches `compose.ts:239-245`); and the user reopened author-exclusion,
  wanting per-paper custom template variants to stay possible **with a warning**, not forbidden.
  - **Not really A-vs-B: compose is the authoritative STAMPER regardless of who declares.** A
    multi-article paper overrides the whole export entry in its own config (base-wins by id, [R53]),
    and that winning entry is what compose stamps. So the only question is *where compose reads the
    template VALUE from* — a precedence chain, not a declarer choice.
  - **Precedence chain:** `--typst-template <flag>` (explicit dev/CI, tops all) › **author**
    deliberate template (own `exports[].template`, pinned/path) › **tenant** template (raw-lifted
    field, absolutized if relative) › **engine** default (auto-detect `templates/typst`, else release
    URL). Requires reordering `cli.ts:83-84`, where the engine's auto-detected local template is
    currently forced *first* and would block both tenant and author overrides — it is the
    **fallback**, not the top.
  - **Author override is detectable for free + unifies with variant (a).** paper-base/editions never
    set `template:`, so a `template:` on the resolved typst export can only be the author's own.
    Decision by pinned-vs-floating: a **pinned/path** author template is honored (warn if it beats a
    tenant template — "author template overrides the journal's"); a **floating** (branch-URL) one is
    dropped (the [R5] anti-pattern = variant (a)'s "drop floating"). So [R74] rule 3's
    floating-template predicate becomes the same test that decides honor-vs-drop — one concept, two
    uses. The warning is the trust surface: a paper reskinning away from journal identity must be
    **reviewable in the PR**, not forbidden (wrong) or invisible (wrong).
    - **REVISED 2026-07-28 (user; rationale now in [R79]):** the pinned-vs-floating
      *coupling* above is dropped — it conflated three concerns. **Precedence honors whatever is
      declared (no runtime drop of a floating author template).** Floating becomes a **symmetric
      validate WARN** (any layer), never an error, never a drop; DOI reproducibility rides #4's
      resolved-bytes archive regardless of source form (design §7: floating is fine for the living
      site); and migration strips boilerplate `template:` URLs (a codemod, the pilot's manual step).
      The override *warning* and the precedence chain are unchanged — only the floating handling is.
  - **Declaration-site asymmetry (principled).** The **author** uses myst-native `exports[].template`
    in their OWN config — safe, because it is the deterministic **base slot** (no [R72] race). The
    **tenant** cannot: an extends sibling declaring `exports:` races AND trips the [R72] disjointness
    guard we shipped — so the tenant value is a small **raw-lifted** field (e.g. `typst_template:` in
    `brand.yml`/`journal.yml`, read like `readBrandAssetOptions` [R68], never entering the extends
    merge). This is NOT the bespoke-coordinate [R74] warned against — the field's value still accepts
    name|path|URL (source policy intact); only the declaration *site* is chosen to avoid the race.
    paper-base stays the sole `exports:` declarer in the chain — one-declarer invariant intact.
  - **Deposit archiving (#4) is now doubly mandatory.** Both a tenant AND an author template can be
    non-engine, so neither rides inside `engine.zip`; `buildBundle` (`zenodo.ts:448`) must archive the
    **resolved** `templatePath` whoever supplied it, or the DOI'd PDF stops being reproducible (§7 /
    [R66]). The one non-negotiable of the whole feature.
  - **SUPERSEDED 2026-07-31 — built; see [R79].** `assetOverrides.typstTemplate` stayed the
    top of the precedence chain, and the deposit bundler reaching the resolved template path
    became the mandatory deposit archive.

## Ratified deltas (2026-07-28, round 2 — template tree split)

(r77)=
- **[R77] `copier-template/` split into `templates/paper/` + `templates/instance/`; `PAPER_EXCLUDE`
  deleted; disjointness carried by a test. BUILT + merged (PR #7, `refactor/split-templates`).**
  The single flattened tree (kept apart only by the in-code `PAPER_EXCLUDE` list) is now two
  sibling roots matching what the code already assumed — settling the leftover Copier-name debt from
  [R29] (no scaffolding tool, so `copier-template/` was a misleading path literal). The three
  bootstrap tiers become symmetric — each is "stamp this set, flattened to root," with **no
  tier preference baked into the layout**: `oak bootstrap paper` → `templates/paper/` only; `journal --external`
  → `templates/instance/` only (data-only repo, no `.github/`); `journal --co-located` →
  `templates/paper/ ⊎ templates/instance/`. Renames: `renderTemplate`→`renderPaperTemplate`,
  `renderInstanceConfig`→`renderInstanceTemplate`; `EXCLUDE_FROM_STAMP = {'README.md'}` (the engine
  doc, narrowed from two entries); two per-audience READMEs. The split's only new risk — a same-path
  collision the single tree forbade by construction — is held by a **disjointness invariant test**
  (`test/template.test.ts`): the flattened root-path sets must be disjoint, so a future genuinely-shared
  file fails loudly and forces a deliberate precedence decision then, rather than a silent overwrite.
  `npm test` green at 157. (executed + merged 2026-07-28)

## Ratified deltas (2026-07-30 — paper-CI conformance harness)

(r78)=
- **[R78] `oak conformance` certifies the paper CI — the product's one untested surface. BUILT +
  live-green (2026-07-30).** `npm test` / `cut-engine-release.sh` / `test.yml` exercise the engine as
  a *library* and its own CI; none runs a single stamped *shim* workflow. `oak conformance` closes
  that: it drives the standing fixtures (`pollomarzo/fixture-paper-repo` + public
  `fixture-instance-config` + Cloudflare `oaktree-sapling-test` + Zenodo sandbox +
  `pollobbella/fixture-paper-repo` fork) against an engine version V and asserts **every trigger
  class** green — verified end-to-end on `v0.0.0-dev.23`:
  - `oak conformance reset` — idempotent teardown (close `conformance`-labelled PRs, delete `cert-*`
    branches, `*-cert-*` + reserved `v0.0.0` deposit tags + their Releases).
  - `oak conformance certify --tag V` — reset → **install V** by dogfooding `oak upgrade --both` →
    **push→main** (assert `Paper CI` build+deploy-pages, Pages URL **200**, `Journal checks` Check Run
    on main) → **same-repo preview** (Cloudflare `*.pages.dev` 200 + sticky) → **deposit** (push a
    clean-semver tag → approve the `zenodo-publish` gate if present → assert the 5-file bundle
    `RESERVED_BUNDLE_NAMES` on the tag's GH Release, token-free per [R24]) → **fork PR** (optional;
    2nd-account fork, secretless Stage-1 + base-context Stage-2 preview) → **always-run teardown**.
  - **Assert the parts, not the run conclusion** (the "green-but-empty" failures — [R70] dotfile,
    [R67] exit-after-build — are exactly what this guards): URLs 200, Check Run present, Release
    carries the bundle, PRs opened/closed.
  - **Fault attribution:** a `ThirdPartyError` (poll timeout, or a URL persistently 5xx/refusing
    after retries) → **INCONCLUSIVE** (exit 2, non-red — "red must mean us"); a definitive
    4xx/concluded-failure → **FAILED** (exit 1). A tag-keyed `cert.json` verdict is attached to the
    engine tag's Release (the **C5** seam).
  - **Substrate/decisions:** logic in the CLI (`src/conformance.ts` + `realConformanceGh` in `gh.ts`;
    `conformance.yml` near-declarative), unit-tested through a faked `ConformanceGh` seam (180 tests).
    Credentials: the harness holds **only** a fixture-scoped fine-grained PAT (`CONFORMANCE_PAT`,
    env-gated) + a 2nd-account fork PAT (`CONFORMANCE_FORK_PAT`); CF/Zenodo creds stay the *fixture's*
    own secrets. Cross-repo reach + the GITHUB_TOKEN recursion guard force a PAT, not the ambient
    token. Real runners only (`act` can't do `workflow_run`/Pages/cross-run artifacts). Release/nightly
    gate, never per-commit.
  - **C5 (promotion gate) — DEFERRED:** block/advise a real `vX.Y.Z` cut on its `-dev.N` predecessor's
    `cert.json`. Deferred by user (values the verdict over a hard gate; the cert is "a bit flaky"; no
    real releases exist yet). The seam is built; add C5 when real releases start. The `conformance`
    env's required-reviewer is a bring-up default, droppable on the personal-repo setup (dispatch is
    the real gate) and required-to-drop for any nightly cadence.
  - **Build-out found 5 live gaps** the unit suite never would (each fixed): pre-split-tag `oak
    upgrade` incompat, `oak upgrade --repo` needing git-cred setup in a bare-`GH_TOKEN` runner,
    `oak release`'s clean-semver tag requirement, the (moot) publish self-approve, fork path.
  - PRs #8–#15 on `pollomarzo/whitelabel`. Full design + resolved open questions were folded
    here (2026-07-30). (BUILT + live-green 2026-07-30)
  - **Post-cut hook (PR #16, proven live):** `conformance.yml` gained a `workflow_run` trigger on
    `cut-engine-release` completion — every cut auto-certifies the just-cut (latest) release
    ("release ⟺ certified"). `workflow_run` (not self-dispatch) dodges the recursion guard; a
    "Resolve tag" step reads the latest release. With the env reviewer set it's one-click; drop it
    for hands-off.

## Ratified deltas (2026-07-31 — template precedence BUILT)

(r79)=
- **[R79] Tenant + author typst templates BUILT — precedence `--typst-template` > author >
  tenant > engine, with the deposit archiving the resolved bytes. Implements [R76]/[R206], lifts [R74]'s
  ceiling.** 215 tests green, tsc clean, verified end-to-end through the bundled CLI + real typst
  (tenant template renders; author override renders, warns, and archives).
  - **The chain, and the one-line unlock.** `cli.ts` used to force the engine checkout's
    `templates/typst` into the *same slot* as the explicit `--typst-template` flag, i.e. first —
    so neither a tenant nor an author could ever win. It is now the **bottom** fallback
    (`engineTypstTemplate`), the flag stays the top (a deliberate "render with this one"), and
    compose resolves `flag ?? author ?? tenant ?? engineLocal ?? engineReleaseUrl`.
  - **Declaration sites, and why they differ.** The **author** writes myst-native
    `exports[].template` in their own config — the deterministic base slot, no [R72] race — and
    needs no new field or flag, because paper-base/editions never declare `template:`, so a
    surviving value can only be theirs. The **tenant** writes `typst_template:` in
    **`journal.yml`**, raw-lifted like `readBrandAssetOptions` ([R68]). `journal.yml` rather
    than `brand.yml` on evidence, not taste: `brand.yml` IS a myst config layer, and myst's
    `validateObjectKeys` (`config.js:124`) accepts only `version|site|project|extend` — an
    unknown key there is dropped into `ignored` and warned about **on every build**, reading
    like a myst key that silently does nothing. `journal.yml` never enters the merge at all.
    - **Measured 2026-07-31, and worse than the argument above claimed.** A top-level
      `typst_template:` in `brand.yml` emits `'config' extra key ignored: typst_template`
      **three times per build** (once per config load across the two passes) — and every one is
      attributed to **`myst.oak.yml`**, because `getValidatedConfigsFromFile` threads the ROOT
      config's vfile down through the extends recursion (`config.js:152`) rather than opening
      one per layer. So a key the journal admin wrote in `brand.yml` is reported against the
      paper's *generated* file: it points an author at a file they did not write, about a key
      they did not set. Diagnostic misattribution, not just noise.
  - **Only `./` and `../` mean "a path in my instance-config".** myst's source policy is
    name|path|URL and a bare string is genuinely ambiguous — `lapreprint-typst` is both a valid
    myst NAME and a plausible directory name. The brand-asset predicate could NOT be reused: it
    treats every non-URL non-absolute string as a path, which would rewrite a name into
    `<instanceRoot>/lapreprint-typst` and 404. Rejected the alternative (probe the filesystem
    the way myst's own `resolveInputs` does) because it makes one string mean two things
    depending on what happens to exist — a typo'd path silently becomes a name lookup. The
    ambiguity is instead made **loud**: a documented scaffold comment plus a
    `template-name-ambiguous` warn when a bare value shadows a real instance-config directory,
    which is the one case a tenant would guess wrong.
  - **Floating is a symmetric WARN in `oak validate`, never a drop** (the [R76] revision, now
    real): `template-floating` fires per layer on branch-shaped refs (`.git` with no pinned
    ref, `refs/heads/`, `/archive/main.zip`, a by-name reference per design §7). Conservative
    on purpose — an unrecognized remote URL is not nagged about a pin we cannot see. The
    **override** warning fires in two places for two audiences: `compose` (build log) and a
    `template-override` validate finding (the Check Run + sticky comment), because the trust
    surface is *review*, and a build log is not review. Both are warns; whether an author may
    reskin away from journal identity is the tenant's editorial call, not the engine's.
  - **The deposit now archives the resolved template bytes — `template.zip`, conditionally.**
    `buildBundle` reads the value compose STAMPED (from the derived `myst.oak.yml`, i.e. what
    was actually rendered, not what would be rendered now), maps it to a concrete directory by
    mirroring `myst-templates`' `resolveInputs` in ten pure lines (local in place; URL →
    `_build/templates/typst/<sha256>`; name → `.../<namespace>/<name>` — restated rather than
    imported, so myst.ts stays the sole myst-cli importer), and zips it. **Skipped when the
    template lives inside `engineRoot`** — `engine.zip` already carries it, so every
    engine-template deposit stays byte-identical and `RESERVED_BUNDLE_NAMES` (which the
    conformance harness asserts as must-be-present, `conformance.ts:472`) is untouched;
    `template.zip` is reserved against `deposit/` collisions but deliberately not in that list.
    Unlocatable bytes for a non-engine template are a **hard error**: a DOI'd PDF nobody can
    re-render is worse than a failed deposit. This makes design §7's caveat literal — pinning
    was never the reproducibility anchor, the deposit is. New direct dep: `adm-zip` (pinned to
    `^0.5.18` to dedupe with myst's own copy; `git archive` can't zip a downloaded template).
  - **Found only by the real run, not by construction:** an author's *relative* `./my-template`
    resolves against the **build's** cwd (myst.ts chdirs into the paper root), but the deposit
    runs from wherever `oak` was invoked — so probing cwd refused a perfectly valid deposit.
    `resolveTemplateDir` probes against the paper root. Regression test added; a reminder that
    the myst-cwd coupling ([R59]/[R67] family) keeps producing this bug class.
  - **The `options` escape hatch, and the trap under it** (raised by user 2026-07-31: "why not
    make `journal.yml` myst-validated and put engine keys in the non-validated `options`
    field?"). The premise is empirically right — the same key at `project.options.typst_template`
    in `brand.yml` builds **completely silently**, because `options` is validated by
    `makeValidateOptionsFunction` against the *template's* declared option ids rather than a
    fixed key list. So `options` IS the mechanism if tenant data ever must live inside a myst
    config layer. Two things to know before using it:
    - **A namespaced value is silently DROPPED.** `brand.yml:
      project.options.oaktree-sapling.typst_template` never arrives: `options` merges field-wise
      base-wins at **one** level, so the paper's own `project.options.oaktree-sapling`
      (version/edition — every paper has it) wins the whole `oaktree-sapling` key and takes the
      nested tenant value with it. The [R53] whole-entry rule, one level down, with no warning.
      The hatch is safe only at a **top-level option leaf no other layer declares**.
    - **`options` is not a neutral bag** — it is the template-options namespace with a live
      consumer (`project.options.logo` IS the typst watermark, declared in `template.yml`). Engine
      data placed there flows into every template's option validation, so a tenant template
      declaring an option of the same name collides with journal policy. The
      `oaktree-sapling.version/edition` smuggling is a deliberate exception (the shim needs a
      pre-extends `yq` read of a coordinate that must sit in the paper's own file), not a pattern
      to generalize.
    - **Rejected for `journal.yml` itself.** "myst-validated with an unvalidated `options`"
      reduces, for this file, to *unvalidated*: myst would validate the myst parts (which
      `journal.yml` has none of) and nothing of ours, so either `JournalConfig` (zod: required
      `name`, enum'd `tier`, typed `preview.provider`, defaults, real CLI errors) stays and the
      myst shape buys nothing, or it goes and we lose the checks. There is also no validator to
      inherit — myst validates only files it LOADS, and keeping `journal.yml` out of the chain is
      what dodges [R72]. Plus [R197]'s additive-only contract wants zod `.loose()` (an older
      engine ignores unknown keys **silently**); myst's path warns on them, inverting it.
  - **Gap named, not filled: there is no journal-wide, edition-independent MyST layer.** A tenant
    wanting `project.venue` (or any frontmatter default) set journal-wide must repeat it in every
    `editions/<edition>.yml`; `brand.yml` is the nearest thing but is scoped to visual identity.
    If this is ever wanted, the answer is a **new myst layer in the extends chain** (subject to
    the [R72] disjointness guard), NOT reshaping `journal.yml` — which is valuable precisely
    because it is the one tenant file that is cleanly the engine's rather than myst's.
  - **Still deferred, unchanged:** the migration codemod stripping boilerplate venue
    `template:` URLs from ported papers (plan step 6 — part of migrate-vs-archive, impl §6),
    and the npm-packaging loose end ([R73], plan step 7: `typstTemplateUrl()` still points at a
    `typst-template.zip` no release cuts — now more coherent to cut it, since remote templates
    are first-class).

## Doc consolidation (2026-07-30, round 2)

Retired the last of the standalone scaffolding docs; their durable content lives here now.

- **Slice-4 `oak validate` — design record.**
  `oak validate` is a **journal-controlled** check (the instance-config, which the author can't
  edit, owns the ruleset): Layer A = engine invariants (id shape/uniqueness [R12], layout
  [R46]/[R50], brand favicon [R61]/watermark [R62]; also the fail-fast pre-flight of `oak build`
  [R21]); Layer B = editorial checks the `journal.yml` `checks:` list selects. Reporting = a GitHub
  Check Run (gate + inline annotations) **plus** an always-post sticky PR comment (fork contributors
  rarely click "Details"). Non-obvious decisions worth keeping:
  - **The merge gate is the tenant's policy, not the engine's.** The engine only *reports* an honest
    `conclusion`; whether a failing "Journal checks" run blocks merge is a per-repo branch-protection
    / ruleset choice each editor owns — required + "do not allow bypassing" = admin-proof; non-required
    = advisory; an `@Editors` bypass = editor discretion. (`oak bootstrap` makes it required by default,
    `--no-require-checks` opts out.)
  - **Layer B depends on Curvenote's MIT `@curvenote/check-implementations`; we did NOT reimplement.**
    Maintained upstream, real CRediT validation, version-aligned, bundles cleanly.
  - MyST `error_rules` dropped as a gate — author-overridable (a paper's own `myst.yml` wins as `base`),
    so it can never be the journal's gate.
  - **Deferred landmine — Check-Run annotation paths under a repo=journal layout.** GitHub keys inline
    annotations off **repo-root-relative** paths; Curvenote's positioned checks emit **cwd-relative**
    `file`, and `withProjectSession` chdirs to the paper root. In the n=1 model (paper root == repo root)
    that's already correct; `toCheckRun` also relativizes any *absolute* path for safety. But under
    `tier: journal` (not built) the paper is a subdir, so a positioned check emits `index.md` when GitHub
    wants `papers/<slug>/index.md` — the current fix only rewrites absolute paths. Revisit when the
    journal tier lands: prefix cwd-relative annotation paths with the paper's `location.path`. Non-gating
    (the summary table still lists every finding; only the inline diff pin is affected).

- **Operational gotchas.** The one-line
  landmines a new session steps on, each with its `[R#]`:
  - **Never commit `dist/` (or `bin/`) to `main`** — gitignored; only `cut-engine-release.sh`
    force-adds them onto a *tag leaf* ([R57]). Papers pin a **released tag**, never a branch (the
    `ci/run.sh` guard rejects branches).
  - **`ci/run.sh` must keep its exec bit** ([R64a]) — committed `100755`; a tool that drops it
    (Write/copier on some FS) reintroduces the exit-126 `Permission denied` from the first live run.
  - **`oak build` renders HTML via the current-site pointer** ([R59]) — `myst.ts` must call
    `findCurrentProjectAndLoad`/`findCurrentSiteAndLoad` before `build`; a bare `loadConfig` silently
    drops the HTML site. Offline canaries use `--exports-only` ([R60], HTML needs a network theme).
  - **A brand must ship a favicon** ([R61]) — `compose()` absolutizes instance-relative
    `logo`/`favicon`/`logo_dark`/`style`, but a brand declaring **no** favicon still fatally 500s the
    HTML prerender on `/favicon.ico`; absolutization can't fix an absent field. The `oak validate`
    guard warns but the fatal case is still owed. (URLs are fine for HTML but NOT typst, which needs a
    real file — [R62]/[R68].)
  - **Unbundled `myst-cli` crashes under vitest** (docx/Node 24 interop) — the integration test drives
    the esbuild **bundle**, never an in-process import. Keep `myst.ts` the only `myst-cli` importer.
  - `THEME_REPO` = `impact-scholars/myst-theme` v0.2.0; typst is auto-detected from the engine
    checkout's `templates/typst` — a CI-from-checkout build needs no release zip for either.
  - **compose injects into the paper's own config, not a trailing extends fragment** ([R52]); exports
    don't field-merge, so the whole typst entry lives in `paper-base.yml` ([R53]). As of [R71] "own
    config" = a **derived file beside the paper**, not the author's read-only `myst.yml` (selected via
    `new Session({ configFiles })`).
  - **`extends` siblings RACE** ([R72]) — myst folds them under `Promise.all` with a shared
    accumulator, so precedence is *load-completion* order, not declaration order. The engine's three
    layers are safe only because their keys are disjoint; only the own-config base slot is deterministic.

## Ratified deltas (2026-07-31, round 2 — the journal site)

(r80)=
- **[R80] The journal site is BUILT — a plain myst project in the instance-config repo, not
  an engine build. `nexus-base.yml` and `buildKind: 'site'` are deleted. 242 tests, tsc clean,
  LIVE-VERIFIED, merged to `main` `fe5e63b` (PR #18).** Closes the gap that the engine could
  build, check, deposit and certify *a paper* but could not produce **the journal those papers
  belong to** — the page a reader lands on.
  - **The settled decisions, S1–S8** (referenced as `[S#]` throughout this entry; they were the
    discussion doc, and the reasoning that produced them is in the bullets below):
    **S1** the site is a plain myst build, not an engine build — remote `extends:`/`plugins:`
    keep it version-pinned without one. **S2** the gallery plugin lives in the ENGINE, consumed
    by tag-pinned raw URL (the only shared home we have). **S3** the scaffold is ONE-SHOT and
    tenant-owned — not frozen, not touched by `oak upgrade`. **S4** the registry stays a THIN
    pointer list (+ optional `site_url`); the plugin fetches display metadata per paper, and
    reading a built `myst.json` instead of raw `myst.yml` is deferred. **S5** registration is a
    MANUAL editorial PR — no cross-repo write from paper repos. **S6** the grouping axis is
    `edition`, and per-edition pages are tenant-written markdown (a non-myst key in
    `editions/<edition>.yml` is silently ignored and misattributed to a paper's generated
    config, [R79]). **S7** external tier first; repo=journal (n>1) is unbuilt AND partly broken,
    so the index generator takes **a list of papers**, not "the registry", and
    discovery can feed the same code later ([R188]). **S8** the site FOLDS into instance-config
    without renaming the repo (variant A′).
  - **The shape (S1/S8, variant A′).** The site is a plain `myst build --html` living in the
    **instance-config repo**, deployed to Pages at `<owner>.github.io/<instance-repo>/`. `oak`
    never runs there. Version-pinning survives anyway because myst resolves **remote
    `extends:` and remote `plugins:`** (`config.ts:186`, `:415-419`), so the site references
    the engine by tag-pinned raw URL with no engine checkout. Folding it into instance-config
    rather than giving it its own repo was decided on **one row of the comparison**: the
    editorial PR that adds a registry entry *is* the deploy trigger. A separate site repo has
    no trigger at all — it would need either nightly-cron latency or exactly the cross-repo
    credential [S5] exists to avoid. Accepted costs: a subpath URL (recoverable three ways,
    none a lock-in) and site assets riding along in every paper build's depth-1 clone.
  - **`nexus-base.yml` earned nothing and is DELETED, together with the dead
    `buildKind: 'site'` path.** Asked plainly: it held **one key**, `site.options.hide_toc:
    true`, and that value is *wrong* for a gallery (it was inherited from `paper-base.yml`; the
    real site sets myst's default). The obvious repair — put the theme pin there instead —
    doesn't survive scrutiny: **a remote `extends:` at a pinned tag is byte-identical to
    stamping the same content at bootstrap**, since the tag freezes the file the moment it
    exists. Fetching it buys no freshness over writing two lines into the tenant's `myst.yml`,
    and costs a network fetch per build, a drift test against `themeZipUrl()`, and a second
    remote failure mode next to the plugin's. So the theme URL is **stamped from the constant**
    and the engine owns exactly one site-facing artifact — `plugins/gallery.mjs`, which *must*
    be remote because it is **code**: a `.mjs` body cannot be stamped into YAML, and vendoring a
    copy is the copy-rot the engine exists to kill. The `'site'` branch went with it: it was
    never wired, and was actively wrong (it still appended `editions/<edition>.yml` +
    `brand.yml`, meaningless for a gallery). Design §5's *intent* survives — the site's
    structural defaults are platform-owned, not tenant-brand; it just turns out the residue
    after de-branding is one URL. Four docs revised in the same change (design §5 row, design
    §12 layout, `engine/README.md`).
  - **`templates/site/` — a third stamp root, unioned with `templates/instance/` for
    `--external`.** ONE page, not two: a fresh journal has exactly one edition, so a landing
    page *plus* a per-edition page is structure the tenant hasn't earned. `pages/index.md`
    carries the blurb and an **unfiltered** `:::{paper-cards}`; a tenant who grows a second
    edition adds a page and filters it with `:edition:`, which is markdown — the layer [S6]
    says that is for. That deleted a rendered file, an `edition.md` → `<edition>.md` rename
    rule, an `:edition:` stamping and a toc entry. **One-shot ([S3]):** not frozen, not covered
    by `oak upgrade`, no re-copy drift — the only platform-owned bytes are three pins the
    tenant bumps by hand (plugin URL, theme zip, `mystmd` in `package.json`). No README of its own: A′
    makes the site and instance-config one repo, so `templates/instance/README.md` gains the
    section. **Not stamped for `--co-located`** (repo=journal's index is the deferred
    `assemble()` work), which a regression test pins.
  - **`test/template.test.ts` now checks the pairs that are actually unioned**, not "all roots
    are disjoint": `paper ⊎ instance` (co-located) and `site ⊎ instance` (external). `site` vs
    `paper` is deliberately **unchecked** — they are never stamped together, and both
    legitimately own a root `myst.yml` and `.gitignore`. The old one-assertion docstring read
    as the stronger claim; it would have been a false constraint the moment the site landed.
  - **LIVE-VERIFIED 2026-07-31 on `pollomarzo/oak-site-test` (engine `dev.27`→`dev.30`) — three
    bugs, none visible to 241 green unit tests or `tsc`.** (1) The card's **DOI link failed the
    build**: myst converts any link whose url is a DOI into a `cite` (`dois.ts:239-242`, no
    per-node opt-out), so each card triggered a doi.org metadata fetch — the fixture's sandbox DOI
    404s → `--strict` → red. The happy path was wrong too (a citation label + a stray bibliography
    on the card, plus a rate-limited fetch **per paper per build**), so the fix is to render the
    DOI as **text**; `error_rules: doi-link-valid: ignore` was rejected as silencing the failure
    while keeping the wrong rendering. (2) **Every asset 404'd**: this tier serves at
    `<owner>.github.io/<repo>/` but the workflow built with no base path, so myst emitted
    root-absolute `/build/…` for thumbnails, theme CSS and JS. `ci/run.sh` solves this for papers;
    the site plan never mentioned it. Fixed via `actions/configure-pages` →
    `BASE_URL: ${{ steps.pages.outputs.base_path }}`, which is EMPTY for a user/org site or custom
    domain and therefore survives all three vanity-URL routes, unlike a hardcoded `/<repo>`.
    (3) **`--strict` does not catch a plugin that never loaded** — see the correction below.
  - **Fail-loud is a THREE-part policy; the plan's two-part version was WRONG.** The plugin keeps today's
    hard `throw` for **per-paper** failures (a registry entry whose `myst.yml` won't fetch is a
    **broken registry** — fix it, don't paper over it; a failed build is not an outage, since
    Pages keeps serving the last successful deploy). But `--strict` is **load-bearing, not
    hygiene**, and covers a different failure: `myst build` exits 0 on errors without it
    (`cli/options.ts:98-102`), and a remote plugin that fails to load **degrades quietly** —
    `resolveToAbsolute` logs a *debug* message and falls through, `loadPlugins` records an
    error-kind file warning, and the page deploys with `paper-cards` as an unknown directive:
    **no gallery at all**, over a good previous deploy. **The plan asserted `--strict` catches
    this; the live run proved it does not.** Pinning the plugin URL to a nonexistent tag produced
    BOTH `⛔️ Unknown plugin …` and `⛔️ pages/index.md:8 unknown directive: paper-cards` — and
    still **exit 0**, deploying the gallery-less page. `--strict` aggregates warnings attached to
    project *pages* at build time; these are raised earlier and are not in that set. The real
    guard is a **positive signal**: the workflow greps the build log for `Paper Gallery.*loaded`,
    i.e. for the plugin's own `name` — our string, not a myst log format we don't control — and a
    unit test pins that name so a rename cannot silently disarm it. So: the plugin's `throw`
    covers per-paper failures, `--strict` covers errors raised while building a page (a bad DOI, a
    broken thumbnail), and the log assertion covers "the plugin never loaded". No two of the three
    subsume each other.
  - **The thumbnail is fetched by myst, not by the plugin — and that is load-bearing.** The
    gallery transform runs at `stage: 'document'` (`process/mdast.ts:224`), *before*
    `transformImagesToDisk` (`:438`), so the remote URL the plugin emits is picked up by
    `saveImageInStaticFolder` → `downloadAndSaveImage` (`transforms/images.ts:115-117`) and
    written into the site's public folder under a content hash. Three consequences: the
    published site serves a **local copy**, not a hotlink; a broken thumbnail is *already* an
    error-kind warning (`RuleId.imageDownloads`, `images.ts:82-88`, including the
    HTML-error-page content-type case), so `--strict` fails the build on it with **no extra
    check in the plugin** — don't add a redundant one later; and it **caps what a cached
    `title:` in the registry could buy**, since N thumbnail downloads would remain either way.
    Hermeticity would mean copying binary thumbnails into the instance repo and adding a step
    to every registration PR — noted so the escape hatch isn't oversold. [S4] stands.
    - Cross-plan seam: the thumbnail-check plan makes a *missing paper thumbnail* a **warn**
      (a mid-draft paper hasn't made one), while a *registered* paper without one **hard-fails
      the journal build**. That asymmetry is correct — the thumbnail becomes mandatory at
      **registration**, which is exactly when an editor is in the loop.
  - **The plugin's one real surprise: a remote plugin's `import`s resolve from the SITE repo,
    not from myst.** myst downloads a remote plugin to `<project>/_build/cache/config-item-
    <hash>.mjs` (`resolveToAbsolute.ts` + `cache.ts:cachePath`) and imports it from there, so
    node resolves its bare specifiers up from the *project* directory — an `npx -y mystmd@…`
    install lives in the npx cache and is **not** on that path. The plan's workflow had neither
    a `package.json` nor an install step, so `import yaml from 'js-yaml'` would have failed to
    load the plugin on the very first real run — a silent, gallery-less green deploy without
    `--strict`, which is precisely the failure mode above. Fixed by shipping
    `templates/site/package.json` plus one `npm install` step — and, once that existed, MyST's
    own pin **moved into it** (from `npx -y mystmd@<range>` in the workflow), because two
    pinning mechanisms for one site is one too many. Net effect is *fewer* installs, not more:
    `npx -y` was already fetching MyST on every run, just into a cache dir instead of
    `node_modules`. The workflow is now byte-copied (`npm install` + `npx myst build --html
    --strict`) and `package.json` is the single rendered dependency list — which also fixes
    local DX, since `npm install && npx myst start` now just works.
    **The rejected alternative was a hand-rolled YAML reader** to
    keep the plugin dependency-free: paper titles routinely contain colons and quotes, so a
    narrow parser would mis-render cards on the live site — a correctness bug traded for a
    scaffold file. Recorded as a standing constraint: **anything added to `gallery.mjs`'s
    imports must be added to the site scaffold's `package.json` too.**
  - **Registry:** `site_url` added to `RegistryEntry` (optional, additive per [R197]) —
    absent → derive `https://<owner>.github.io/<repo-name>` from `location.repo`. Raw URLs go
    through **`HEAD`**, not `main`, so a tenant whose default branch is named otherwise still
    resolves, and `location.path` is honored so the n>1 tier stays reachable without touching
    the plugin ([S7]). Order is **registry file order** — the editor controls sequence by
    insertion point, which needs no extra field. The card shows title + keywords (fetched per
    paper) and the **DOI** (the one display field the registry actually owns).
  - **Bootstrap:** `--external` now renders `templates/instance/ ⊎ templates/site/` and
    **enables Pages** through the existing `pagesEnabled`/`enablePages` seams (GET-then-act, so
    a re-run is idempotent), prints the site URL in the result payload and runbook, and takes
    `--no-site` for a tenant who wants a config repo with no website. Deliberately **not**
    added: rulesets/branch protection on instance-config — registry upkeep is a manual
    editorial PR ([S5]) into a repo only editors can write, and how tightly to gate it is a
    tenant policy call, same stance as `--no-require-checks` on papers. Named in the runbook,
    not imposed.
  - **Layer disjointness is trivially safe here** ([R72]): the site's chain is a **single**
    entry (`./brand/brand.yml`), and a one-element chain has no siblings to race. Brand
    declares `site.options.*` + `project.options.logo`; the site's own `myst.yml` (the
    deterministic base slot) declares `project.*` + `site.template`. Note `oak validate`'s
    disjointness check is **paper-shaped and does not cover the site chain** — accepted,
    recorded here rather than left to be rediscovered.
  - **Not added to `oak conformance`:** that harness certifies the **paper CI**, and the site
    has no engine CI to certify. Recorded so the omission is a decision, not an oversight.
  - **Vanity URL — three routes, none a lock-in** (A′ serves at a subpath by default): a
    **custom domain**, which makes a project site serve at that domain's root (~$10/yr, so it
    stays opt-in and the scaffold never assumes it); an **inert redirect repo** named
    `<owner>.github.io` (free, and it does NOT reintroduce the separate-repo trigger problem,
    since it is created once and never touched); or **renaming the instance repo later** —
    cheap and non-breaking, because GitHub redirects the old repo URL for git operations, so
    `ci/run.sh`'s clone keeps working and updating `pins.yml` is optional cleanup. Route 3 is
    why A′ was safe to commit to before any tenant existed.
  - **Out of scope, named so it is not mistaken for a gap:** repo=journal (n>1) and `assemble()`;
    reading `myst.json` per paper (deferred by [S4] — `paperUrls` is the single
    place that would change); automatic registration (`oak release` opening a cross-repo PR would
    need exactly the credential [S5] avoids); `oak validate` coverage of the SITE extends chain
    (it is paper-shaped); and the local-checkout gallery preview.

## Ratified deltas (2026-07-31, round 3 — the thumbnail check)

(r81)=
- **[R81] `oak validate` checks the paper's `thumbnail:`. 246 tests, tsc clean, local-green.**
  `paper-base.yml` pins
  `project.thumbnail: thumbnails/thumbnail.png` and the gallery consumes it, but nothing checked
  the file was there — a broken card was discovered on the live site, not on the PR.
  - **Pinning the key is what makes the check necessary.** `transformThumbnail`
    (`transforms/images.ts:543-556`) searches the mdast for a first content image ONLY when
    `thumbnail` is unset. Ours is always set through the extends chain, so a missing file is
    *worse* than no key: `saveImageInStaticFolder` returns null and the paper ships with **no
    thumbnail at all**, silently. Hence the semantics — **absent → pass** (myst's own fallback is
    live again, which is a working thumbnail), set-but-unresolvable → finding, URL → pass
    (myst downloads it for HTML, [R80]).
  - **A plain existence probe against the paper root is correct**, unlike brand assets
    ([R62]/[R68]) or `exports[].template` ([R74]). Verified in the local mystmd clone:
    `thumbnail` is not rebased by `resolveProjectConfigPaths` (`config.ts:389-430` covers
    `bibliography`, `index`, `plugins` only), and myst resolves it against the SOURCE FILE
    (`getSourceFolder`, `links.ts:92`) — `index.md`'s folder, i.e. the paper root — not against
    the layer that declared it. No absolutizing seam needed.
  - **`warn`, klass `structural`** — which does NOT block the build (only `error` + `structural`
    does). Deliberate, and the cross-plan seam in [R80] is the reason: a *registered* paper
    without a thumbnail already hard-fails the **journal site** build under `--strict`, so the
    thumbnail is mandatory at **registration**, with an editor in the loop. Blocking a mid-draft
    paper that simply hasn't made one yet would be the wrong trade.
  - **Where it actually fires — a limitation worth naming, not a bug in this change.** `oak build`
    reads the DERIVED config (extends chain resolved), so the pinned value is present and the
    check is live there; smoke-tested on a ported pilot paper — clean with
    `thumbnails/` in place, `::warning::[thumbnail] …` with it renamed away. `oak validate`,
    however, loads the **author's own** `myst.yml` ([R71]), which carries no `extends:` in the
    new model — so `thumbnail` is absent there and the check is a silent pass unless the author
    declares one themselves. It still reaches the PR as a **GitHub warning annotation** on the
    Paper CI run (`cli.ts:111` writes build warnings as `::warning::`), but it does **not** reach
    the "Journal checks" Check Run or its sticky comment,
    which is where it would be most useful. The fix is the already-recorded FOLLOW-UP OWED in
    `myst.ts` — give Layer B (and Layer A) a composed-config view ([R71]) — not a second
    thumbnail-shaped special case; recorded here so the gap is a known one rather than a
    surprise the next time a blank card ships. **RESOLVED by [R82]** (2026-08-01): validate now
    reads the composed config, and this check fires there.

## Ratified deltas (2026-08-01 — `oak validate` reads the composed config)

(r82)=
- **[R82] `oak validate` now reads the COMPOSED config, sharing `build`'s materialization —
  resolving the [R71] follow-up. 254 tests, tsc clean.** `runValidate` used to call `loadProject(paperRoot)`
  with myst's default config file, i.e. the AUTHOR's `myst.yml` — which in the new model carries
  no `extends:`, so validate judged a config that is **not what ships**.
  - **Two symptoms of one gap, one of them shipped.** (1) The `thumbnail` check ([R81]) was a
    silent pass: `paper-base.yml` pins `project.thumbnail`, which exists only post-`extends`, so
    a missing thumbnail reached the PR as a build annotation but never as a Check Run finding.
    (2) `exports-exist` would have passed **vacuously**: the complete typst export lives in
    `paper-base.yml` ([R53]) and the author's config usually declares none, so
    `collectExportOptions` collected zero exports and the check returned `[]` — green, always,
    one `journal.yml` line away from being selected. A check that looks green is worse than one
    that looks broken, which is what tipped this from "latent, wait for a trigger" to "do it now".
  - **The rule: the composed view is the default everywhere; a value whose PROVENANCE is the
    point is raw-lifted outside the merge.** Not a new mechanism —
    `readBrandAssetOptions` ([R68]) and `readTenantTypstTemplate` ([R79]) already exist for
    exactly this. Rejected: a per-check view registry. Layer B is a THIRD-PARTY catalog
    (`@curvenote/check-implementations`, 14 checks, we select 5) whose checks take a myst
    `session` — there is nowhere for a check to declare a view, and a check-id → view table for
    code we do not own would drift on every upstream release.
  - **The one raw-lift, and the regression it prevents.** `checkTemplates`' override detection
    rests on "paper-base and editions never declare `template:`, so a surviving value can only be
    the author's" ([R76]/[R79]) — but compose STAMPS one (`flag ?? author ?? tenant ?? engine`),
    so on the composed view `template-override` would fire on EVERY paper and `template-floating`
    would misattribute the layer. New `readAuthorTypstTemplate` (`yaml-io.ts`) reads it straight
    from the author's `myst.yml`. Two tests pin both directions, and both pilot papers verify it
    live: neither declares a template, neither reports an override.
  - **Both passes, not just pass 1 — the tempting shortcut is wrong.** Pass 1 already carries
    `thumbnail` AND leaves the author's `template:` unstamped, so it looks like it would give the
    raw-lift for free. But pass 2 is what stamps `output` (`TYPST_OUTPUT`, [R71-out]); under pass 1
    an export's output path is myst's default derived from the DECLARING file
    (`_build/exports/<slug(myst.oak)>_typst/…`) — a path the build never writes. `exports-exist`
    would then be wrong forever rather than merely unrun, and the next check reading a stamped
    field repeats the bug. Validate must see the config the build renders; that is [R71]'s lesson.
  - **`materializeDerived` is SHARED with `oak build`** (extracted from `runBuild`, which is
    otherwise unchanged — its suites and the bundled-CLI integration test are the extraction's
    acceptance criterion). Neither verb can drift from the other. Consequence, accepted (user):
    **`oak validate` now writes `myst.oak.yml`**; it is gitignored by the frozen paper template,
    and already-migrated papers owe that one line (the [R67]/[R70]/[R75] re-copy-drift class).
  - **Degrading is deliberate, and it SAYS so.** A bare local run or `--no-instance` has nothing
    to compose ([R193] soft-warn precedent), so validate falls back to the author's config —
    and materialization is GUARDED, because validate is a reporter and a gate that crashes tells
    the author less than one that says what it could not do. Either way a `notes[]` entry lands
    in the report and in `--report` (a silent difference between two runs of the same command is
    the [R71] mistake in miniature). Verified live on a pilot: `--no-instance` returns a report
    whose note names exactly which fields are invisible.
  - **`exports-exist` reports its precondition instead of lying.** `CheckStatus` has only
    `pass | fail | error` — no `skip` — and the enum documents `error` as *"the check could not be
    run"*, already how we report an unloadable project. So when it is selected and
    `_build/exports` is absent, `splitUnrunnableChecks` holds it back with
    `error: requires build artifacts`. **Not** solved by building first: `check.yml` is
    deliberately a separate, secretless Stage-1 workflow from `ci.yml`, and building there would
    either couple the merge gate to build success (undoing the id-gate relocation) or build every
    PR twice. That shim reorder stays a deliberate follow-up for a check nobody has selected.
  - **Verified live on the two ported pilot papers** (against the pilot instance-config):
    both `status: ok`, no new findings, no `template-override`, and `notes` absent — i.e. they
    composed. Renaming a pilot's `thumbnails/` away makes the `thumbnail` warning appear, which it
    provably could not do before this change. The engine fixture paper genuinely ships no
    thumbnail, so the integration suite now asserts the warning is present there — the [R81] gap,
    closed and pinned.
  - **AMENDED 2026-08-01 by the PR #19 review — four corrections, three of them to claims made
    above.** 256 tests, tsc clean, cut as `v0.0.0-dev.31`.
    - **`exports-exist` is now ALWAYS `optional`, whatever the journal said.** The bullet above
      is right that `error` is the honest status and wrong that reporting it is harmless:
      `optional` is what keeps a result out of `blockingCheckFail`, so a plain selection of the
      id failed the Check Run on **every PR of every paper** — `_build/exports` is never present
      in CI (gitignored, fresh checkout, no build step in `check.yml`) — with nothing an AUTHOR
      could do, since only the tenant edits `journal.yml`. It also passed locally, where an
      earlier build left the directory behind. Trading a vacuous green for a permanent red is
      the wrong direction for a merge gate; the tenant still sees the result and its cause.
    - **"Neither verb can drift from the other" was FALSE as shipped.** The *function* was
      shared; its *inputs* were not. `buildPaper` passes `assetOverrides`
      (`--typst-template`, and `engineTypstTemplate: <engineRoot>/templates/typst`, which
      exists in every checkout **including CI**); `cmdValidate` passed none, so validate stamped
      the release-zip URL where build stamps the local path — two different files under one
      name. Live proof on a ported pilot: `template:` differed line-for-line between a validate
      and a build in the same tree. Worse, `readStampedTemplate` (`zenodo.ts:462`) reads that
      file as the record of *what the build rendered with*, so a local build → validate →
      deposit archived the wrong provenance and could throw `TemplateArchiveError` after a
      build that did happen. Fixed by extracting `assetOverridesFrom(argv)` and calling it from
      both verbs. The sharper question — whether a deposit's provenance should live in a file
      any verb may rewrite — is deferred.
    - **"Both passes" is true of the materialization, not of the run.** Layer A reads the
      **pass-1** resolved project; Layer B reads the **pass-2** file. That is correct and cannot
      be otherwise: `oak build`'s [R21] pre-flight runs BETWEEN the passes, so pass 1 is the one
      view both callers can share, and handing Layer A the stamped project would trade an A/B
      split inside validate for an A/A split *across the two verbs* — the worse trade. Now
      stated in `runLayerA`'s docstring, with the trigger to revisit named (a Layer-A check that
      wants a stamped field).
    - **Findings anchored to the derived config no longer annotate.** curvenote's
      `getFrontmatter` returns `selectCurrentProjectFile`, so since this change every
      `authors-*`/`keywords-defined` result carries `file: …/myst.oak.yml` — a generated,
      gitignored path GitHub cannot resolve (and a batch of unresolvable ones 422s the whole
      POST, `checks.ts`). Rewriting it to `myst.yml` was rejected: the derived file has a banner,
      an injected `extends:` block and the stamps, so its line numbers are not the author's, and
      a confident annotation on the wrong line is worse than none. Latent today (none of the 5
      selected checks emits a position with a config file) — fixed as insurance against the
      sixth.
    - Also: `test/fixture-paper/myst.oak.yml` had been **committed** (generated output, absolute
      paths to one checkout, its own banner saying "do not commit"). `npm test` rewrites it
      anywhere else, and `cut-engine-release.sh:44` refuses to cut from a dirty tree — so the
      release path was broken on every machine but the one that committed it. Untracked, and
      `myst.oak.yml` added to the engine's own `.gitignore`.
    - **A compose FAILURE now gates; "nothing to compose" still only notes.** The guard let a
      paper with a typo'd `edition:` — one that hard-fails `oak build` — return `status: ok`,
      exit 0, Check Run `success`. Reproduced, and fixed: when `composable` is TRUE the operator
      supplied an engine checkout AND an instance, so a throw is a defect in the paper's own
      config and `oak build` hits the identical throw on `main`. It emits a `compose`
      finding, `severity: error`, **`klass: config` not `structural`** — structural
      short-circuits Layer B, and the id-gate-relocation precedent says the author should get
      the whole fix-list in one run, with the note explaining why some Layer-B passes are worth
      less than they look. Still guarded rather than rethrown: the report beats a stack trace.
      `--no-instance` / no engine checkout is an operator choice and stays a pure note.
    - **`notes` reaches the PR UI.** It went to `emit()` and `--report` only, while
      `cmdCheckPost` reads `report.checkRun` alone — so a degraded run and a composed one
      produced byte-identical Check Runs and sticky comments, which defeats "the degradation
      SAYS so" in the one surface that decides merges. `toCheckRun` now embeds notes as a
      blockquote ABOVE the table; the sticky comment renders `checkRun.summary`, so it inherits
      them and check-post needs no change. Notes never touch `conclusion` — the `compose`
      finding gates, a note only explains.
    - **Verified end-to-end on the pilots:** typo'd `edition:` → `status: error`, exit 1,
      `conclusion: failure`, `compose`/`config` in `errors`, note at the head of the summary,
      Layer B still reporting its 16 results; both healthy pilots unchanged (`status: ok`, no
      notes, exit 0).

(r83)=
- **[R83] Untrusted-PR-surface security review — seven hypotheses, tested live where it mattered;
  three fixes shipped, H1 downgraded.** 2026-08-02. The load-bearing results:
  - **Trust boundary works, and it is provisioned, not aspirational.** H4: `bootstrap`
    (`protectMainBody`/`vTagsBody`) applies `protect-main` (code-owner review, no bypass) and
    `editors-only-v-tags`; verified live on a throwaway repo from a second account — a PR touching
    `.github/`/`CODEOWNERS` is blocked "review required", a `v*` tag/release via the web UI is
    refused. **CODEOWNERS is self-protecting.** `required_approving_review_count: 0` with
    `require_code_owner_review: true` DOES enforce (0 = "no approvals beyond the code owners").
    Cloudflare token confirmed `Pages:Edit` single-project; Zenodo token confirmed to lack
    `deposit:actions` (H7) — the withheld-publish assumption is enforced at the token, which is
    also why `prepare.yml` needs no environment gate.
  - **Stage-1 containment is real (H5).** A fork PR shipping a plugin that dumps env saw no
    `CLOUDFLARE_*`/`ZENODO_*`/writable token, in both the build and the validate jobs. Side
    finding: `oak validate` EXECUTES the paper's `plugins:` (via `loadProject`, `build.ts:128`) —
    contained in CI, but a local `oak validate` on an untrusted paper runs its code (documented
    warning).
  - **H2 — validate artifact-derived sha/pr before the shell splice** (`check-post.yml` meta step:
    `^[0-9a-f]{7,40}$` / `^[0-9]{1,10}$`, fail closed). The `journal-checks` artifact is
    untrusted; its values flowed into the `args:` string spliced into a shell. Shipped, PR #20.
  - **H3 — strip symlinks from the build output before upload** (`ci.yml`). The stated
    shim-overwrite is safe *because* `upload-artifact` resolves symlinks to content (so extraction
    has nothing to traverse); but that same follow-behaviour let a planted symlink serve arbitrary
    runner-readable file content on the public preview (proven: `/etc/hostname`, shim source).
    `find _build/html -type l -delete` before upload. Shipped, PR #20.
  - **H1 — a fork can forge the "Journal checks" verdict; DOWNGRADED, mitigated not re-architected.**
    `check-post` posts `report.checkRun.conclusion` verbatim (`checks.ts`), and a fork controls the
    report by editing `check.yml`/`action.yml`/`pins.yml`. Confirmed live (forged green posted).
    But forgery REQUIRES editing a CODEOWNERS-gated frozen file, so it cannot merge unreviewed —
    the residual is only an editor *lulled by green*. The robust fix (a plugin-free validate core
    run in trusted Stage 2) was ruled unnecessary: not worth the cost against a residual CODEOWNERS
    already back-stops. Instead: **the frozen-shim advisory** — `check-post` compares the PR head
    (`github.event.workflow_run.head_sha`, GitHub-set, NOT the fork-controlled artifact) against
    base and, on any `.github/**`/`CODEOWNERS` change, warns in the Check-Run title/summary and the
    sticky comment. **Advisory, never a gate** (`conclusion` unchanged): legitimate engine-upgrade
    PRs edit the shim too, so a red/neutral would false-positive on them. New `gh.changedFiles`
    seam (best-effort); `frozenPathsTouched` + rendering unit-tested. Shipped, PR #21.
  - **H6 — preview origin: low.** Previews land on `*.pages.dev`, cross-site to the
    `impact-scholars.github.io` journal, so no same-site foothold. Residual for `FORKING.md`: do
    not co-locate the journal and previews on one registrable domain.
  - Two disposable test repos left behind (`oak-h4-test`, PR #35 on the fixture).

(r84)=
- **[R84] The dev.32 manual UX test's three crash-class defects fixed — the [R38] co-located
  rung finally lands, validate always reports, bootstrap stops defaulting a lie.** 2026-08-04,
  engine `7cc1825`.
  Found by the ux-test walkthrough, all three sharing one origin: `bootstrap paper` without `--instance`
  seeded `instance_repo: .` — the co-located claim — into a repo the same render never gives a
  `journal.yml`.
  - **The [R38] resolution chain is now complete.** New `resolveInstanceRoot()` in `cli.ts`,
    shared by `build` + `validate`: `--no-instance` › `--instance` › journal.yml beside the paper
    (the missing co-located rung) › readable error naming `pins.yml` and both meanings of
    `instance_repo`. Until this, a genuine `--co-located` journal's paper CI could never have
    gone green — now *resolvable*, but that tier is still unexercised end-to-end and outside
    `oak conformance`.
  - **A validator is a reporter first, even when it cannot run.** `writeFailureReport()` on both
    the usage-error path and a new `catch` around `runValidate`: usage errors and engine crashes
    now leave a well-formed failing `report.json` (exit codes unchanged), so Stage 2 posts the
    actual reason instead of Stage 1's bare "engine crash" guard line. `check.yml`'s guard is now
    genuinely last-resort — it's a frozen file, so bootstrapped repos see it as drift on next
    `oak upgrade`.
  - **`bootstrap paper` requires `--instance` before any effect** (precedes `repoExists`; zero
    GitHub calls on rejection). `--instance .` stays as the *explicit* co-located opt-in; the only
    legitimate producer of a co-located repo remains `bootstrap journal --co-located`.
  - **Every abort says why.** `makeConfirm` distinguishes explicit "n" from empty-Enter (prompt
    defaults to No); `reason` field on all three aborted results. The plan now declares the
    re-run trap: when `main` is already seeded, bootstrap says it will NOT re-stamp shim or
    `pins.yml` and routes to `oak upgrade` / a PR. Bootstrap still *cannot* repair a wrong
    `pins.yml` — whether `upgrade` should reconcile `instance_repo` (rendered, not frozen) is an
    open design question, deliberately not decided here.
  - 272 tests (+8), tsc clean, re-exercised against the live `uxtest-paper-one` read-only. NOT
    yet proven on real CI — needs a `dev.33` cut + fresh paper repo (the shim→CLI handoff itself
    is unchanged). Five adjacent defects logged in the report, untouched; the load-bearing one:
    bootstrap has no post-condition check (a `validate` smoke run on the seed tree pre-push would
    have caught this class at the source).

(r85)=
- **[R85] CLI output pass — the preflight plan declares every assumption; JSON goes behind
  `--json`; user-facing strings stop speaking design.md.** 2026-08-04, engine `ebf5a2a`. From the same UX-test run as [R84].
  - **Settled principle (user): nothing the CLI assumes may be silent.** Every default or
    resolved value is declared in the plan before `Proceed? [y/N]` — the plan is the product's
    promise, and confirmation is only consent if assumptions are visible. Landed as a
    declared-values block (`declaredValues()`, `bootstrap.ts`) stating each value AND its
    provenance ("the tag you named" vs "newest release right now"); `oak upgrade` got the same.
    Corollary applied: `--owner` is declared only where honoured (suppressed for external
    journals, which get no CODEOWNERS) — declaring an unused value is the same fault as hiding
    a used one.
  - **`--edition` is now REQUIRED for `bootstrap paper`** (the [R84] `--instance` pattern:
    refuse before any effect, error names the journal's `editions/` dir). A defaulted
    `edition: edition` against a real journal is a guaranteed CI compose failure — a trap, not a
    convenience. Still defaulted-but-declared for `bootstrap journal`, where it is
    self-consistent.
  - **`--json` gating**: the result envelope prints to stdout only under `--json`; otherwise a
    human summary on stderr (generic / narrated-for-bootstrap / validate-verdict renderers).
    Safe because the required check found NOTHING parsing CLI stdout — check.yml/check-post/
    conformance all consume `--report`/`--record` files; `ci/run.sh` is a bare `exec`.
  - **Output hygiene**: unknown verbs error with a Levenshtein did-you-mean; usage opens with a
    description + "starting from nothing" pair + grouped verbs; `--external`/`--co-located` get
    plain-sentence help (flags NOT renamed — separate design discussion); git/gh subprocess
    output captured by default, replayed `[git]`/`[gh]`-prefixed on failure, shown on success
    under `--verbose` or `CI=1` (`OAK_VERBOSE` survives the `oak release` child spawn).
  - **De-jargon (CLI strings only)**: no `[S#]`/`[R#]`/"frozen shim"/"instance-config" in
    user-facing output. Seeded template files deliberately untouched — gated on a docs pass
    first (user decision: explanatory text needs a home before it's trimmed).
  - Deliberately NOT done: engine-version echo in bare usage — `package.json` stays `0.0.0-dev`
    across releases, so it would print a version that isn't the pinned tag; the plan declares
    the real one. Adjacent fix: `upgrade --paper <not-a-paper>` no longer dies with a raw
    ENOENT stack. 289 tests (+17, new `cli-output.test.ts`), tsc + bundle clean. Like [R84],
    not yet proven on live CI (same `dev.33` cut covers both).

(r86)=
- **[R86] Repo shape is a first-class question; errors stop being stack traces; `oak start`;
  and one reviewable string surface.** 2026-08-05, branch `build-start-strings` (5 commits off
  `29bccd9`, squash-merged as `285b3f9`). From the second UX-test run —
  the user's headline complaint was `oak build` exploding.
  - **The crash was a shape confusion, not lost data.** `oak build` run in the JOURNAL clone:
    [R84]'s co-located rung reads "a `journal.yml` at the root" as proof of a co-located paper,
    which a journal repo also satisfies, so it waved the run through to a coordinate read that
    threw. Verified against the live repos: the paper's coordinate was intact, the journal's
    myst.yml is the *website* and never had one. **`isJournalRepo()` now discriminates on the
    engine coordinate, not `journal.yml`** — a co-located repo is both shapes and has both files;
    the discriminator has to be the thing only a paper carries. `build` and `validate` (which
    crashed identically, writing stacks into Check Run summaries) both refuse in a journal repo
    and say what that repo does instead.
  - **Building the journal site from the engine was rejected on purpose**: the site needs its own
    `npm install` (the gallery plugin imports `js-yaml`), so an engine-driven `myst build` would
    have shipped a silently gallery-less page — the [R80] failure mode. The refusal points at
    `npm install` + `oak start`.
  - **Two error-surface rules now hold engine-wide.** A `UserError` prints its sentence and
    exits 2, never a stack; anything else keeps the stack behind a line saying it is an engine
    bug. `annotate()` emits `::error::`/`::warning::` ONLY under `GITHUB_ACTIONS`/`CI` and
    escapes newlines there — a raw newline had been truncating multi-line annotations to their
    first line (live bug in [R84]'s own resolveInstanceRoot error). All 9 annotation sites route
    through it; the human-output tests spawn with `CI` cleared, or they would pass locally and
    fail in the engine's own CI.
  - **`oak start` = compose-then-handoff** (`runStart` → myst's bundled `startServer`, no
    shell-out), sharing `build`'s instance resolution so preview and CI read the same
    `myst.oak.yml`. **No Layer-A pre-flight**: a placeholder id must not stand between an author
    and their draft — `validate` is the verb that judges. The watcher recomposes (`watchFile` on
    `myst.yml` → rewrite derived → myst's own reload), else an author edits myst.yml and nothing
    moves. Journal shape → plain myst preview, nothing composed. Local verb only, in no workflow.
  - **`src/messages.ts` is the single reviewable string surface** (user decision: every
    tenant-facing string gets human review, and a generated catalog would drift — the source must
    BE the list). Every such string, grouped by surface, 11 modules rewired; the header lists the
    surfaces that cannot import it (`templates/**`, `plugins/gallery.mjs`, `ci/run.sh`, typst) and
    why `conformance.ts`/`zenodo.ts` stay put, so a review covers 100%. `test/messages.test.ts`
    lints for prose handed straight to an output sink — it caught 11 strings the manual pass
    missed. A lint, not a proof: variable-assembled messages still slip through.
    **Full review is GATED on the docs pass** (user, 2026-08-05): many strings want links to
    documentation that does not exist yet, so wording is not final until the docs pass lands.
  - Stretch: `showWorking` prints/erases the in-flight `gh`/`git` command — a real spinner is
    impossible because `run()` is `spawnSync` and blocks the event loop; Pages first-deploy
    latency folded into the journal runbook. 308 tests (+19, new `messages.test.ts`), tsc +
    bundle clean. Untested: long `oak start` uptime, Ctrl-C teardown, port-collision fallback.

(r87)=
- **[R87] The engine ships as a bundle with no runtime dependencies; `npx oaktree-sapling` becomes
  a download instead of an install.** 2026-08-25, PR #30 (`chore/bundle-only-deps`, merged
  `7bdc23c`). Found while sizing a "quick npx" demo of the freshly published `0.0.1`.
  - **Measured, not assumed.** A cold `npx oaktree-sapling@0.0.1` took >120 s, installed 178 MB
    across 484 packages, and printed 7 `npm warn deprecated` lines before any output. None of it
    was reachable: `dist/cli.cjs` already inlines everything ([R51]). Verified by extracting the
    published tarball into a directory with **zero `node_modules`** and running `validate` and
    `build` end to end — full myst-cli page build, site, exports, a real PDF.
  - **Production was never affected, which is the proof the deps were dead weight.** `ci/run.sh`
    execs `node dist/cli.cjs`; the composite action only checks out the tag. No `npm install` on
    that path ever — so every paper build already ran with no `node_modules`. `test.yml`,
    `conformance.yml` and `cut-engine-release.sh` all use plain `npm ci`, so devDependencies still
    install for them.
  - `dependencies` → `devDependencies`. Cold `npx` 0.0.2: **5 s, 12 MB, 2 packages, no warnings**.
    The tarball is byte-for-byte the same shape (37 files, 2.3 MB) — the win is entirely in what
    npm no longer fetches beside it.
  - **A latent break the move surfaced:** `engineMystRange` read the seeded site's myst range from
    `pkg.dependencies['myst-cli']` and would have thrown on every `oak bootstrap`. Now reads either
    block (npm publishes `devDependencies` verbatim, so it stays readable from an install).
  - Guard: `test/no-node-modules.test.ts` stages the `files` layout in a temp dir, asserts **no
    ancestor** holds a `node_modules` and `NODE_PATH` is empty (without which it proves nothing),
    then drives `validate` with an instance — `--no-instance` yields an empty check list that would
    pass against a hollow bundle. Confirmed red under `--external:myst-cli`.
  - Trade-off accepted: `npm audit`/Dependabot now classify myst-cli's transitive vulnerabilities
    as dev. That code still ships inside the bundle, so the risk is unchanged and only its label
    moves.

(r88)=
- **[R88] "Latest release" means latest STABLE release.** 2026-08-25, PR #31 (merged `745ef86`).
  - `latestEngineRelease()` used `gh release list --limit 1`, which sorts by date and **includes
    pre-releases**. Its two callers write the answer into a tenant's repo: `oak bootstrap` without
    `--engine-version`, and the scheduled `oak upgrade --version-only`. So every dev cut became the
    default engine version for new papers and the bump target for existing ones — a tag
    `RELEASING.md` says is **deleted** when dev releases are pruned.
  - It also silently contradicted that document's own claim ("marked pre-release, so
    `version: latest` never resolves to one") — true of GitHub's `releases/latest` endpoint, which
    the code was not using. Verified live: `gh release list --limit 1` returned
    `v0.0.0-dev.34 isLatest=false isPrerelease=true` while `releases/latest` 404'd.
  - Now resolves through `repos/<repo>/releases/latest`, so the rule lives in GitHub's definition
    rather than being reimplemented. A pre-release stays reachable only by naming it.
  - **Consequence:** a repo can have many releases and resolve nothing, so both messages say *no
    stable release* rather than "no releases" (a lie to someone looking at a page full of dev tags)
    and name the flag. This is why `v0.0.2` had to be cut BEFORE the merge.
  - Guard: `test/release-resolution.test.ts`. A lint, not a proof — the trade `messages.test.ts`
    documents — since driving the resolver needs a network call against a controlled release mix.

(r89)=
- **[R89] The shipped typst is linux-x86_64, and the shim must test that it RUNS.** 2026-08-25,
  PR #32 (merged `40ed04c`).
  - `ci/run.sh` gated on `[ -x ]` — the executable *bit*. `bin/typst` is
    `typst-x86_64-unknown-linux-musl` (one hardcoded asset in `cut-engine-release.sh`, no matrix),
    and a Linux ELF keeps that bit on macOS and arm64. So a tag checked out there **prepended** a
    binary that dies with `Exec format error`, shadowing a working system typst — inverting the
    fallback the line exists to provide. Demonstrated both guards against the same input.
  - CI is unaffected (all 14 workflows here and in the seeded templates are `ubuntu-latest`), which
    is also why it went unnoticed: `bin/typst` is gitignored on `main`, so only a tag leaf carries
    it, and the tag-checkout-on-a-laptop case is the documented "pin a release" model.
  - `RELEASING.md` now states the platform where the tag's contents are described; it was only
    implied by the `engine.zip` re-renderability claim.

## Ratified deltas (2026-08-30 — Pass A opens: the frozen surface)

Item 4's piecewise review begins. Piece P1 is the frozen surface: `templates/paper/.github/**`,
`templates/paper/CODEOWNERS`, `ci/run.sh`, 518 lines. Reviewed against implementation §1,
design §6/§6a/§8, and the ledger entries those files cite. Findings below; the four security
ones merged as PR #39, the four correctness ones as PR #40.

(r90)=
- **[R90] The H2 guard did not close H2, and a comment said it did.** The single most important
  finding of P1, and the reason the review method insists a guard be tested against the bug it
  guards.
  - The untrusted-surface review plan records H2 as **LANDED 2026-08-01** with "the class is
    closed at the template either way". The guard it added validated `head-sha` and `pr-number`
    with `printf '%s' "$v" | grep -qE '^…$'`. **`grep -q` is line-oriented**: it exits 0 if ANY
    line matches, so a two-line value passed. Reproduced locally 2026-08-30:
    `printf 'deadbeef\npr=1 x; echo PWNED'` satisfies `^[0-9a-f]{7,40}$`.
  - `echo "sha=$sha" >> "$GITHUB_OUTPUT"` then wrote both lines. The injected `pr=` never met the
    digits check, and `format('--pr {0}', …)` splices it unquoted into `args:`, which
    `action.yml` splices unquoted into `run: .engine/ci/run.sh ${{ inputs.args }}` — a bash line
    in the job holding `GH_TOKEN` with `checks: write` + `pull-requests: write`.
  - The comment above the guard asserted that "no newline (GITHUB_OUTPUT injection) or shell
    metacharacter can ride through". A confident comment on a wrong guard is worse than no
    comment: it is the reason nobody re-read it for a month.
  - **Rule taken:** a guard added in response to a finding gets a demonstration that it rejects
    the finding's own input, recorded with it. That plan's §H2 LANDED note is amended rather
    than deleted, since the mistake is the lesson.

(r91)=
- **[R91] Stage 2 takes its facts from its own event, not from Stage 1's artifact.** The general
  rule P1 extracted; [R90] was one instance of breaking it.
  - On `pull_request`, GitHub runs the **PR's own copy** of the Stage-1 workflow file, so a fork
    supplies the bytes in the artifact. Stage 2 is trusted and holds tokens. Any value it acts on
    must come from `workflow_run.*` (GitHub-set) or be checked against something that does.
  - The head sha was in the artifact and did not need to be: `workflow_run.head_sha` is the same
    value. Removed from `check.yml`'s stash and from `check-post.yml`'s read. Besides the
    injection, this closed a **forged-verdict-on-another-PR** path: `--sha` was the Check Run
    target, `--verified-head` was passed alongside it and used ONLY for the frozen-shim advisory
    ([R83], `cli.ts:829`), never compared to `--sha`. So a fork could aim a passing "Journal
    checks" Check Run at an unrelated PR's head. This is H1 with a cheaper primitive: no need to
    repoint the engine, just write a different sha.
  - The PR number cannot follow the rule (`workflow_run.pull_requests` is empty for forks, [R26]),
    so it keeps two checks: shape against the **whole** string, and ownership — the API is asked
    which commit that PR heads at, and it must be this run's commit.
  - **Left open:** Stage 1 still *authors the report content* Stage 2 posts, so a fork can write a
    passing verdict. That is H1's remaining half. It is a design question (the verdict is computed
    in the untrusted half by construction), not a patch, and it means the Check Run should not be
    the only thing between a PR and `main`.

(r92)=
- **[R92] CODEOWNERS gates code sources, and `paper-environment.yml` is one.** `action.yml` runs
  `setup-micromamba` with `environment-file: paper-environment.yml` for **every verb**, including
  `deposit prepare`, `release` and `upgrade`, none of which need Python. Installing a conda
  package runs its hooks, in the job holding `ZENODO_TOKEN` and a write `GH_TOKEN`. The file sat
  at the repo root, ungated, while CODEOWNERS' own comment claimed to gate everything that could
  "redirect a token-bearing run to unreviewed code". Now gated.
  - **Not fixed, deliberately:** the micromamba step still runs for verbs that cannot need it.
    Narrowing it is the better fix and risks breaking a paper that depends on the environment
    existing; it wants its own change. Also note a gated file that is not a *frozen* file gets no
    `frozenPathsTouched` advisory ([R83]), so an editor sees the review request but no banner.

(r93)=
- **[R93] `ref.ts` is unwired, and `action.yml` claimed otherwise.** `classifyRef`/`decideRef`
  implement [R196] / [R41]'s ref-class policy, are unit-tested, and **have no callers** anywhere
  in `src/`. `action.yml` stated the policy was "enforced by `oak validate` inside the engine".
  It is not, and it could not be where it stands: `oak validate` is engine code at the ref being
  judged, and no token-bearing workflow invokes it at all. The only real constraint is
  `run.sh`'s `dist/cli.cjs` check ([R57]) — a runnable engine ⟺ a release — which is a file test,
  not a ref-class test. Comment corrected to say what is actually true. Wiring the policy in
  front of the checkout means it cannot be engine code; that is the open design question.

(r94)=
- **[R94] Concurrency keys need the head repo, in both stages.** Stage 2 keyed on
  `head_repository.full_name` + `head_branch` with a comment explaining why; Stage 1 keyed on
  `github.head_ref` alone. Two forks on a branch named `main` cancelled each other, and the PR
  group `ci-main` also collided with the **push-to-main** group, so opening a fork PR from `main`
  cancelled an in-flight Pages deploy. A cancelled Stage 1 uploads no artifact, so Stage 2's
  `conclusion == 'success'` guard fails and the PR waits on a merge gate that can never arrive.
  Fixed in `ci.yml` and `check.yml`; §1b's snippet carries the same defect and is amended with it.

(r95)=
- **[R95] `a && b || c` returns `c` when the secret `b` is unset.** `prepare.yml` selected the
  Zenodo token with `inputs.sandbox && secrets.ZENODO_TOKEN_SANDBOX || secrets.ZENODO_TOKEN`. An
  unset secret is the empty string, which is falsy, so a tenant who had set only `ZENODO_TOKEN`
  and dispatched with `sandbox: true` transmitted the **production** credential to
  `sandbox.zenodo.org` — on the run that exists to be a rehearsal, and across the prod/sandbox
  line [R29] calls hard. Now refuses with a named cause. The record shipped the same expression
  in §1d, so the fix is in both places.

(r96)=
- **[R96] `deposit` needs the instance and was not getting it.** `ci/run.sh`'s clone list was
  `build | release | deploy-preview | validate`. `prepare.yml` runs `deposit prepare`, so
  `instanceRoot` was null and `loadJournalZenodo(null)` returned empty defaults: every DOI draft
  reserved from CI lost the `zenodo.community` and `description_blurb` that [R19] moved out of
  the hardcoded Python. Silently, with no warning, corrected only later if `oak release` (which
  does get `--instance`) overwrote the metadata. `deposit` added to the list.

(r97)=
- **[R97] `[R14]`'s "fail loudly" covers both values feeding the checkout.** `action.yml` guarded
  the engine *ref* with an explicit empty/null check and read `engine_repo` four lines below with
  a bare `yq '.engine_repo'`. `yq` prints the literal `null` for a missing key, so a mis-rendered
  or hand-edited `pins.yml` produced `repository: null` and exactly the "baffling downstream
  checkout error" the guard above it exists to prevent. Now guarded.

(r98)=
- **[R98] The record's §1 enumeration is three files stale, and nothing noticed.** §1 says the
  shim is "five frozen files" and lists the action, `ci.yml`, `preview-deploy.yml`, `prepare.yml`,
  `publish.yml`. Eight are stamped: `check.yml`, `check-post.yml` and `version-bump.yml` are also
  frozen, since `upgrade.ts:78` re-copies everything under `.github/` plus `CODEOWNERS`.
  `version-bump.yml` runs on a `schedule` with `contents: write` + `pull-requests: write` and
  appears in no design record at all. §1d additionally specifies a required `version` input that
  `prepare.yml` does not have and `cmdDeposit` does not read — there the **code** is right (the
  version is the tag, and enters at `oak release`), so §1d is amended, not the shim.
  - The enumeration is what a reviewer and the upgrade author check against, so being wrong here
    costs exactly the fleet-wide re-copy P1 is reviewed first to avoid.

(r99)=
- **[R99] Nothing tests the frozen workflows, which is how [R90] survived.** The whole 518-line
  frozen surface has no behavioural test: `template.test.ts` asserts the stamped file *set* and
  the `.gitignore` rename, and nothing asserts what any workflow *does*. 346 tests were green
  across the month H2 was believed closed. Not fixed here — the useful shape is probably a shell
  test over the guard steps plus a live probe, and it wants its own change — but recorded, because
  "green CI" was doing no work at all on the highest-blast-radius files in the repo.

**Documentation change taken with these:** the frozen workflows stopped carrying their own
rationale in comment blocks. `docs/design/paper-ci.md` (the first page under `design/`, where the
ledger is headed anyway) now holds the two-stage argument, the [R91] trust rule, what constrains
the engine ref, what CODEOWNERS gates and why, and the [R94] key reason. The workflows carry a
short statement plus the URL, per `STYLE.md` ("a comment explaining a long rationale becomes a
link or an ID"). This bakes a `scholar.nexus` URL into seeded tenant files, which 404s until the
canonical move — and it adds the seeded workflow headers to the coordinates that move must sweep.

## Ratified deltas (2026-08-30/31 — Pass A: the deposit chain and the git/gh edge)

Pieces P2 (`zenodo.ts` + its tests) and P3 (`gh.ts`). Fixes merged as PRs #41 and #42. Each
fix ships with a test that was run against the UNFIXED code first, per [R90]'s rule; where a
finding is left open it says so and why.

(r100)=
- **[R100] A near-miss lookup mints a second concept DOI.** `findDeposit` gated its unfiltered
  scan on whether the targeted queries returned ROWS, not on whether they FOUND the identifier
  (`anyItems ||= items.length > 0`). `q=related.identifier:"…"` is an ElasticSearch phrase match,
  so a deposit carrying `urn:oaktree-sapling:foo-bar-baz` comes back for a query about `foo-bar`
  and then fails `matchRelated`'s exact compare. Paired with a github query that misses because
  the repo moved (the case [R7] added the URN for), the scan was skipped, `findDeposit` returned
  null, and `cmdPrepare` created a second concept DOI for a paper that already had one. That is
  precisely the [R20] failure the scan exists to prevent, reintroduced by the guard added for it.
  - The comment said it mirrored the python's `if not items:`; the python binds `items` to ONE
    query's result. The code was neither the python's shape nor its own comment's. Third instance
    in this review of a comment asserting a property the code did not have.
  - Now gated on "not found". The extra cost falls only on the near-miss case, which is the bug.

(r101)=
- **[R101] Nothing may be sent to Zenodo before the working tree is judged.** `cmdPublish` called
  `buildBundle` AFTER `updateMetadata`, and the `deposit/` reserved-name check lived inside
  `buildBundle`. `BundleCollisionError`/`TemplateArchiveError` extend `Error`, not `UserError`, so
  `cli.ts` classified them as engine bugs. An author adding `deposit/paper.pdf` therefore got
  nothing at PR time, then on the release tag a draft overwritten with v-tag metadata, no files,
  and a stack trace. Preconditions now resolve first and return through the result envelope.
  - ⚑ **[R28]'s actual rule is still not implemented.** It says the collision is a VALIDATE error;
    `validate.ts` has never known about `deposit/` or `RESERVED_BUNDLE_NAMES`. This fix makes the
    late discovery harmless, not correct. Belongs with the `validate.ts` piece.

(r102)=
- **[R102] The environment picks the secret, in every verb.** `oak deposit --sandbox` read
  `ZENODO_TOKEN` unconditionally while `oak release` picks `ZENODO_TOKEN_SANDBOX` by DOI prefix.
  CI was unaffected (`prepare.yml` chooses and passes the result), so this was a local-only
  wrong-credential-to-wrong-host bug: the same shape as [R95], one layer down, found because
  [R95] taught us to look for it.

(r103)=
- **[R103] `--source-ref` ran arbitrary commands on the editor's machine.** `git fetch <url> <ref>`
  takes both positionally and git parses options positionally, so
  `--upload-pack=<command>` RUNS that command. **Demonstrated against real git, not inferred.**
  These values come from an author's submission and an editor pastes them, so this executed on a
  workstation holding the primary `GH_TOKEN` and, during `oak bootstrap`, the Zenodo and
  Cloudflare secrets. `--from` reached the same place via git's `ext::` transport.
  - Both are now validated against the two transports actually supported, before git sees either.
    A URL carrying credentials is REFUSED rather than stripped, because `--from` is copied verbatim
    into a public commit message and PR body.
  - The general lesson, worth more than the fix: an argv array stops the SHELL, not the callee's
    own option parser. Every place the engine passes a tenant-supplied value positionally to
    `git`/`gh` needs the same reading.

(r104)=
- **[R104] Secrets must not travel in argv, and a child's stderr must not travel to a PR.**
  - `gh secret set … --body <token>` put `ZENODO_TOKEN` and `CLOUDFLARE_API_TOKEN` in
    `/proc/<pid>/cmdline` and into process accounting. `run` already accepted stdin and `sticky`
    already used it for comment bodies; now `setSecret` does too.
  - Node concatenates a CAPTURED child's stderr into the thrown error's `message`, and
    `preview.ts` posts that message into a public sticky comment. wrangler names the Cloudflare
    API path it called on failure, and that path contains the account id. Actions' log redaction
    does not reach a comment body. stderr is now inherited (so the run log gets it, redacted) and
    the comment carries a fixed sentence.

(r105)=
- **[R105] `gh.ts` had no test file, and now has one.** It is the module holding every irreversible
  GitHub effect. The new tests assert the ARGUMENT VECTORS, which is where three of the four
  defects actually lived, and use the source-lint idiom `release-resolution.test.ts` established.
  All three lints fail against the unfixed code.

(r106)=
- **[R106] The suite does not guard what the record calls guarantees.** Established by mutation,
  not opinion: on `zenodo.ts`, deleting the `updateMetadata` call from the publish path outright
  leaves every test green. That call IS [R22], the one guarantee the record asked the port to
  keep. Four more mutations survived: reversing the newest-version sort, disabling the concept-DOI
  sanity check, letting publish reuse an already-published deposit, and restoring [R100]'s bug.
  - Consequence for this review: a "confirmed" verdict backed by a green suite is weaker evidence
    than it looks. This is [R99] again in a different room, and the two together say the problem is
    general rather than local to the frozen surface.
  - **Rule taken (user, 2026-08-30):** every Pass A fix ships with a test demonstrated to fail
    against the unfixed code. Applied from [R100] onward.

### Open queue from P2 and P3

Recorded here because they are real, evidenced, and not yet fixed. None is as severe as the
entries above. Grouped by the piece that will own the fix.

(r107)=
- **[R107] `zenodo.ts`, open.** (a) [R22]'s overwrite guarantee is uncovered ([R106]).
  (b) `resolveTemplateDir` claims to mirror `myst-templates`' `resolveInputs` and does not gate on
  a `template.yml` the way myst does, so a `template:` myst resolves as a registry name can be
  archived as "what rendered the PDF"; the deposit's whole claim is reproducibility.
  (c) `engine.zip` is a `git archive HEAD` and nothing asserts it contains `bin/typst` or
  `dist/cli.cjs`, both gitignored on `main`, so any non-tag ref deposits a hollow archive beside a
  provenance file naming a typst version that is not in it. (d) publish silently deposits with no
  abstract when there is no build artifact, which is the [R22] overwrite becoming a downgrade.
  (e) `sandbox` and the API host are independent inputs with no invariant tying them, and the
  tests normalise the mismatch by constructing hosts of `'x'` with `sandbox: true`.
  (f) author-controlled filenames reach the upload URL unencoded, so `deposit/data?v2.csv` both
  truncates and appends to the query string carrying the access token.

(r108)=
- **[R108] `gh.ts`, open.** (a) `versionTags` catches an API failure and returns `[]`, which
  `runNewVersionReminder` reads as "never published": a rate limit turns a published paper into a
  first deposit and the editor loses the reminder [R69] hardened around. (b) `sticky` returns
  silently when `originRepo` misses, and `check-post` then reports `commentPosted: true` for a
  comment it did not post, which is the green-check-no-comment failure [R69] refuses. (c) `openDoiPr`
  runs `gh pr create` with neither `--repo` nor `cwd` while its git calls use `-C repoRoot`, so
  `oak deposit prepare --paper <elsewhere>` opens the PR against the current directory's repo;
  `realUpgradePr` records the fix for this eight lines away. (d) the DOI PR branches from whatever
  HEAD is, so dispatching `prepare.yml` on a feature branch produces a "one-file" PR carrying that
  branch's whole divergence. (e) re-running `prepare` reports the DOI PR step as failed, for an
  operation §13 calls idempotent. (f) `ghOk` cannot distinguish 404-already-gone from 403-forbidden,
  so `conformance reset` reports a clean teardown it did not perform, undermining the repeatability
  floor it exists to provide; its comment claims the narrow property. (g) three list endpoints are
  unpaginated, one of which backs the [R83] frozen-shim advisory, so that advisory fails open
  silently on a large diff.

(r109)=
- **[R109] `wrangler@latest` is fetched at run time into a token-bearing process.** `npx --yes
  wrangler` resolves whatever npm serves, in the job holding `CLOUDFLARE_API_TOKEN` and inheriting
  `GH_TOKEN`. Every other third-party executable in this system is pinned: actions by full commit
  SHA, typst by `typst.version`, the engine by ref. Nobody recorded agreeing to this one floating.
  Pin it, or vendor it.

(r110)=
- **[R110] A `gh` failure mid-bootstrap leaves a public repo half-provisioned, and says so with a
  stack.** `run` throws a plain `Error` on any non-zero exit and `bootstrap.ts` has no `try`/`catch`
  at all, so a 403 at `enablePages` or `createRuleset` (a personal account, a rate limit) leaves a
  PUBLIC repo carrying author content with no protect-main ruleset, no tag rule and no secrets,
  while the accumulated action list is discarded. There is also no `gh --version` / `gh auth status`
  preflight anywhere, so a tenant's first `oak bootstrap` on a machine without `gh` dies with a raw
  ENOENT before the plan is even printed. Belongs with the `bootstrap.ts` piece.

## Ratified deltas (2026-08-31 — Pass A: the release and certification chain)

Piece P4: `conformance.ts`, both release workflows, `cut-engine-release.sh`, `RELEASING.md` and
the release-state test helpers. Fixes merged as PR #43. This is the machinery that certifies
everything else, so its failures are false greens everywhere, which is what the first one is.

(r111)=
- **[R111] A conformance run that certified nothing reported green.** `INCONCLUSIVE` was exit 2,
  which is also the CLI's generic usage/`UserError` code, and the workflow was
  `[ "$CODE" = "1" ] && exit 1 || exit 0`: every code but 1 passed. Demonstrated
  (`conformance certify --repo "" --tag v1` → usage line, exit 2, no `cert.json`). The record
  step is gated on `hashFiles('cert.json')`, so the non-event left no trace either.
  - Reachable by an unset `CONFORMANCE_FIXTURE_REPO`, which is what a fresh fork or the canonical
    move produces. [R78]'s post-cut hook fires this on every cut, so "release ⟹ certified" would
    have held vacuously and permanently, green each time.
  - `INCONCLUSIVE` now has its own code, anything unrecognised reddens, and a missing record
    reddens on its own: a run that reached no verdict is not a passing run.

(r112)=
- **[R112] The cut could break "a runnable engine ⟺ a release" from two directions.**
  - `git add -f dist/cli.cjs bin/typst` writes the DEVELOPER's index and is undone four lines
    later with nothing in between to survive an interrupt. Left staged, the next ordinary commit
    puts them on a branch, and since the shim's guard is a file-existence test ([R93]), that
    branch is then a runnable engine ref. Now trapped on any exit.
  - The tag was pushed before `gh release create`. A transient `gh` failure left a runnable tag
    with no Release *and* spent the version, since the clobber guard refuses a re-cut and a real
    release is never re-cut. The tag is now removed if the Release does not follow.
  - Two gate steps could not fail: the cut never typechecked (esbuild strips types, and the
    workflow that does typecheck is deliberately not a required check), and `build:fixture`
    printed "(not produced)" and exited 0, so the one step aimed at the green-but-empty class
    ([R67]) could not fail for it.

### Open queue from P4

(r113)=
- **[R113] `conformance.ts`, open.** (a) Every part assertion is "poll until it appears", and
  `null` means both "pending" and "never existed", so an absent part times out as a
  `ThirdPartyError` and reports INCONCLUSIVE. The green-but-empty defects [R78] was built to
  catch are therefore indistinguishable from a slow runner. (b) `ThirdPartyError` is constructed
  in only two places, neither a `gh` failure, so a GitHub API 403 or 502 is attributed to us and
  reddens, though the code's own comment names the GitHub API as the archetypal third party; this
  is a plausible mechanism for the "cert is a bit flaky" symptom [R78] records. (c) Nothing
  verifies the fixture ends up pinned to V, so a regression in `oak upgrade`'s pin write, the
  dogfooded path under test, would still certify. (d) Tolerant deletes cannot tell "already gone"
  from "forbidden" ([R108]f), so `reset` reports a teardown it may not have performed and the
  next run's baseline is unknown. (e) A skipped fork phase is invisible in the verdict's status
  while the workflow header claims every trigger class. (f) The deposit check compares five
  FILENAMES while two comments claim it compares "the exact deposited bytes".

(r114)=
- **[R114] A real `vX.Y.Z` is every tenant's default pin before its verdict exists.** The cut
  marks `--prerelease` only for versions containing `-`, so a real release enters
  `releases/latest` immediately, which is what `oak bootstrap` and the scheduled
  `oak upgrade --version-only` resolve ([R88]). Certification is a post-cut `workflow_run` behind
  a required reviewer. Dev cuts are safe (pre-release, excluded), so this is latent until the
  first real release, which is also when C5 was to land. Decide before that cut.

(r115)=
- **[R115] `RELEASING.md` has drifted in four places.** It names `package.json`'s version as a
  literal that is now wrong (fixed by removing the literal); its `files` enumeration is narrower
  than the allowlist; its prune snippet's comment says "oldest-first" of a newest-first listing
  and reads the title column rather than the tag; and it claims the local pre-check is "exactly
  what the cut gates on", though locally the canary is conditional on whatever typst is on PATH,
  which on the author's machine is a different version from `typst.version`.

## Ratified deltas (2026-08-31, round 2 — Pass A: the merge gate, and a live cert)

Piece P5: `validate.ts` + its two test files, the module carrying more ledger citations than any
other. Plus the first live conformance run since the harness was built, which produced a finding
no amount of reading had. Fixes in PR #44.

(r116)=
- **[R116] A gate that cannot load its policy must not pass.** `loadJournal` returned
  `JournalConfig.parse({ name: 'unknown' })` when `journal.yml` was absent from a RESOLVED
  instance root. That yields `id_sentinel: undefined`, `id_pattern: undefined` and `checks: []`,
  so `checkIdShape` passes any id and Layer B runs nothing. Silently: no error, no warning, no
  note. Verified on one paper, changing only the journal config:

  | | exit | status | errors |
  |---|---|---|---|
  | with `journal.yml` | 1 | error | `id-shape` |
  | `journal.yml` removed | 0 | ok | none |

  - So a paper still carrying the template's placeholder id merged green. Reachable in CI, where
    `run.sh` clones whatever `pins.yml` names: a restructured or wrong instance repo clones fine.
  - [R82] requires a degraded run to say so, and the asymmetry shows the silence was unintended:
    a missing `registry/papers.yml` warns, and a MALFORMED `journal.yml` already fails closed.
    Only the missing file was silent.
  - Now a blocking `journal-config` finding. `--no-instance` stays silent: that is a tenant
    choice, not a broken instance, and conflating the two is what produced the hole.

(r117)=
- **[R117] Reset must sweep what the run itself creates.** Found by the first live cert run
  (2026-08-31). The install phase dogfoods `oak upgrade`, which opens `oak/upgrade-<tag>`; reset
  swept `cert-*` branches and `conformance`-labelled PRs. Neither matched, so a second certify of
  a tag died on "a pull request for branch oak/upgrade-v0.0.2 already exists" and reported FAILED,
  attributing leftover state to the engine, while reset printed "already clean (no-op)" one line
  above. **Certify was a once-per-tag operation.**
  - The label is not a reliable handle: conformance labels the PR it opens, but an upgrade PR
    from any other source (the scheduled bump, a human) carries `editor-action-needed`, which is
    what the live blocker had.
  - Reset now sweeps both prefixes; deleting a branch closes its PR. `UPGRADE_BRANCH_PREFIX` is
    exported from `upgrade.ts` so the two cannot drift, asserted by a test.
  - This is [R113]b's misattribution shape arriving live. P4 predicted it from the source; the
    run supplied the mechanism.

(r118)=
- **[R118] What `oak validate` does NOT enforce, though the record says it does.** Four claims,
  all grep-verified against `src/`. Recorded together because the pattern matters more than any
  one of them: "enforced elsewhere" has now been wrong four times in one module.
  - **[R28]** the `deposit/` reserved-name collision, a *validate* error in the record, implemented
    only in `zenodo.ts` at release time ([R101]).
  - **[R41] / [R196]** the engine ref-class policy: `classifyRef`/`decideRef` have one importer,
    their own test ([R93]). [R196] still sits in design §11's SETTLED table as if enforced.
  - **[R46]b** "validate asserts every registry entry resolves to a real repo with a DOI". The
    registry is loaded and used only for id-uniqueness; `doi` does not appear in `validate.ts`.
  - **[R189]** "bootstrap/validate enforce public". `bootstrap.ts` does; `validate.ts` has no
    visibility concept at all.

### Open queue from P5

(r119)=
- **[R119] `validate.ts`, open.** (a) A tenant can disable the Layer-A id invariant by deleting
  two optional `journal.yml` keys: both are `.optional()`, and absent means "no rule" rather than
  "no policy", so the engine's own contract becomes tenant-editable, silently. The template
  scaffolds both, so it takes a deliberate edit. (b) `checkLayerDisjointness` enumerates three
  fixed paths and ignores each layer's own `extends:`, so one line of indirection in an instance
  layer hides a real key clash; verified end to end. Either recurse, or make a layer carrying
  `extends:` the finding. (c) `--strict` sets `exitCode` from warnings while `status` and
  `checkRun.conclusion` come from errors alone, so a strict run with only warnings exits 1 while
  reporting success. Latent: `check.yml` passes no `--strict`, and its gate reads the conclusion.
  (d) The failure-report envelope writes `errors: string[]` where the success envelope writes
  `NamedFinding[]`; inert today, and `validate.integration.test.ts` already papers over it.
  (e) The module header claims IO is injected; three readers `readFileSync` after an injected
  existence probe, which the new test had to work around.

(r120)=
- **[R120] First live cert since the harness was built: CERTIFIED.** `v0.0.2` on
  `pollomarzo/fixture-paper-repo`, all four trigger classes green (`push-main`,
  `preview-same-repo`, `deposit`, `preview-fork`), including a real Cloudflare preview from a
  fork PR and a full deposit bundle on the fixture Release. Worth recording because [R78]'s
  harness had never been run against a STABLE tag before, and because it establishes that the
  earlier failure was entirely [R117]'s leftover state and not the engine.

## Ratified deltas (2026-08-31, round 3 — Pass A: bootstrap and provisioning)

Piece P6: `bootstrap.ts` (the largest module), its tests, and `template.test.ts`. The piece whose
failures land on public repos that already hold an author's content. Fix in PR #45; the rest is
queued below and is the largest backlog in the review.

(r121)=
- **[R121] An author workflow could survive onto the review branch.** `git checkout <tree> -- .github`
  overwrites the paths that tree HAS and leaves the rest, so ingest restored main's `.github/` over
  the author's without deleting what main lacks. Reproduced against real git: an author repo
  carrying `.github/workflows/evil.yml` beside a poisoned `ci.yml` yields a review tree with
  `ci.yml` correctly frozen and `evil.yml` still present.
  - The narrow claim held (an author cannot supply `pins.yml`; main always has that path). The
    docstring's general claim did not.
  - That branch is pushed to the BASE repo with the operator's credentials, and ingest runs before
    `applyProvisioning` and `applySecrets`, so on a fresh bootstrap it lands on a public repo
    before protect-main exists; in an org with inherited secrets an `on: push` workflow reaches
    them. Fixed by deleting before restoring.
  - **`buildReviewTree` is a pure MODEL of this invariant with no callers** — the third dead model
    function in this review, after `ref.ts` ([R93]) and [R28]'s collision check. Nothing kept the
    shipped path honest to the model, and the fixture gave main a SUPERSET of the author's
    editor-controlled paths, so deleting the filter left the whole suite green.

### Open queue from P6 — the largest in the review

(r122)=
- **[R122] The DOI flow fails on every fresh repo.** §5 records, from a live run ([R67]), that
  `can_approve_pull_request_reviews: true` must be set or `gh pr create` fails with "GitHub Actions
  is not permitted to create or approve pull requests", even with `pull-requests: write`. Zero
  occurrences in `src/`; no `Provisioner` seam; the printed runbook never mentions it. Deterministic
  on the first real DOI reservation.
(r123)=
- **[R123] `zenodo-publish` has no required reviewers.** §5 lists them and `publish.yml:21` says
  "provisioned by bootstrap"; `upsertEnvironment` PUTs only a branch policy. `conformance.ts:484`
  already tolerates the absence (`if (publishRun.status === 'waiting')`), so the harness never
  certifies the gate. The control that DOES exist is tag-creation restriction, which is a different
  thing: it stops an author cutting `v1.0.0`, not a human standing in front of a token-bearing run.
(r124)=
- **[R124] The "author collaborator invite" checklist item is unimplemented and unmentioned.**
  §5 lists it as a bootstrap step; there is no collaborator seam anywhere in `src/`, no input
  carries an author, and the printed runbook never raises it.
  - ⚑ **Narrower than it first looks, and the first draft of this entry overstated it.** The
    record describes TWO tiers and only one of them wants push: design §8 says "authors are
    `push`", but the same section says that on the repo=journal personal-account tier "external
    contributors fork by default, and push can't be granted to drive-by contributors", and §5
    notes the notify flow "works today only because ISP authors are push collaborators; in the
    fork-dominated lab tier it would fail on every external PR". The whole two-stage split (§6a)
    exists so the fork path works WITHOUT push. So an ingested author is not locked out; they take
    the fork path, which is the designed path for that tier.
  - What is actually wrong: a checklist item nothing implements, and an ingest flow that leaves
    the editor with no prompt about author access either way. The fix is plausibly a runbook line
    plus a decision recorded per tier, not a collaborator seam.
(r125)=
- **[R125] Thirteen ordered provisioning steps, no `try`/`catch` anywhere.** Any failure leaves a
  partial public repo and prints a stack, discarding the `actions` map that records what completed.
  Worst residues: a throw at the second ruleset leaves `v*` tags unrestricted, so anyone with write
  can trigger `publish.yml` and the Zenodo token; a throw during the secret loop sets some secrets
  and prints no runbook. There is also no `gh --version` / `gh auth status` preflight.
(r126)=
- **[R126] `renderCodeowners` cannot express two owners, and `oak upgrade` reverts the second.**
  The regex replaces everything after the path with one token, and `ownerFromCodeowners` reads only
  the last token of the first gated line. Verified: a tenant who adds `@org/editors @alice` gets
  CODEOWNERS reported as drifted on every upgrade, and the files-only resync removes the extra
  owner. Fleet-wide, and it reverts the tenant's own hardening.
(r127)=
- **[R127] Smaller P6 items.** (a) `--private` on a free personal account deterministically 403s at
  ruleset creation, AFTER the repo is seeded and the PR opened, and nothing warns. (b)
  `upsertEnvironment` is the only non-GET-then-act step, and its unconditional PUT would clear
  reviewers added by hand, while the plan invites re-running. (c) Seeded repos carry no LICENSE
  while `edition.yml` asserts `CC-BY-4.0` to readers and to Zenodo. (d) `createLabel` swallows
  every error, and two consumers hardcode the label names independently. (e) `seedBranch` on a
  pre-existing repo whose default branch is not `main` seeds `main` as a child of it and leaves
  `default_branch` alone, so protect-main guards a branch nothing merges to. (f)
  `--zenodo-token` is accepted and silently discarded by `bootstrap journal --external`. (g) No
  bypass on `protect-main` means a solo editor cannot merge their own `.github/` PRs, which is the
  repo=journal tier. (h) `actor_id: 5` is an unexplained magic number on the one bypass path never
  verified live. (i) `bootstrap.ts:418` cites "PROVISIONING §3.3", which does not exist.
(r128)=
- **[R128] Four mutations survive `bootstrap.test.ts`.** Flipping `require_code_owner_review` to
  false; forcing every paper repo private; dropping `update`/`deletion` from the tag ruleset;
  renaming a label. The fake `Provisioner` records calls but the assertions are almost all
  `toHaveLength`, so WHAT was provisioned is untested, and no test exercises a throwing provisioner
  at any of the thirteen steps.

## Ratified deltas (2026-08-31, round 4: P6 backlog group 1, broken now not latent)

The three P6 findings that fail on a fresh repo today, cleared as PR #46 (branched from `main`,
no overlap with #45). Every fix carries a test that was run against the UNFIXED code and seen to
fail, by re-introducing the defect: drop the Actions-permission block (1 failure), restore the
unconditional reviewer-less `upsertEnvironment` (3 failures), restore the single-token
`renderCodeowners` + last-token `ownerFromCodeowners` (2 failures).

- **[R122] CLOSED.** `Provisioner` gains `actionsCanApprovePrs` / `allowActionsApprovePrs`
  (GET-then-act, real impl in `gh.ts`), called from `applyProvisioning`. The PUT to
  `actions/permissions/workflow` replaces the whole settings object, so it reads
  `default_workflow_permissions` back and sends it along; without that, turning the PR
  permission on would silently reset a tenant's token default to `read`.
- **[R123] CLOSED, with a decision the record had left open.** `upsertEnvironment` now takes
  reviewers, and a new `environmentReviewers` GET means a re-run never clears one added by hand
  (that also removes [R127](b)'s hazard on this step; the branch-policy fields are simply not
  re-PUT when reviewers already exist). Who is named:
  - org tenant with `--owner @org/team`: the team, via the existing `teamId`.
  - **personal-account tenant: the CODEOWNERS owner user**, via a new `userId`. GitHub permits
    self-approval, so this is a deliberate click rather than a second pair of eyes, but it still
    stops an unattended token-bearing run. The alternative considered was to leave the gate open
    on a personal account and say so; rejected because that silently contradicts §5 and
    `publish.yml`'s claim for the repo=journal tier, which is exactly the class of drift P1 found.
  - `--owner` naming an organisation with no team: nobody, since an organisation is not a
    reviewer GitHub accepts. The environment is still created; the run logs a `!` line and adds
    a runbook entry naming the settings URL. `applyProvisioning` therefore returns runbook lines
    now, merged ahead of `applySecrets`' at both call sites.
  - **The conformance tolerance STAYS.** `conformance.ts`'s `if (publishRun.status === 'waiting')`
    keeps its conditional shape, now with a comment saying why: the harness certifies the CI a
    version stamps, not a tenant's repo settings, and the standing fixture was provisioned before
    this change, so asserting `waiting` would fail cert runs for something that is not the
    engine's doing. The gap [R123] named (the harness never certifies the gate) is therefore
    still open, and wants a C-slice assertion over `environmentReviewers` rather than an
    inference from run status.
- **[R126] CLOSED.** The owner column is carried **per path**, not as one token. New
  `codeownersColumns` (bootstrap.ts) lifts `{path: owner column}` off a CODEOWNERS file;
  `renderCodeowners` takes that map and writes each gated line's column back, falling back to
  `answers.owner` for a path the repo does not have; `ownerFromCodeowners` returns the whole
  column of the first gated line rather than its last token; `computeDrift` and `resyncFiles`
  read the repo's own columns and pass them through `renderFrozenFile`. A path-keyed map rather
  than a single string on purpose: an owner added to `/.github/` alone must not be spread onto
  `/CODEOWNERS`, which would widen who can approve a change to the gate itself.

## Ratified deltas (2026-08-31, round 5: P6 backlog group 2)

The rest of the P6 queue the review ratified for this group, cleared as PRs #47 (bootstrap:
[R125], [R127]a/b/f) and #48 ([R108]a, [R119]c), both branched from `main`. Every fix ships
with a test that was run against the UNFIXED code first, and every two-halved fix had each
half proved independently by mutation: stop-at-first-failure (2 tests), record-then-rethrow
(6), the ingest chain not gated on a seeded main, no early return on an uncreatable repo, the
environment never PUT with no reviewer to add (caught by an existing [R123] test), `planPrivate`
printed unconditionally, the secret refusal widened to env values, the preflight moved after
the release probe, `--strict` status and conclusion each reverted alone, the `versionTags`
swallow restored with the reminder catch kept, and the reminder catch removed with the swallow
kept. Suite on this machine: 378 on `main`, 390 and 381 after.

- **[R125] CLOSED.** A `stepRunner` runs every provisioning step and records a throw instead
  of propagating it: `actions[step] = 'failed: <first line>'`, a `✗` log line, a runbook line
  saying what to do, and the run returns `status: 'incomplete'`, exit 1, with a `failed` list.
  Two orders, one principle (what the tenant needs is the whole picture, not the first
  exception): the eight settings steps (team grant, both rulesets, Pages, the Actions-PR
  permission, the zenodo reviewers, the branch policy, labels) are independent and idempotent,
  so all are attempted and each failure is reported beside the successes; the content chain
  (create, seed, ingest, PR) is a dependency chain, so a failure skips its dependants, and a
  repo that cannot be created is fatal, but returns the same envelope rather than a stack.
  `status: 'incomplete'` rather than `'error'`, deliberately: the repo exists and part of the
  settings exist, and `narrated()` prints the full recap for any non-ok status either way.
  Secrets are stepped per secret, so one GitHub refuses lands in the by-hand list without
  swallowing the three after it.
  - The `gh --version` / `gh auth status` preflight [R110] asked for is in too
    (`assertGhReady`, gh.ts), called at the top of `cmdBootstrap` BEFORE the engine-release
    probe: a missing or logged-out gh was reaching the tenant as a raw ENOENT or as the
    "no stable release" message, which sends them chasing the wrong cause.
- **[R127]a CLOSED.** `--private` prints a `!` plan line before the confirm: on GitHub's free
  plan a private repo cannot have rulesets or Pages, so those steps fail late (403), after the
  repo and its content are already in place. Warned rather than refused because a paid account
  is unaffected and the CLI cannot know the plan; the line names both.
- **[R127]b CLOSED.** The zenodo-publish environment PUT carries the whole environment, so a
  re-run that had no reviewer to add (an org owner naming no team) re-PUT it and cleared any
  field a tenant had set by hand, while the plan invites re-running. An existing environment
  is now left alone unless a reviewer is actually being set; a first run still creates it,
  because the v* branch policy needs it to exist (that half is guarded by the existing
  [R123] no-reviewer test).
- **[R127]f CLOSED, both halves.** (1) The preflight above. (2) A TYPED secret flag on
  `bootstrap journal --external` is now a usage error (exit 2), following the `--no-site` +
  `--co-located` precedent: the external tier sets no secrets on its repo, so the flag was a
  promise the command silently did not keep. Env-derived values (`ZENODO_TOKEN` in the
  environment) stay tolerated, so an exported token never blocks the command; the distinction
  lives in `cli.ts`, which is the only place that can make it. Argument-shape refusals
  (tier, secrets) now precede the preflight, so a wrong flag is answerable without the
  network.
- **[R108]a CLOSED.** `versionTags` no longer catches an API failure into `[]`: the failure
  propagates, and `runNewVersionReminder` catches it and returns the error shape its other
  failures use (exit 1, `reminder: 'error'`, an annotated sentence naming gh), instead of
  reading a rate limit as "never published" and silently skipping the reminder on a published
  paper. `!repo` still returns `[]`: that is "no tags to read", a local run, not a failure.
- **[R119]c CLOSED.** `--strict` now blocks warnings in the verdict and the Check Run as well
  as the exit code (layer-A warnings are not `optional` under strict): the old split printed
  `status: ok` and posted a success conclusion on a run that had just exited 1. The
  `errors`/`warnings` classification in the report is unchanged; only the verdicts agree.
  Latent on CI (`check.yml` passes no `--strict`), so no workflow behaviour moved.

Decisions taken in place of asking, both in PR #47: best-effort settings with a fail-fast
content chain (the alternative, stopping at the first failure everywhere, hides the rest of
the picture and leaves repairable settings unrepaired); and a usage error rather than a
warning for the discarded flag, per the module's own precedent that silently meaningless
flags teach the wrong model.

Still open from the group's neighbourhood, not touched: [R127]c/d/e/g/h/i and [R128]'s
remaining mutations, [R108]b-g, [R119]a/b/d/e, [R113]-[R115], [R124].

**Verification pass over both PRs** (independent re-derivation of all sixteen mutations, plus
typecheck, format and a merge probe). Every claim above reproduced, with one exception:

- The `applySecrets` test named "lands in the by-hand list" did NOT pin the by-hand list. Its
  assertion was `runbook.join('\n')` contains `ZENODO_TOKEN`, which survives deleting the
  `else missing.push(name)` twice over: the step-failure runbook line names the secret too,
  and `ZENODO_TOKEN` is a substring of `ZENODO_TOKEN_SANDBOX`, so even scoping the assertion
  to the by-hand line still passed. Now parsed: the line's name list is split and compared, so
  the refused secret must actually be in it and the one that succeeded must not. The mutation
  fails as it should. A reminder that a `toContain` over a joined array asserts almost
  nothing, and that a shared prefix in an enum of names defeats substring matching.
- The two branches merge cleanly with each other (both touch `gh.ts` + `messages.ts`, in
  different regions); merged, the suite is 393 and `tsc --noEmit` is clean, so neither merge
  order needs care.

(r129)=
- **[R129] The gh preflight is wired to one of the three verbs that cannot degrade without it.**
  [R125]'s `assertGhReady` is called from `cmdBootstrap` only. `cmdUpgrade` has the identical
  shape (`gh.tempClone` on the `--repo` path, `latestEngineRelease` + `materializeTemplate`
  through its deps on both paths) and `cmdConformance` reaches the network in every
  subcommand; a logged-out `gh` reaches the tenant there as whichever probe runs first, which
  is the symptom [R125] closed for bootstrap. NOT simply hoisted into `main()`, which is why
  this is an entry rather than a fix: `oak upgrade --paper <dir>` refuses a non-paper
  directory locally (`pins.yml`, asserted by a cli-output test that calls it "a pure local
  refusal (no network)"), and a preflight in front of that would turn an argument-shape
  refusal into a gh complaint, the exact inversion PR #47 was careful to avoid for the secret
  flags. So the preflight wants to sit before the first gh call on each path, not before the
  verb: `cmdUpgrade`'s `--repo` branch, the top of `cmdConformance`, and after upgrade's local
  target resolution on the `--paper` path.

## Ratified deltas (2026-08-31, round 6: P6 backlog group 3, the record versus the code)

[R118]'s four claims and [R119]a/b, cleared as PR #49 (branched from `main`). One claim
implemented, three amended, both merge-gate weakenings closed. Every fix was run against the
UNFIXED code first and seen to fail, and each two-halved fix had each half reverted alone:
the `checkDepositNames` call dropped from `runLayerA` (1 failure), `depositCollisions`
neutered (7, across validate and zenodo), the engine-sentinel clause reverted (1 in
`schema.test.ts`, 1 more end to end through `runLayerA`), the `id-policy` push disabled (1),
the extends recursion disabled (2), the unreadable-ref finding disabled (2). Suite: 393 on
`main`, 410 after.

- **[R118] [R28] IMPLEMENTED.** `oak validate` reports a `deposit/` file whose name the engine
  writes into the bundle itself, as a blocking `deposit-names` error of klass `config`: it
  gates merge, and (like every non-`structural` finding) does not block the build. Chosen over
  amending because the record's own framing is right and the alternative was worse: the folder
  is a property of the working tree, visible with no network and no build, and the author is
  the person who can fix it, so telling them on their PR beats [R101]'s harmless-but-late
  refusal on the release tag, which arrives after review, from a verb the author never runs.
  - Wired to the EXISTING model rather than a second one, per the standing rule about dead
    model functions: the reserved-name comparison came out of `assertBundlePreconditions` into
    a pure `depositCollisions(names)` in `zenodo.ts`, which both surfaces now call, plus
    `RESERVED_DEPOSIT_NAMES` (the five fixed files plus the conditional `template.zip`) so the
    two cannot list different names. `validate.ts` importing `zenodo.ts` closes no cycle and
    follows `conformance.ts`, which already imports `RESERVED_BUNDLE_NAMES` from there.
  - Top level only, matching the bundle, and an entry with children is treated as a directory
    (which the bundle skips), so the check cannot fail a merge for something the release would
    have accepted. An empty directory of a reserved name is the one gap, and git cannot carry
    one, so it does not exist in CI.

- **[R118] [R41] / [R196] AMENDED, not implemented.** The record has this policy enforced and
  it is enforced nowhere: `classifyRef`/`decideRef` still have no importer but their own test,
  and the semantic (ancestry) half was recorded as living in `oak validate`. It cannot live
  there. The composite action checks the engine out AT the author-supplied ref and runs
  `oak` from that checkout, so a ref check inside `oak validate` is the untrusted code judging
  itself; implementing it would have produced the exact shape [R90] punished, a guard that
  reads as enforcement and is not.
  - What actually holds is narrower and now written down: `ci/run.sh` refuses a ref carrying no
    `dist/cli.cjs` ([R57]). That stops a branch tip. It does NOT stop `refs/pull/N/merge` of an
    engine PR that commits one, which is precisely the hole [R196] was ratified to close, so
    [R41] stays OPEN with its enforcement point named: the composite action, before the
    checkout, where the ref is still just a string.
  - Amended in three places: design §11's row 23 (marked NOT ENFORCED), `ref.ts`'s module
    header (which had asserted the semantic half "lives in `oak validate`", the fifth
    "enforced elsewhere" claim in this review to be false when checked), and `NOTES.md`'s
    module map.

- **[R118] [R46]b AMENDED.** "validate asserts every registry entry resolves to a real repo
  with a DOI" is not a per-paper merge-gate check and should not become one: it needs the
  network once per entry on every PR of every paper, `validate.ts` is deliberately network-free
  ("No git here", so the module stays testable offline), the entries are instance-config that
  the author cannot fix, and `doi` is `.optional()` by design ("absent until the paper is
  deposited"), so a present-DOI assertion would fail every paper registered before its first
  deposit. [R46]'s own line already names the right home, instance-config's own CI, and that
  check does not exist; the entry is annotated in place rather than dropped.

- **[R118] [R189] AMENDED.** "bootstrap/validate enforce public" is half true and the half
  that is false is not fixable: `oak validate` is handed `--instance <path>`, a directory that
  has already been cloned, and never sees a repository, so visibility is not an observable it
  has. `bootstrap.ts` enforces it at creation, which is the moment that matters, and the
  tokenless `git clone` in `ci/run.sh` is what fails if an instance stops being public. Row 16
  now says so.

- **[R119]a CLOSED, two halves.** (1) The sentinel is engine-owned: `ENGINE_ID_SENTINEL` in
  `schema.ts` is the id `templates/paper/myst.yml` actually ships, `checkIdShape` rejects it
  whatever the policy says, and a test pins the constant to the template file so the two cannot
  drift. A tenant's `id_sentinel` now WIDENS the contract and cannot switch it off. (2) The
  pattern is genuinely the tenant's rule, not the engine's, so its absence is not overridden
  but stated: a resolved instance whose `journal.yml` carries no `id_pattern` gets an
  `id-policy` WARN, so "any id shape is accepted" reads as a decision rather than as a gate
  that passed. `--no-instance` stays silent, on [R116]'s precedent that a tenant choice is not
  a broken instance.
  - Warn rather than error for the pattern deliberately: `journal-yml.md` already tells a
    journal with no id convention that dropping `id_pattern` is legitimate, and blocking every
    paper in such a tenant would make the engine's contract broader than the record's. The
    seeded `journal.yml` comment and that docs page were amended to match.

- **[R119]b CLOSED, two halves.** (1) `expandLayers` follows each layer's own `extends:` and
  feeds the whole expansion to `checkLayerDisjointness`, so a key clash one file of indirection
  down is found; nested layers are named `<parent> -> <ref>`, so the finding names the file
  that declared the key rather than the layer that pulled it in. Cycle-safe by a seen-path set.
  (2) An `extends:` this cannot follow (a URL, a missing file) is an `extends-unreadable`
  error rather than a silent skip, because an unread layer makes the disjointness verdict
  unsound; recursing over local paths only, with the unfollowable case reported, is both
  options the entry offered rather than a choice between them.

Still open in this neighbourhood, not touched: [R119]d/e, [R127]c/d/e/g/h/i, [R128]'s
remaining mutations, [R108]b-g, [R113]-[R115], [R124], and [R41] itself (now with its
enforcement point named).

## Ratified deltas (2026-08-31, round 7: P6 backlog group 4, the last of the queue)

The remainder of the ratified P6 queue, cleared as PRs #50 (the deposit chain, the gh edge, the
conformance verdict, `RELEASING.md`) and #51 (bootstrap), both branched from `main`. The two
merge cleanly with each other: 436 and 417 on their own, 443 merged, from 410 on `main`.

Every fix was run against the UNFIXED code first and seen to fail, and every fix with two halves
had each half reverted alone. The mutations, in order: the publish `updateMetadata` call deleted;
the `template.yml` gate reverted to the ungated local branch; the `assertEngineArchive` call
dropped; the `hasBuildContent` refusal short-circuited; the constructor put back to taking a host;
`encodeURIComponent` removed; sticky's `if (!repo) return`; the `--repo` scope dropped; `--base`
dropped; the `merge-base` guard dropped; the `pr create` catch dropped; `ghOk` restored to
`catch → false`; each of the three `--paginate` flags removed on its own; `wrangler@VERSION` back
to bare `wrangler`; the `settled` throw removed; `settled` forced true; the `isGitHubApiFault`
clause dropped; the pin assertion removed; the `skipped.push`; the `LICENSE` deleted and (a second
mutation) `edition.yml`'s licence changed under it; a label renamed; the default-branch comparison
neutered; the protect-main bypass emptied; `require_code_owner_review` flipped; the tag ruleset cut
to `creation`; `private` forced true; `createLabel`'s swallow restored; `RELEASING.md`'s prune
snippet restored to the awk positional; its `files` sentence narrowed; the typst fetch moved after
the canary.

Two of those mutations did NOT fail at first, and both are the same lesson round 5 recorded:
`toContain` over prose is not an assertion. The `files` enumeration test passed with the narrowed
sentence because `ci/` is a substring of `ci/run.sh`; it now compares the allowlist against the
SET of code spans in the section. The typst-ordering test passed because both commands are quoted
in the script's comments; it now strips comment lines and compares command indices.

- **[R107] CLOSED, all six.**
  - (a) The [R22] overwrite is pinned: publish sends the WHOLE metadata object (title, version,
    `publication_date`, the description carrying the abstract) to the existing draft.
  - (b) `resolveTemplateDir` applies myst's `template.yml` gate. A local directory that merely
    shares a registry template's name no longer shadows the registry, so the deposit cannot
    archive bytes that did not render the PDF.
  - (c) `engine.zip` must carry `dist/cli.cjs` and `bin/typst` or the deposit is refused
    (`EngineArchiveError`, through the envelope as exit 2). Checked on the produced archive
    rather than the engine working tree on purpose: both files are gitignored and present on a
    developer's disk while absent from `git archive HEAD`, so an `existsSync` would have passed
    on exactly the ref the finding is about. The cost is that the check lands after the draft's
    metadata PUT rather than before it ([R101]'s line): a draft update is not a publication, and
    moving the whole bundle build ahead of `updateMetadata` would have reordered the deposition
    read the bucket URL comes from. No file is uploaded.
  - (d) publish refuses when `_build/site/content` is absent. Absent build output and a paper
    with no abstract part are the same `null` out of `partParagraphs`, and only the first is a
    downgrade of a description that had one; `hasBuildContent` separates them. `oak release`
    always builds first (its own comment says it reads `_build/site/content` back), so this
    bites only a hand-run `oak deposit publish` on an unbuilt or `--exports-only` tree, which
    is the case that produced the finding.
  - (e) `ZenodoApi` takes `sandbox` and DERIVES the host; the three verb inputs read
    `api.sandbox` instead of carrying a second copy. The mismatch is now unrepresentable rather
    than checked, which is why the tests could no longer normalise it with a host of `'x'`.
  - (f) The upload filename is percent-encoded. `deposit/data?v2.csv` truncated the bucket path
    and appended to the query string carrying the access token.

- **[R108] CLOSED, b through g.** (a) was closed in round 5.
  - (b) `sticky` throws instead of returning silently with no origin repo, so `check-post`
    degrades to its existing warning and reports `commentPosted: false` rather than claiming a
    comment it did not post.
  - (c) `openDoiPr` passes `--repo`. Its git calls are `-C repoRoot` while `gh` read the current
    directory's repo, so `--paper <elsewhere>` opened the PR against the wrong repository.
  - (d) The DOI PR targets the repo's default branch and REFUSES a HEAD carrying commits the
    base lacks (`git merge-base --is-ancestor`), rather than opening a "one-file" PR carrying a
    branch's whole divergence. Chosen over the alternative (force-checkout the base and replay
    the myst.yml write) because that discards any other tracked modification in the working
    tree, and `oak deposit prepare` is runnable by hand; a refusal costs the operator a rerun
    from the default branch and cannot lose work. `prepare` is best-effort at the CLI edge
    already, so the reserved DOI and the working-tree write survive the refusal.
  - (e) A second `prepare` returns the PR the first opened instead of reporting the step failed,
    which is what §13 calls idempotent.
  - (f) `ghOk` tells 404 (absent) from anything else. A non-404 now throws, so a forbidden
    DELETE is no longer reported as a clean teardown and a forbidden GET no longer reads as
    "does not exist" and turns into a create that fails late. `ghOkAs` is now `ghOk` with the
    fork token. This also closes **[R113]d**.
  - (g) The compare behind the [R83] frozen-shim advisory, the ruleset lookup and the cert
    branch listing all paginate. `issues/<n>/comments` keeps its deliberate non-pagination,
    which carries its own comment.

- **[R109] CLOSED.** `npx --yes wrangler` is pinned (`WRANGLER_VERSION`, a named constant beside
  the deploy). A `wrangler.version` file mirroring `typst.version` was rejected as more surface
  than the pin is worth: it would want a place in the npm `files` allowlist, in `RELEASING.md`,
  and a read path from `gh.ts` to the engine root, for a value that is bumped by editing one
  line either way.

- **[R113] CLOSED, a/b/c/e/f; d closed by [R108]f.**
  - (a) `pollUntil` takes a `settled` predicate, consulted only when the poll expires: when
    every workflow run on the part's commit has finished, an absent part is a cert FAILURE, not
    a `ThirdPartyError`. Wired to the four part assertions (both Check Runs, both preview
    stickies) through one helper over `workflowRunsForCommit`, which is the only definitive
    "nothing more is coming" signal the seam already exposes. A run GitHub attributes to another
    head sha could in principle make this red where inconclusive was right, after twenty minutes
    of nothing appearing; that reading is the one [R78] asked for.
  - (b) `isGitHubApiFault` recognises a `gh` child that failed on 401/403/429/5xx or a transport
    error, in the shape `run` formats, and routes it to INCONCLUSIVE. Narrow on purpose: a 404
    or a 422 is not third-party, and the test drives it through a throwing `installEngine`.
  - (c) The fixture's committed engine pin is asserted to equal V straight after the merge. The
    pin write is `oak upgrade`'s, the dogfooded path under test, so a regression in it would
    otherwise have certified V while the fixture ran something else.
  - (e) The verdict carries `skipped`, so a three-path cert cannot read as a four-path one; the
    workflow header says the same thing.
  - (f) The two comments claiming the deposit check compares "the exact deposited bytes" now say
    what it does: it compares the five reserved NAMES, because the harness holds no Zenodo token.

- **[R114] DECIDED 2026-09-01: documented, not fixed** (was: awaiting the user).

- **[R115] CLOSED, three of four; the fourth was already handled.** The `package.json` version
  literal went with PR #43. The prune snippet reads `--json tagName,isPrerelease` rather than
  `gh release list`'s first column (which is the TITLE, and only equals the tag because the cut
  happens to title a release after it), and its comment says newest-first, which the listing is.
  The `files` sentence names what the allowlist names. The pre-check no longer claims to be the
  cut's gate: the cut fetches `bin/typst` at `typst.version` and renders with THAT, while
  locally the canary uses whatever is on `PATH` and skips itself when there is none. Three lints
  hold the doc to the machinery: the prune snippet, the `files` set, and the fetch-before-canary
  ordering.

- **[R127] CLOSED, c/d/e/g/h/i.** (a), (b) and (f) were closed in round 5.
  - (c) `templates/paper/` seeds a `LICENSE` carrying the CC BY 4.0 text, the licence the seeded
    `edition.yml` asserts to readers and to Zenodo, and `edition.yml` says the two move together
    (`LICENSE` is not a frozen file, so `oak upgrade` will not follow a licence change). Judgment
    call: the licence is instance config, but `bootstrap paper` never reads the instance's
    edition, so rendering per tenant needs a new input and a licence-id-to-text table. Seeding
    the template's own default, with the coupling written down AND pinned by a test that reads
    the id out of `edition.yml`, closes the reader-facing gap at a fraction of the surface. The
    per-tenant render stays available if a tenant ever changes the licence.
  - (d) Both halves. The two label names live in `preview.ts` beside the other stable
    identifiers, and `bootstrap.ts` and `gh.ts`'s failure issue read them, so bootstrap cannot
    provision a label the issue does not ask for. `realProvisioner.createLabel` no longer
    swallows: `gh label create --force` already covers the label existing, so the catch could
    only hide a 403 or an outage, and [R125]'s step runner records it. The two halves shipped in
    different PRs (the swallow with #50, where the `node:child_process` mock lives; the names
    with #51) and were proved separately.
  - (e) A `default_branch` step reconciles the default with `main` before the ruleset that
    depends on it. `seedBranch` puts the content on `main` and leaves `default_branch` alone, so
    a pre-existing repo defaulting to `master` got a protect-main guarding a branch nothing
    merged to. In `applyProvisioning`, so it covers the paper and co-located tiers, which are
    the tiers that get rulesets; the external instance repo has the same seeding shape and no
    ruleset, and is not covered.
  - (g)+(h) `protect-main` carries a bypass: nobody on an org path, `REPO_ROLE_ADMIN` (the named
    5) in `pull_request` mode on a personal one. With `require_code_owner_review` on and no
    second account, a solo editor could not merge their own `.github/` PR at all. `pull_request`
    rather than `always`, so a direct push to `main` stays refused for everyone. The cost is
    stated at the call site: a ruleset bypass is per-ruleset, so that same admin can also merge
    past a red "Journal checks". Accepted on [R123]'s precedent (a deliberate click by one person
    beats a gate nobody can pass), and the alternative that keeps both properties, splitting
    protect-main into two rulesets so the checks rule carries no bypass, adds a third ruleset
    name to every idempotency probe, the upgrade path and the tests, for a tier whose admin can
    edit the ruleset anyway.
  - (i) The comment cited "PROVISIONING §3.3". No such document exists in the engine, the docs
    tree or the ledger; the line now states the fact plainly, and the fact it stated is now true
    by construction because of (g).

- **[R128] CLOSED.** Four assertions on WHAT was provisioned, each proved by its own mutation:
  `require_code_owner_review` and the required "Journal checks" context; the tag ruleset's
  `creation`/`update`/`deletion`; a paper repo's visibility, both ways; and the label names,
  against the constants their consumers use. The fifth complaint (no test exercises a throwing
  provisioner) was closed in round 5 by [R125]'s tests.

- **[R110] ALREADY CLOSED, in round 5.** Both halves: [R125]'s `stepRunner` records a throwing
  step instead of propagating it, so a 403 at `enablePages` or `createRuleset` leaves the run
  with a runbook and an `incomplete` envelope rather than a stack over a half-provisioned public
  repo; and `assertGhReady` (gh.ts, cited to [R110]) is the missing `gh --version` /
  `gh auth status` preflight. Verified against the tree, not the record.

### [R114], DECIDED 2026-09-01: documented, not fixed

**The user's call: option 2, accept the gap and write it down.** Option 1 (promote on a green
cert) stays the eventual shape and is still the C5 slice, but making every stable release depend
on the harness being available is a bigger commitment than the current exposure warrants: no real
`vX.Y.Z` has been cut yet, so nothing is exposed today. `RELEASING.md` §"Latest does not imply
certified" now carries the gap and the manual discipline it implies: cut, watch the conformance
run, yank or supersede if it is not green, and do not announce a version to tenants before it is.

Reopen this when the first stable release is cut, or when a tenant other than ISP pins `latest`.

The original write-up follows, since the options are still the options.

**The mechanism.** `cut-engine-release.sh` passes `--prerelease` only when the version contains a
`-`. So a real `vX.Y.Z` enters `releases/latest` the moment it is cut, and `releases/latest` is
exactly what `oak bootstrap` and the scheduled `oak upgrade --version-only` resolve ([R88], which
deliberately uses the `releases/latest` API rather than `gh release list --limit 1` so a dev cut
never becomes the default). Certification runs AFTER the cut, as a `workflow_run` hook behind a
required reviewer. Dev cuts are excluded from `latest` by their own pre-release flag, so nothing
is broken today; the first real release is when "release implies certified" ([R78]) stops holding.

**Options.**

1. **Promote on a green cert.** Cut every release as a pre-release; the conformance workflow, on
   a CERTIFIED verdict for V, flips V with `gh release edit V --prerelease=false --latest`. "What
   `latest` resolves to has been certified" then holds by construction. This is the C5 slice the
   record already anticipated. Costs: `latest` lags a real cut by the cert's duration plus the
   reviewer's click, which is the point rather than a defect; and if certification is
   unavailable at all (no fixture repo, a revoked PAT) nothing ever becomes latest, so
   `oak bootstrap` reports [R88]'s "no stable release" instead of handing out an uncertified
   engine. That failure is the right one but it is not self-explanatory, so it wants a paragraph
   in `RELEASING.md`. [R111] already makes a verdict-less cert run red, so a cert that certified
   nothing cannot promote.
2. **Leave it and say so.** Cheapest, and honest only if written down. It contradicts [R78] at
   the one moment the guarantee matters, and the exposure is not hypothetical: the scheduled
   `oak upgrade --version-only` moves tenants onto `latest` without anyone typing anything.
3. **Certify a dev tag, then cut the real one from the same tree.** No promotion machinery, but
   it certifies a different ref: the tag differs, `dist/cli.cjs` is rebuilt, and the fixture
   installs and pins the dev tag, so the artifact tenants pin is not the artifact that was
   certified. That is precisely the substitution [R78] exists to refuse.
4. **A separate "recommended" coordinate.** Keep `releases/latest` meaning newest and resolve
   bootstrap/upgrade against a `latest-certified` marker instead. Keeps both meanings, at the
   price of a second coordinate tenants must learn, a resolver change in [R88], and a GitHub
   primitive (`latest`) that now means something the engine does not use.

**Recommendation: option 1**, with the failure mode documented. It is one flag in
`cut-engine-release.sh` and one step in `conformance.yml`, it makes the guarantee structural
rather than procedural, and it fails closed. Decide before the first real `vX.Y.Z`.

### Opened, not fixed

(r130)=
- **[R130] `postCommitComment` returns silently when `originRepo` misses**, the sibling of
  [R108]b one screen above it in `gh.ts`. Its caller (`cmdRelease`, cli.ts) wraps the post in a
  `try`/`catch` that annotates a warning, so a thrown failure is reported and a SILENT return is
  not: a successful deposit with no origin remote leaves the editor no comment and no warning
  either. Milder than [R108]b (nothing claims it was posted), which is why it was left rather
  than folded in: fixing it means deciding whether the same treatment is owed to
  `openFailureIssue` and `realGhPr.addLabel`, and that is a small pass over `gh.ts`'s
  degrade-quietly edge rather than a one-line change.

Nothing from the ratified P6 queue is now open except the entries outside this group's scope:
[R119]d/e, [R124], and [R41] itself. [R114] was decided on 2026-09-01 (documented, not fixed).

## Ratified deltas (2026-09-01, round 8: Pass A resumes at `cli.ts`)

Pass A's backlog is clear, so the review continues at the piece it paused before. `cli.ts` is 1199
lines and the entire public surface; this round covers its argument layer and its own header. The
verb bodies are the next sitting.

(r131)=
- **[R131] `flag()` could not tell an absent flag from one whose value vanished.** It returned
  `argv[i + 1]` unconditionally: a following token was the value whatever it looked like, and a
  flag in last position returned `undefined`. Neither was refused. Demonstrated:
  `['--repo', '--tag', 'v1']` yields `repo === '--tag'`, and `['--repo']` yields `undefined`.

  The second half is the dangerous one. Roughly a dozen call sites read
  `flag(argv, x) ?? process.env.X`, so a flag whose value vanished did not fail, it fell through
  to the environment: `oak notify --repo "$REPO"` with `REPO` unset acts on
  `$GITHUB_REPOSITORY` instead of refusing, and the operator is told nothing. The first half is
  noisier but the same class, and it is how an unquoted empty variable presents.

  `flag()` now throws a `UserError` (exit 2, the usage code) when the value is missing or begins
  with `--`. A single leading dash is still a value: only `--` is unambiguous. This is the
  argument-shape rule [R127] settled, applied one layer lower: a malformed argument is decidable
  without the network and must not reach a gh call, an env fallback or a filesystem probe.

  ⚑ The whole suite passed both before the fix and after it, so nothing covered this. Three
  tests now do, and each half of the guard was reverted alone and seen to fail its own test.

(r132)=
- **[R132] `cli.ts`'s header described a program that no longer exists.** It read "Verb surface
  maps the 7 current isp-actions-config workflows" against 11 verbs, and "Implemented: `build`
  (slice 2). The rest are stubbed with their slice number" against a `STUB_SLICE` that has been
  empty for many slices, which also made its dispatch branch dead. Header corrected, the empty
  map and its branch removed. The same bucket as the comments [R118] found: a confident claim
  that stopped being true and was never re-read.

Also landed this round: `scripts/check-ledger-refs.mjs`, specified by the review plan and never
built. It asserts every `[R#]` cited in `src/` and `templates/` resolves to an id the ledger
DEFINES, and it is wired into `npm test`. It **skips when no ledger is reachable** — a tree without
`docs/design/` has nothing to check against. Currently
130 ratified ids, every citation resolves. Both paths were proved (an injected citation of an unratified id exits 1
naming the file and line; a tree with no reachable ledger exits 0).

(r133)=
- **[R133] `oak deposit --sandbox` fell back to the PRODUCTION token, which the frozen shim
  explicitly refuses to do.** `cli.ts` read
  `sandbox ? (ZENODO_TOKEN_SANDBOX ?? ZENODO_TOKEN) : ZENODO_TOKEN`. `prepare.yml` carries a step
  whose own comment says a sandbox run in a repo that has only set `ZENODO_TOKEN` "would send the
  PRODUCTION token to sandbox.zenodo.org... the two environments are separate on purpose, and a
  credential quietly crossing between them is worse than a failed run." The CLI then did exactly
  that. `oak release` (`cli.ts`, the publish path) has never had the fallback, so the two deposit
  verbs disagreed with each other and one of them disagreed with the shim.

  The fallback was load-bearing, which is why it survived: `prepare.yml` chose the token in YAML
  and passed the result as `ZENODO_TOKEN` whatever it was, so without the fallback every sandbox
  CI run would have found `ZENODO_TOKEN_SANDBOX` unset. The workflow's step guard only ever
  covered CI. The exposed path is local: an editor running `oak deposit prepare --sandbox` on a
  workstation holding the production token, which is the same population [R103] was about.

  Fixed at both ends, the shim first: `prepare.yml` now passes BOTH secrets under their own names,
  exactly as `publish.yml` already did, and the CLI picks without a cross-fallback. The early
  refuse step stays, because it gives a better message than a missing-token error. ⚑ Frozen file,
  so this is a fleet-wide `oak upgrade --files-only`.

  This is [R102]'s own bug class reappearing inside [R102]'s fix, the same shape as [R20]'s
  duplicate-DOI guard reintroducing duplicates. A verb-by-verb sweep found the first two; this was
  found by reading the shim and the CLI against each other, which is the pairing that catches it.

(r134)=
- **[R134] Two more argument shapes that were not refused, both the [R131] family.**
  - An EMPTY value fell through to the default. `--instance ""`, which is how
    `--instance "$VAR"` presents when `VAR` is unset, left `flag()` returning `''`, which every
    call site tests for truthiness, so the flag was silently ignored. The resulting error told the
    operator to "pass --instance <path>", which they had just done: the least useful sentence
    available. `flag()` now refuses `''` alongside a missing value.
  - `--port abc` became `NaN` and was handed to myst. `startOptsFrom`'s `num()` now refuses a
    value that is not a non-negative integer.
  - `startOptsFrom` is also parsed at the TOP of `cmdStart` now, not after instance resolution and
    compose, so a typo is refused before the author waits through a build for it. [R127] settled
    that argument-shape refusals precede any gh call; this is the same rule against local work.

(r135)=
- **[R135] `oak deposit`'s no-token error named the wrong variable on a sandbox run.** It was a
  constant reading "set ZENODO_TOKEN", while the sibling `releaseNoToken(sandbox)` has always been
  a function that names the right one. Under [R133] this is the message an editor now actually
  sees, so it was fixed with it.

(r136)=
- **[R136] The preview path read the PR number from the untrusted artifact with no shape check,
  while its sibling had been hardened.** P1's fix put both a shape check (`^[0-9]{1,10}$`) and an
  API ownership check (the PR's head sha must equal `workflow_run.head_sha`) into the frozen
  `check-post.yml`. `preview-deploy.yml` has neither, and `oak deploy-preview` reads `.pr-number`
  out of the downloaded `paper-build` artifact verbatim. That artifact is produced by Stage 1,
  which runs fork content, so a fork author controls the file byte for byte. Stage 2 holds
  `GH_TOKEN`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

  `takePrNumber` returned the trimmed contents, and `gh.ts`'s `sticky` interpolates them into
  `repos/${repo}/issues/${prNumber}/comments`, an argv element rather than a shell string, so this
  is path injection into the API URL rather than command execution.

  Certain impact: the bot posts its sticky preview comment on any issue or PR number in the base
  repo that the fork author names, carrying the repo's own identity and a link to content the
  author controls. Whether a `..` segment reaches a different endpoint under the base token was
  NOT tested and is not claimed; the shape check closes it either way.

  `takePrNumber` and a new `assertPrNumber` now refuse anything that is not one to ten digits, so
  both `deploy-preview` and `notify` are covered. A malformed value THROWS rather than no-ops:
  absence is a push build, but a present-and-malformed file is a corrupt or hostile artifact and
  Stage 2 going red on it is correct.

  ⚑ **Residual, deliberately not closed here.** The ownership check (this PR number is the PR that
  produced this artifact) is the stronger guard and is still absent on this path. It needs
  `workflow_run.head_sha` passed into the CLI, which is a frozen-file change and therefore a
  second fleet-wide re-copy on top of [R133]'s. Deferred rather than dropped: a preview comment
  gates nothing, which is why `check-post.yml` earned the stronger guard first.

## Ratified deltas (2026-09-01, round 9: the frozen changes, taken together)

The user's call: make every frozen-file change the review has identified now, in one PR, so the
fleet takes one `oak upgrade --files-only` rather than a series. Two were outstanding.

- **[R41] CLOSED. [R196] is now enforced, in the composite action, before the checkout.** The
  action's own comment had been amended (round 6) to admit the hole rather than claim a guarantee:
  "a public engine also resolves refs/pull/N/merge. What actually keeps CI on releases is run.sh's
  dist/cli.cjs check" and a PR can commit one of those. A new `refclass` step refuses
  `refs/pull/N/merge` and a bare 40-hex SHA when `github.event.pull_request.head.repo.fork` is
  true, which is exactly `decideRef`'s policy: those two classes are dogfooding-only, everything
  else (release tags, `v0.0.0-dev.N`, branches) passes. Non-PR events skip, since their `myst.yml`
  is base-controlled.

  ⚑ The pure model in `ref.ts` was NOT wired up, and could not be: the check has to run before the
  engine is checked out, so the engine cannot be the thing that runs it. `ref.ts` keeps its only
  caller (its test) and its header already says so. This is the one case in this review where
  duplicating a model was right, and it is worth stating so a later reader does not "fix" it.

- **[R136] residual CLOSED.** `preview-deploy.yml` now carries the same two-part guard as
  `check-post.yml`: the shape check, then the PR's head sha must equal
  `workflow_run.head_sha`. The CLI-side shape check from the previous round stays; the two are
  layered, not alternatives, and the CLI's is what covers `oak notify` run by hand.

- **[R99] partially closed.** `test/frozen-guards.test.ts` extracts a step's `run:` script from the
  real YAML by `id` and executes it under bash, so the assertion is on the shipped bytes. Nine
  cases across the two guards. `gh` is stubbed on PATH for the ownership half, so no network.
  This is the first behavioural test the frozen surface has ever had; the rest of the 518 lines
  still has none. Each of the three guard clauses was neutered alone and seen to fail only its
  own cases.

⚑ **Fleet action required on merge:** `oak upgrade --files-only` across every paper repo, covering
this round and [R133]'s `prepare.yml` token split from round 8.

**Taken with round 9, since the frozen files were open anyway:** a terseness pass over the whole
frozen surface, applying `STYLE.md` to seeded tenant files for the first time since
`docs/design/paper-ci.md` was written to hold their rationale. 120 comment lines to 81, with every
invariant kept and the narrative around it dropped or pointed at the design page. Two corrections
fell out of it:

- `pins.yml` said the canonical move happens "via replayed commits". That was superseded on
  2026-08-29 (history is NOT preserved), so a seeded file was telling every tenant something the
  record had already reversed.
- The [R136] guard added in round 9 carried an `[R#]` citation into a seeded file, against the
  PR #34 decision that stamped templates carry none, since a tenant cannot resolve one. Replaced
  with the design-page link. ⚑ `templates/*/README.md` DOES cite `[R#]` and that is correct:
  `EXCLUDE_FROM_STAMP` keeps the READMEs in the engine repo, where they resolve. Checked rather
  than assumed.

⚑ `test/frozen-guards.test.ts` now states its own limit in its header: it runs the scripts under
bash, not a GitHub runner, so `${{ }}` is already resolved, `$GITHUB_OUTPUT` behaves differently,
and the shell setup is not the same. It covers script logic and cannot catch a workflow-level or
expression-level fault. Necessary, not sufficient; the live conformance run is what exercises the
real thing.

## Ratified deltas (2026-09-01, round 10: `cli.ts`'s remaining verbs)

(r137)=
- **[R137] `oak check-post` met the untrusted artifact with `JSON.parse` and a destructure.**
  `cli.ts` did `JSON.parse(readFileSync(reportPath))` with no guard, and `checks.ts` then
  destructures `report.checkRun` without checking it exists. Stage 1 is fork-controlled (a
  `pull_request` run uses the HEAD's workflow files, so an author's own `check.yml` writes that
  artifact), which makes the report untrusted input by construction. Two ways to a stack trace:
  bytes that are not JSON, and valid JSON with no `checkRun`, for example `{}`.

  Stage 1's `jq -e '.checkRun.conclusion'` guard does not help, because it runs in that same
  untrusted half. This is the [R136] shape again: untrusted input answered with a stack instead
  of a sentence. Not an escalation (an author can only deny themselves a verdict, and the merge
  gate then shows none), but the operator is told "engine crash" for a fault the engine did not
  have. Both paths now return 1 with a sentence naming the file and what is wrong with it.

  ⚑ **Verified while here, and it holds:** the forgery case (a fork editing `check.yml` to write
  `conclusion: success`) is defended by [R83]'s frozen-shim advisory, and `check-post.yml` really
  does pass `--base` and `--verified-head`, so the advisory is live rather than dormant. The
  advisory is skipped when either is absent, which the record calls back-compat; that path is not
  reachable from the shipped shim. Checked because "enforced elsewhere" has been false six times
  in this review; this is the first time it was true.

(r138)=
- **[R138] Every verb's usage line promises `--repo <owner/name>` and nothing enforced it.** In
  `oak upgrade` the value goes straight to `gh(['repo', 'clone', repo, tmp])`, positionally, which
  is the exact shape [R103] is about: an argv array stops the shell, not the callee's own option
  parser. [R131] now refuses a `--`-prefixed value, so the remaining hole is narrow (a single-dash
  value, or a full URL to another host, both of which `gh repo clone` accepts), and the operator
  typed it themselves, so this is a usability defect more than an exposure.

  `assertRepoName` lives beside `assertIngestSource` in `gh.ts` and is applied at the one site
  where the value reaches `gh` positionally. ⚑ NOT applied to the other `--repo` readers: they
  pass the value into an API PATH, where `[R136]`'s lesson applies but the failure mode is a 404
  rather than an argument, and several of them accept `process.env.GITHUB_REPOSITORY`, which is
  GitHub-set and well-formed by construction. Widening it is a judgment call that wants its own
  change rather than a drive-by.

(r139)=
- **[R139] The preview branch alias truncated the PR number away, on real fleet repos, today.**
  `previewBranch` substituted `{repo}` and `{pr}` into the pattern and then `.slice(0, 28)` for the
  Cloudflare Pages alias limit. The default pattern is `paper-{repo}-{pr}`, so any paper whose name
  is 17 characters or longer loses the PR number entirely. Measured against names in the actual
  fleet:

  | repo | PR 5 | PR 12 |
  |---|---|---|
  | `author-one-2026-nmap-celegans` | `paper-author-one-2026-nm` | `paper-author-one-2026-nm` |
  | `author-two-2026-brainwide-timescales` | `paper-author-two-2026-br` | `paper-author-two-2026-br` |
  | `author-x-2026-pd` | `paper-author-x-2026-pd-5` | `paper-author-x-2026-pd-12` |

  Every PR on those papers deploys to ONE alias, so a reviewer opening PR 5's preview link sees
  whichever PR deployed last. Silent, and wrong in the direction that matters: the preview is the
  artifact a reviewer judges the paper by.

  The budget is now spent on `{repo}` last, so `{pr}` cannot be pushed off the end. A truncated
  name also carries a 4-hex-character hash of the full one, because every paper in a journal shares
  one Pages project and the alias is the only thing separating them: without it, two papers with a
  common prefix would collide the way two PRs used to. A name that already fits is byte-identical
  to before, so short-named papers see no URL churn.

  ⚑ Found by reading, then measured against real repo names before being written up. The unit test
  that existed used a short repo name, which fits, so it passed throughout.

(r140)=
- **[R140] A tenant's own typo in `journal.yml` was reported as a bug in the engine.** `preview.ts`
  called `JournalConfig.parse(...)` with no guard, so a `provider:` the schema does not know
  (or any YAML that will not parse) threw a `ZodError` out of `cmdDeployPreview`, through `main`'s
  non-`UserError` branch, and printed:

  > oak: the engine hit an unexpected error. This is a bug in oak, not something you did wrong;
  > the details below are what to report.

  followed by a raw ZodError dump. That is exactly backwards, and worse than a bare stack: it tells
  the tenant to file a bug rather than fix the line they just edited. Demonstrated, not inferred.

  It also broke [R16]: deploy-preview is specified never to fail the run, and this failed it on
  every PR until the config was fixed, so no preview was posted either.

  Now it degrades the way every other unusable provider does, and the reason rides into the
  artifact comment, which is where an editor is actually looking. `validate.ts`'s `loadJournal`
  took the same treatment in round 4 ([R121]); this is the second reader of the same file, found
  because the first one had already taught us to look.

(r141)=
- **[R141] The edition coordinate is a filename segment and was validated as `z.string().min(1)`.**
  `edition` selects `editions/<edition>.yml`, and it reaches a path in three places: compose's
  extends chain (`${instanceRoot}/editions/${edition}.yml`), validate's layer list for the [R72]
  disjointness check, and the filename `oak bootstrap` writes. It comes from the paper's own
  `myst.yml`, so on a fork PR it is author-controlled, and nothing constrained its shape.
  `edition: ../../../etc/shadow` composes to `/inst/editions/../../../etc/shadow.yml`.

  **Impact, stated precisely rather than inflated.** In Stage 1 this is not an escalation: that
  job already runs the author's own content and holds no secrets, so a file read there buys an
  author nothing they did not have. The real exposure is LOCAL, an editor running `oak build` or
  `oak validate` on a submitted paper, where the traversal reads a file outside the instance root
  and, if it happens to parse as YAML, merges it into the composed config. Not demonstrated end to
  end; the traversal itself is (shown above), and that is what is fixed.

  The point is smaller and more certain than an exploit: `project.id` has `checkIdShape` and this
  coordinate had nothing, though it is the one that becomes a path. `EDITION_ID` now constrains it
  to a plain name at the schema, which is where the coordinate is defined, so all three consumers
  inherit it rather than each re-checking. Same argument as [R138], one layer in.

  ⚑ The first version of this guard carried a second clause refusing `..` anywhere in the value.
  Mutation testing killed it: reverting that clause alone broke nothing, because the regex already
  excludes `/`, and `..` without a separator cannot traverse. It was an unfireable guard that read
  as protection, which is the shape this review has punished repeatedly ([R90] above all), so it
  was removed rather than kept for comfort. The discipline caught its own author.

  ⚑⚑ **And the guard was in the wrong place, which mattered more.** Putting it on the schema
  looked right and did not close the path it was written for: `materializeDerived` reads the
  coordinate through `readEngineCoordinateRaw` (a deliberate raw, pre-extends read, the local
  equivalent of the shim's `yq`), builds the extends chain from it, WRITES the derived config and
  hands it to myst, all a pass before `compose` calls `readEngineOptions` and the schema finally
  applies. Verified by running it: with the schema guard in place, `myst.oak.yml` was written
  carrying `.../inst/editions/../../secret/loot.yml`.

  The check now sits at the raw read as well, where the value enters, and the traversal is refused
  before pass 1 writes anything. Both layers are kept and each was proved alone. The lesson is the
  one this review keeps re-learning from the other side: a guard placed by reading the type rather
  than by following the value is a guard that reads as protection. Found only because [R82]'s
  two-pass materialization was the next thing on the reading list.

(r142)=
- **[R142] `build.ts` carried nine dead imports.** `compose`, `extendsChainFor`, `readDoc`,
  `writeDerivedDoc`, `setExtends`, `applyOwnOverride`, `readEngineCoordinateRaw`,
  `readBrandAssetOptions`, `readTenantTypstTemplate` and `ISession` were all imported and unused,
  left behind when `materializeDerived` moved to its own module ([R82]). Harmless at runtime (the
  bundler drops them), but they make the module map read as though `build.ts` still drives compose
  and the YAML edge directly, which is exactly the coupling [R82] removed. `tsconfig` has no
  `noUnusedLocals`, so nothing flagged them. Removed; typecheck and the suite are unchanged.

## Ratified deltas (2026-09-01, round 11: `upgrade.ts` + `checks.ts`)

(r143)=
- **[R143] `oak upgrade` cannot see a frozen file the engine has RETIRED, and says "up to date".**
  `frozenFiles` walks the template at the target, so the drift set is "what the target ships,
  compared to disk". A file on disk that the target does NOT ship is invisible: not drift, not
  reported, never removed. Demonstrated: a `.github/workflows/retired.yml` planted in a rendered
  repo yields `drift: []` while the file sits there.

  The consequence is fleet-shaped. Every workflow the engine ever shipped keeps running in every
  paper repo forever, including one retired BECAUSE it was wrong. This session's own [R41] and
  [R136] work was additive, so nothing is stranded today; a rename or a split would have stranded
  the old file, still running the old logic, with `oak upgrade` reporting the fleet healthy.

  **Reported, deliberately NOT deleted.** The same path holds a tenant's own additions (a
  `dependabot.yml`, their own CI), and with no stamped manifest, which [R17]'s design chose on
  purpose, the engine cannot tell those from a workflow it shipped and retired. Auto-deleting
  would be the engine destroying tenant files on a guess. So `extraFrozenFiles` surfaces them in
  the plan, in the PR body and in the `--json` envelope (`extra`), including on the `up_to_date`
  path, where the misleading line was. A human decides.

  ⚑ The real fix is a stamped manifest of what the engine wrote, which would make retirement
  mechanical and is a genuine design change, not a review fix. Recorded as the successor, not
  attempted here.

(r144)=
- **[R144] `oak check-post` posted nothing and reported success.** `cmdCheckPost` caught both post
  failures into `warnings` and returned `status: 'ok'` unconditionally; `cli.ts` then
  `return 0` regardless. So a Stage 2 that failed to create the Check Run went green.

  "Journal checks" is the DEFAULT required status check (`bootstrap.ts`, `protectMainBody`), so
  the Check Run is the merge gate itself. Failing to post it leaves the author's PR blocked by a
  check that will never arrive, with the only trace a `::warning::` inside a green job. It fails
  closed, so this is not an escalation; it is the false-green class ([R108]a, [R119]c) at the
  point where the verdict is supposed to land.

  The two failures are now distinguished, which is the whole finding: a COMMENT failure stays a
  warning, because the check still carries the verdict, while a CHECK RUN failure is an error and
  exits 1. That is a deliberate narrowing of the frozen shim's "never fails this job" rule, which
  is right for the cosmetic half and wrong for the gate. ⚑ `check-post.yml` keeps its own
  `continue-on-error` framing, so the job still does not fail the PR; what changes is that the
  step goes red and the operator can see which half failed.

## Pass A status (2026-09-01, end of session)

Reviewed and closed: the frozen surface, `zenodo.ts`, `gh.ts`, the release chain, `validate.ts`,
`bootstrap.ts`, `cli.ts`, `preview.ts`, the build path (`compose`/`materialize`/`build`/`myst`),
`upgrade`+`checks`. **Remaining: `messages.ts` and the leaves** (`schema`, `yaml-io`, `assets`,
`ref`). 476 tests, 144 ratified ids, every citation resolving.

⚑ **Owed before the next paper PR: a fleet `oak upgrade --files-only`.** Four merged changes touch
seeded files: [R133]'s `prepare.yml` token split, [R41]'s ref-class guard in the composite action,
[R136]'s PR-ownership check in `preview-deploy.yml`, and the frozen comment pass. Enumerate the
fleet at execution time rather than trusting a stored count.

**What this pass has been finding, stated plainly for whoever picks it up.** Two kinds dominate.
First, a guard that reads as protection and is not: a bypassable grep, a check on the schema when
the value enters through a raw read, an unfireable `..` clause. Second, a result that looks like a
pass: a swallowed API failure read as "no tags", a certification that certified nothing, a Stage 2
that posted no verdict and went green. Both are invisible to a green suite, which is why every fix
in rounds 4 to 11 ships with a mutation that was run and seen to fail.

The method also caught its own author three times (a test that passed against unfixed code because
`??` ignores an empty string; a dead guard clause; a fix placed on the schema that left the path it
was written for open). That is the evidence it is worth its cost, and the reason the mutation step
is not optional.

(r145)=
- **[R145] [R134]'s empty-value refusal broke the conformance harness's documented self-skip.**
  A regression introduced by this review, found by looking ahead at the release rather than by any
  test. `conformance.yml` passes `--fork-repo "$FORK_REPO"` unconditionally, and its own comment
  promised that when the fork is not provisioned "the flag is empty and the phase self-skips, so
  certs keep working". Since [R134], an empty flag value is a `UserError` at exit 2, so on any
  installation without `CONFORMANCE_FORK_REPO` the whole cert run would have died at argument
  parsing, before certifying anything.

  Fixed in the caller, not by weakening the rule: the flag is now passed only when it has a value
  (a bash array, so an unset var contributes no argument at all). [R134] stands, and the workflow
  now says what it means, which is that the flag is optional rather than optionally-empty. The
  same shape is worth checking wherever a workflow interpolates an optional `vars.*` into a flag.

  ⚑ This is the third time in this review that a correct general rule broke a specific degrade
  path (see [R133]'s load-bearing fallback and [R143]'s tenant files). The pattern is worth
  naming: when a fix makes something stricter, grep for the callers that were RELYING on the
  looseness before merging, not after.

## Ratified deltas (2026-09-01, round 12: the first live cert of this review's work)

`v0.0.0-dev.35` cut from `db9bf6c` and certified against the standing fixtures (run 33514858575).
**FAILED, correctly, on a real defect this review introduced.** The cert record:

    "status": "failed", "path": "push-main",
    "failure": "PR #44 Journal checks never appeared, though every run on its commit has finished"

That sentence is [R113]'s work: the harness distinguished "the check is late" from "the check is
absent" and refused to wait out a verdict that was never coming.

(r146)=
- **[R146] P1 changed the Stage-1 → Stage-2 artifact contract, and an upgrade PR runs the two
  halves at DIFFERENT versions.** `check.yml` (Stage 1) runs from the PR head; `check-post.yml`
  (Stage 2) always runs from the base, by design ([R91]). So on the very PR that installs a new
  shim, the new Stage 1 meets the old Stage 2. P1 stopped writing `head-sha` into the artifact;
  every already-deployed `check-post.yml` still does `cat journal-checks/head-sha` and exits 1.

  Every paper repo's `oak upgrade --files-only` PR would have failed its own journal checks, and an
  editor looking at a red required check would reasonably not merge it. The fix would have been
  unable to install itself, across the whole fleet.

  Fixed by writing `head-sha` again, unread. The security property lives in Stage 2 not READING it
  (`check-post.yml` takes the sha from `workflow_run.head_sha`), which is untouched; writing it
  costs nothing and keeps the previous Stage 2 working. The comment says to drop the write once no
  repo runs a shim older than v0.0.3.

  ⚑ The general rule, worth carrying: **the frozen shim's artifact is a versioned interface between
  two halves that upgrade at different times.** Removing a field from it is a breaking change to a
  contract whose other end is whatever the fleet last installed. Additions are safe; removals need
  a release of tolerance first. Nothing in the record said this before, which is why P1 did it.

  ⚑ Also noted, not a defect: `check.yml`'s upload `path:` still listed `head-sha` while nothing
  wrote it. Harmless (`upload-artifact` skips missing paths, and `if-no-files-found: error` fires
  only when all are missing) and now true again.

**This is the value of the release-then-certify order.** Reading found nothing here across a full
piecewise review of the frozen surface; a single live run found it in four minutes, before the
fleet rollout rather than during it. It is the second time a live conformance run has produced a
finding no amount of reading did ([R117] was the first).

(r147)=
- **[R147] [R134]'s empty-value refusal was built on a premise that does not hold, and it broke the
  build.** The second cert (`v0.0.0-dev.36`) got past [R146] and failed further along, on
  `preview-same-repo`, with every PR build dying at:

      ::error::--base-url needs a value. It was passed with none...

  `ci/run.sh` passes `--base-url ""` deliberately: empty means "served at the Cloudflare root",
  which is what a PR preview wants. It is a legitimate value, not a vanished one.

  The premise was that an empty value falls through to an env fallback. It does not:
  `flag(...) ?? process.env.X` uses nullish coalescing, so `''` is returned as-is and only
  `undefined` (a TRAILING flag with nothing after it) reaches the environment. [R131]'s real
  finding was the trailing case, which is genuine and stands. [R134] then widened it to `''` on a
  danger that was never there, and the widening is what broke two legitimate callers ([R145]'s
  `--fork-repo`, and this).

  Narrowed: `flag()` refuses a MISSING value and a `--`-prefixed one; an empty value is returned
  as-is, and the one flag where empty is genuinely a mistake (`--instance`, whose fallback message
  tells the operator to pass the flag they just passed) checks for it at its own call site. That is
  where the knowledge lives: only the call site knows whether empty means something.

  ⚑ **This would have broken every paper build in the fleet**, on every PR, had a stable release
  been cut from it. Caught by the second cert, on the path after the one the first cert failed on:
  a single run only ever proves the paths it reaches, so a failing cert hides whatever lies beyond
  its first failure.

  ⚑ I had already written the lesson down in [R145] ("when a fix makes something stricter, grep for
  the callers relying on the looseness BEFORE merging") and then did not do it: I fixed the one
  caller the failure named and never ran the grep. Writing a lesson in the ledger is not the same
  as applying it. The grep has now been run across `ci/run.sh`, the engine workflows and the frozen
  workflows; `--instance` in `run.sh` is guarded by `[ -n ... ]` already, and the `${{ }}`
  interpolations in the frozen workflows are all GitHub-set values that cannot be empty.

(r148)=
- **[R148] The fleet rollout has an ORDER, and the scheduled version bump can break it.** [R133]
  changed the Zenodo token contract on both sides at once: `prepare.yml` now passes both secrets
  under their own names, and the CLI no longer falls back from the sandbox token to the production
  one. Those two halves must arrive together.

  A repo still on the OLD `prepare.yml` passes the chosen token under the name `ZENODO_TOKEN` and
  never sets `ZENODO_TOKEN_SANDBOX`. Give it a NEW engine and `--sandbox` finds nothing and
  refuses. The engine cannot be made tolerant here: the tolerance is exactly the cross-fallback
  [R133] removed, and restoring it would reopen the finding.

  So the rollout must land the frozen files BEFORE or WITH the version bump, never after:
  `oak upgrade --both`, not `--version-only` then `--files-only` later.

  ⚑ **`version-bump.yml` runs `oak upgrade --paper . --version-only --yes` on a schedule.** If that
  lands on a repo before its files resync, it opens exactly this window by itself, unattended. The
  window is narrow in consequence (an editor-dispatched sandbox prepare, with a clear error naming
  the missing secret) but it is opened automatically, which is the part worth knowing.

  Not fixed here: the durable answer is either a shim-version floor the engine checks, or landing
  the fleet resync before the next scheduled bump. The second is what this rollout does.

(r149)=
- **[R149] The refs API signals an absent ref with 422, and `ghOk` only tolerates 404.** Third cert
  (`v0.0.0-dev.37`) passed `push-main` and `preview-same-repo` and failed at `deposit`:

      "gh api failed (exit 1): gh: Reference does not exist (HTTP 422)"

  `deleteTag` is a deliberately tolerant teardown ("delete any stale one first"), and it runs on
  every cert. `DELETE /repos/{repo}/git/refs/tags/{tag}` answers an ABSENT ref with **422
  "Reference does not exist"**, not 404. Round 7 correctly made `ghOk` strict (404 means absent,
  anything else throws, so a forbidden DELETE can no longer read as a teardown that happened), and
  that strictness threw on exactly the case `deleteTag` exists to tolerate.

  `ghOk` now takes an optional `alsoAbsent` pattern and `deleteTag` passes `ABSENT_REF`. The
  knowledge stays at the call site, which is the only place that knows how ITS endpoint spells
  absence, the same shape as [R147]'s empty-value fix.

  ⚑ **Fourth time in this review that a correct strictness fix broke a caller relying on the
  looseness** ([R133], [R145], [R147], and now this). Three of the four were found by live runs,
  not by reading or by the suite. The pattern is now specific enough to state as a rule: *a fix
  that narrows what a shared helper accepts must be followed by reading every caller, and the
  callers that legitimately relied on the breadth need the knowledge pushed down to them, not the
  helper widened back.*

  ⚑ Also worth recording: each cert has failed on a LATER path than the last (push-main →
  preview-same-repo → deposit). A cert stops at its first failure, so it can only ever prove the
  prefix it reached. Three rounds was not thrashing; it is the shape of the instrument.

  ⚑ **Closed as a CLASS, not as the one failure.** Before cutting again, every `DELETE .../git/refs/`
  in `gh.ts` was grepped: four, of which the cert had reached one. `deleteBranch`,
  `deleteForkBranch` and the fork sweep had the identical bug and sit on the fork-preview phase,
  which no cert in this session has reached yet. All four now pass `ABSENT_REF`. This is [R149]'s
  own rule applied for once BEFORE the live run instead of after it, and it should have saved two
  cert cycles.

## Ratified deltas (2026-09-01, round 13: the cert's own escape hatch)

Fourth cert (`v0.0.0-dev.38`). It reached `preview-fork`, a phase no run in this session had
reached, and the class-wide [R149] fix applied before cutting held: no ref-delete failure. But the
verdict was **inconclusive**, and the workflow went GREEN:

    "status": "inconclusive", "path": "preview-fork",
    "reason": "gh api failed (exit 1): gh: This workflow run is not waiting for approval (HTTP 403)"

(r150)=
- **[R150]a `approveWorkflowRun` claimed a tolerance it did not have.** Its comment read
  "TOLERANT: a no-op error when approval isn't required", and it called plain `ghOk`, which
  tolerates only 404. GitHub answers an ungated run with **403 "This workflow run is not waiting
  for approval"**, so the tolerant path threw. The same comment said "whether fork runs need
  approval every time is UNCERTAIN... live-testing will settle it". It has: they are not gated
  every time, and the tolerant branch was the load-bearing one. Now passes `NOT_GATED`, the
  [R149] shape.

  ⚑ Seventh comment in this review found asserting a property the code does not have.

- **[R150]b And the cert reported that engine-side bug as a third party's fault, in green.**
  `isGitHubApiFault` matched `HTTP (401|403|429|5xx)` wholesale, so a 403 became `ThirdPartyError`
  → INCONCLUSIVE → exit 3 → `::warning::` → **exit 0**. By [R111] INCONCLUSIVE deliberately does
  not redden, because red must mean us. The classifier decided this was not us. It was entirely us.

  The distinction the code was missing: a third party fault is the API failing to SERVE us (a rate
  limit, a 5xx, a dropped connection). A 401/403 that is not a rate limit is the API serving us and
  REFUSING this request, which means a missing scope, an absent `permissions:` block, or a call
  that does not apply. Those are engine defects and must be red. `isGitHubApiFault` now matches
  rate limits and 429 explicitly, then 5xx and network errors, and no longer treats a bare
  401/403 as someone else's problem.

  ⚑ This is the [R108]a/[R119]c false-green class **inside the instrument built to detect it**. A
  missing `permissions:` block in a frozen workflow, the exact defect conformance exists to catch,
  would have certified green. Worth stating plainly: for four rounds the cert was trustworthy
  because it kept failing; the first time it went green it was wrong.

### [R41]'s guard: what is proven, and the one test still owed

Stated precisely, because a green cert will not settle it and should not be read as settling it.

**Proven.** The script logic, by `test/frozen-guards.test.ts`: `refs/pull/N/merge` and a bare
40-hex SHA are refused when `IS_FORK=true`; release tags, `v0.0.0-dev.N` and branches pass; a
non-fork run skips entirely. That is bash, not a runner, so it covers the script and not the
expression around it.

**Proven 2026-09-01, by reading the runner's own env block rather than the verdict.** The
`v0.0.0-dev.39` cert's fork phase opened PR #54 from `pollobbella/fixture-paper-repo` (confirmed
cross-repository: `head.repo.fork == true`). Its Paper CI log shows the step resolved:

    REF: v0.0.0-dev.39
    IS_FORK: true

So `${{ github.event.pull_request.head.repo.fork || false }}` evaluates correctly on a real fork
PR, the guard RAN rather than skipping, and it correctly allowed a released tag. The expression
half is settled.

⚑ The verdict could not have told us this: the guard fails open, so a green fork phase is equally
consistent with `IS_FORK` being empty and the check never running. The evidence is the logged
`env:` block, not the conclusion. Worth keeping as a technique: for a fail-open guard, read what
the runner resolved, not whether the job passed.

**Still owed: the NEGATIVE case.** Nothing has yet watched the guard REFUSE. Needs the fork
account's own token, which the harness holds as a secret and a local operator does not:

1. On `pollobbella/fixture-paper-repo`, branch off default.
2. Set `project.options.oaktree-sapling.version` in `myst.yml` to a bare 40-hex SHA of any engine
   commit, e.g. a commit on `main` that is not a release leaf.
3. Open a PR against `pollomarzo/fixture-paper-repo`.
4. **Expect:** Paper CI fails at the `refclass` step with "engine ref '<sha>' is a raw commit or
   an unmerged pull request".
5. If it instead builds, or fails later at `run.sh`'s `dist/cli.cjs` check, the guard did NOT
   fire and the expression is wrong.

Step 5 is the point: [R57]'s bundle check would refuse that ref anyway, one step later, which is
exactly how a dead guard would go unnoticed. The two must be told apart by WHICH step fails.

## CERTIFIED: `v0.0.0-dev.39` (2026-09-01)

    "status": "ok", "paths": ["push-main","preview-same-repo","deposit","preview-fork"], "skipped": []

All four trigger classes, nothing skipped, on the first cert since this review began that reached
a verdict of its own accord. Deposit bundle complete on the tag's Release (all five reserved
names). Same-repo preview and fork preview both served 200 from Cloudflare. Fork PR #54 was a real
cross-repository PR from a second account.

**Five rounds to get here, and the shape of them is the finding.** dev.35 failed at `push-main`,
dev.36 at `preview-same-repo`, dev.37 at `deposit`, dev.38 went green while INCONCLUSIVE at
`preview-fork`, dev.39 certified. Each failure was on a LATER path than the last, because a cert
stops at its first failure and can only prove the prefix it reached. Every one of the five defects
([R146], [R147], [R149], [R150]a, [R150]b) was introduced by this review's own fixes, and none was
caught by 485 unit tests or by a full piecewise read of the frozen surface.

Four of the five were the same shape: a correct strictness fix breaking a caller that relied on
the looseness. The fifth ([R150]b) was the instrument reporting an engine bug as a third party's,
in green.

**Decision 2026-09-01: the stable cut is HELD until Pass A finishes.** `v0.0.0-dev.39` is certified
but the fleet cannot pin it (dev tags are disposable and get pruned; no real paper deposits against
one), so the rollout waits for a stable release covering Pass A's remaining pieces too. The user's
call, over cutting now from the already-certified tree.

⚑ **Known cost, accepted:** the fleet stays on the old engine meanwhile, so [R139]'s preview-alias
collision remains live on every paper whose repo name is 17 characters or longer, and the security
fixes ([R133], [R41], [R136]) stay undeployed. Reopen this the moment Pass A's last piece lands.

## Ratified deltas (2026-09-01, round 14: `messages.ts`)

The most carefully written file in the repo, and it holds up: every `DOCS.*` key resolves, the only
flag named in a message that `cli.ts` does not accept is `--upload-pack` (the [R103] attack string,
quoted deliberately), and no `[R#]`, "frozen shim" or `build_type` reaches a printed string. Two
findings, both documentation-level, plus one durable fix.

(r151)=
- **[R151] The file states four output rules about itself and nothing enforced them, so two had
  drifted.**
  - Its list of the user-visible surfaces it cannot hold named `templates/paper/.github/workflows/
    preview.yml`, which has never existed, and omitted `ci.yml`, `prepare.yml` and
    `version-bump.yml`. A reader trusting it would miss three files' worth of tenant-visible job
    names.
  - Rule 2 bans "instance-config" as design-doc jargon, and three printed strings use it. But the
    term is the PRODUCT's own name for the thing in four tenant-facing template files, including
    `templates/instance/README.md`, the first thing a journal editor reads. So the rule is what is
    out of true, not the strings.

  ⚑ **Not renamed.** Whether a tenant should meet the word "instance-config" at all is a naming
  decision across the whole tenant surface (templates, READMEs, the docs that do not exist yet),
  not a `messages.ts` edit. Rule 2 now says so explicitly and scopes itself to the terms that ARE
  enforced. The naming question belongs with the seeded-content pass.

  Fixed durably: `messages.test.ts` now lints rule 2 mechanically (no `[R#]`/`[S#]`, no "frozen
  shim", no `build_type` in any string literal past the header) and asserts the header names every
  workflow that actually exists, reading the directory rather than a list. Both rules were true
  when written and drifted silently because nothing checked them; that is the [R99] shape, one
  layer up.

(r152)=
- **[R152] The test suite leaks a temp directory per `mkdtempSync` and never removes one.** A long
  working session left **27,410** `/tmp/oak-*` directories and filled a 14G tmpfs to 80%; a second
  round of mutation runs added 3,830 more within the hour. Node then fails writes with
  `Unknown system error -122` (EDQUOT), which surfaces as dozens of unrelated suite failures.

  Twice in this session that looked like a regression in whatever had just been merged. Both times
  it was the disk. The cost is not the space, it is that **a full-suite red becomes ambiguous**,
  and this review's entire method rests on reading a red suite as signal.

  **FIXED same day**, and more cheaply than first estimated. The obvious fix was a shared `tmp()`
  helper at all 63 `mkdtempSync` call sites across 13 files; a vitest `globalSetup` module with a
  `teardown` export does it in one file instead, and cannot be forgotten at a new call site. It
  removes only dirs modified since the run started, so a concurrent session's dirs survive.

  Measured: **173 dirs leaked per run before, 0 after.** The first measurement was wrong and said
  173 both ways, because `git checkout vitest.config.ts` had quietly reverted the config between
  the two runs, so neither run had the teardown. A before/after comparison is only evidence if the
  "after" really differs; worth checking the change is still applied, the same way a mutation must
  be verified to have landed ([R150]'s prettier reformat).

## Ratified deltas (2026-09-01, round 15: the leaves, and Pass A closes)

`schema.ts`, `yaml-io.ts`, `assets.ts`, `ref.ts`. **No findings.** Recorded as Confirmed rather
than merely looked at, per the verdict taxonomy: a piece is done when its ledger checklist is
exhausted, and "the code matches the record" is a result.

What was checked, and holds:

- **The Layer A / Layer B boundary is real.** A tenant cannot suppress an engine invariant by
  listing it in `journal.yml` `checks:` with `optional: true`. `layerAResults`' `optional` flag is
  computed by the engine (`opts.strict ? false : severity === 'warn'`) and never read from tenant
  config, and Layer A gates through `errors`, which `blockingCheckFail` does not touch. This is
  [R119]a's class and it does not recur here.
- **`assets.ts` is clean.** `typstTemplateUrl` interpolates the author-controlled `version` into a
  URL path, where `..` would normalize across repos, but it builds only the ENGINE fallback in
  [R76]'s precedence chain (`assetOverrides > author > tenant > engine`). An author who wants a
  different template declares `template:` and outranks it outright, so the traversal buys nothing
  they do not already have. Explicitly NOT recorded as a finding.
- **`yaml-io.ts`'s readers follow STYLE.md's absence rule.** `readAuthorTypstTemplate` catches a
  parse failure and returns undefined; `readTenantTypstTemplate` does not, and the asymmetry is
  right: the first uses `.toJS()` (throws), the second `.get()` (does not).
- **`ref.ts` matches the guard now in the composite action.** Its model and the shipped `refclass`
  step agree on which classes are refused from a fork. ⚑ `classifyRef` labels `v0.0.0-dev.N` as
  `branch` rather than `tag` (its regex is strict semver); both are allowed, so behaviour matches
  and the label is cosmetic.

**Pass A is complete.** Every piece in the ordering has been read against its ledger slice: the
frozen surface, `zenodo.ts`, `gh.ts`, the release chain, `validate.ts`, `bootstrap.ts`, `cli.ts`,
`preview.ts`, the build path, `upgrade`+`checks`, `messages.ts`, the leaves. 487 tests, 152
ratified ids, every citation resolving.

The leaves being clean is the review plan's own prediction holding: "leaves last, load-bearing
plumbing whose bugs the verb reviews will mostly have flushed out by arriving at them from above."

## CERTIFIED: `v0.0.3` (2026-09-01) — the first stable release carrying this review

    "status": "ok", "paths": ["push-main","preview-same-repo","deposit","preview-fork"], "skipped": []

Cut from `b218583` (Pass A complete + the version bump), certified on all four trigger classes.
[R114]'s window was open for the ~6 minutes between the cut and the verdict, which is the accepted
cost of that decision; it closed green, so `releases/latest` now means certified.

**What `v0.0.3` carries, relative to `v0.0.2`:** 29 merged PRs. The untrusted-surface fixes
([R133] the sandbox/production token split, [R41] the engine ref class, [R136] the artifact PR
number, [R137] the untrusted report), the live preview-alias collision ([R139]), the false-green
class ([R108]a, [R119]c, [R144], [R150]b), the partial-provisioning work ([R125]), and the record
corrections ([R118], [R124]).

**Fleet rollout is now unblocked**, in this order:
1. `oak upgrade --both` per paper repo, NEVER `--version-only` first ([R148]).
2. Enumerate the fleet at execution time; the stored count has been wrong before.
3. Fixtures and ONE real paper first, then stop and check, because a bad frozen file costs a
   re-copy per repo.

**Decision 2026-09-01: the fleet upgrade waits for Passes B and C.** `v0.0.3` is certified and the
rollout is technically unblocked, but the user's call is to roll once, after the whole review, not
per pass. Consistent with the earlier hold on the stable cut.

⚑ Standing cost, unchanged and worth restating each time this is deferred: the fleet runs the OLD
frozen shim and the OLD engine, so [R139]'s preview-alias collision is live on every paper whose
repo name is 17+ characters, and the untrusted-surface fixes ([R133], [R41], [R136], [R137]) are
built, certified and undeployed. The exposure is not growing, but it is not zero either.

## Ratified deltas (2026-09-01, Pass B round 1: the untrusted-PR surface, re-derived)

Pass B: an adversarial re-audit of the frozen shim against the same
threat actor (an author who notices CI runs their code, plus a logged token). The plan's H1-H7 are
mostly closed by Pass A ([R136], [R41], [R137], [R141]); re-derived from the code, two holes were
still open. Frozen-file changes, so batched into one PR and one fleet `oak upgrade --files-only`.

(r153)=
- **[R153] H2 was closed for the artifact values and left open for the one that matters: `args`.**
  Pass A removed `head-sha`/`pr-number` from the shell path ([R90]/[R91]) by taking them from the
  event, but the composite action's dispatch step still spliced `${{ inputs.args }}` straight into
  a bash `run:`. That is the [R103] class ("an argv array stops the shell, not the callee's parser;
  a spliced string stops nothing") sitting in the highest-value job in the system.
  - `publish.yml` passes `release --tag ${{ github.ref_name }}`, and `git check-ref-format` permits
    `$( )`, backticks and `;` in a tag name. Demonstrated against real git:
    `git tag 'v1.0.0$(id)'` is accepted. Demonstrated against the shipped script by
    `test/frozen-guards.test.ts`: a dispatch of `release --tag v1.0.0$(touch${IFS}pwned)` creates
    the file against the unfixed step and does not against the fixed one; backtick and `;` variants
    likewise. That job holds the production `ZENODO_TOKEN` and a write `GH_TOKEN`.
  - **Bounded, and stated precisely rather than inflated.** The `v*` push that triggers
    `publish.yml` is gated by the `editors-only-v-tags` ruleset on a provisioned repo, so this is
    not a fork-author escalation: the tag-pusher is an editor. It is an author-INFLUENCED value
    (an author proposes the version an editor tags) reaching a shell splice in a token-bearing job,
    which is exactly the class Pass A hardened everywhere else. Not run end to end through a live
    `publish.yml` (that needs an editor v-tag push and would deposit to Zenodo); the mechanism is
    proven at the git level and at the shipped-script level, and that is what is claimed.
  - **Fixed by moving the value to `env:` and word-splitting it unquoted** (`ARGS`, `set -f` so
    splitting does not also glob). The verb and its flags still split, which the shim relies on;
    a metacharacter no longer starts a command. The same `run:`-splice pattern in `ci.yml`
    (`.pr-number`) and `check.yml` (`head-sha`, `pr-number`, `validate.outcome`) carries only
    GitHub-set values (an integer, a hex sha, an enum) that are shell-inert today, but they are
    the same anti-pattern, so all were converted to `env:` reads and a lint now keeps the class
    dead across the whole frozen surface.
  - `test/frozen-guards.test.ts` grew a `dispatch` group (five cases, each injection half proved
    against the unfixed step) and a lint over every frozen `run:` asserting none contains `${{`.
    This is the [R99]/[R90] lesson applied as a gate rather than a comment: a value that reaches a
    script must arrive through `env:`, checked mechanically so it cannot drift back.

(r155)=
- **[R155] The composite action wrote a fork-controlled value to `$GITHUB_OUTPUT` unchecked, and
  its ref-class guard was line-oriented, both the [R90] shape.** The `ref` step does
  `ref=$(yq '.project.options["oaktree-sapling"].version' myst.yml)` then
  `echo "ref=$ref" >> "$GITHUB_OUTPUT"`. On a PR, `myst.yml` is fork-controlled, and a block-scalar
  `version: |` carrying a newline makes `$ref` multi-line. Demonstrated at the shell level:
  `ref=$'v0.0.3\ninjected=PWNED'` writes a SECOND `name=value` line into `$GITHUB_OUTPUT`, and the
  `refclass` guard (`printf '%s' "$REF" | grep -Eq '...'`) is line-oriented, so a forbidden class
  on one line beside a benign line neither matches on the benign line nor blocks. This is exactly
  [R90]'s "grep -q is line-oriented" and [R91]'s "any value it acts on must be checked", one step
  earlier in the same file.
  - **No privilege escalation demonstrated, and that is stated rather than glossed.** The consumed
    security-relevant outputs (`engine` repo, `instance`) live on the SEPARATE `pins` step, not
    injectable from `ref`. `refclass` and the `checkout` both read the same resolved
    `steps.ref.outputs.ref`, so output injection cannot make the guard and the checkout diverge
    (last-write-wins gives both the same value; a forbidden ref that reaches the checkout also
    reaches the guard and is refused). So this is a bypassable-guard / output-injection class
    defect, closed as defense-in-depth on a frozen file already open in this PR, not a proven RCE.
  - **Fixed** with a positive charset guard on `$ref` before the echo: `case "$ref" in
    *[!A-Za-z0-9._/-]*) exit 1` refuses a newline, a space and every shell metacharacter, which no
    real git ref carries (`v1.2.3`, `refs/pull/N/merge`, a 40-hex sha, `main`, `v0.0.0-dev.N` all
    pass). The `refclass` grep is left as is: it now only ever sees a single-line, charset-clean
    value. `test/frozen-guards.test.ts` grew a `ref`-step group (stubbing `yq` on PATH and pointing
    `$GITHUB_OUTPUT` at a real file), each half proved against the unfixed step: the injection line
    never appears, and metacharacter versions are refused.

⚑ **Fleet action owed on merge:** `oak upgrade --files-only` (with Pass A's still-undeployed
[R133]/[R41]/[R136]/[R137] batch, per the standing hold). Enumerate the fleet at execution time.

## Ratified deltas (2026-09-01, Pass B round 2: preview origin code execution, confirmed live)

H6 in the plan treated a fork preview as "arbitrary HTML on a cross-site origin, low". Re-running
it found more: the fork controls the artifact BYTE for byte, and Cloudflare Pages reads control
files at the deploy root that turn a static upload into an ORIGIN.

(r154)=
- **[R154] A fork can execute code and set open redirects on the tenant's preview origin.** Proved
  live, Pass B: fixture fork PR #58 (`pollobbella` -> `pollomarzo/fixture-paper-repo`) added a step
  to its own `ci.yml` writing `_worker.js` into the build output. The preview served
  `PASSB-WORKER-EXECUTED <path>` with the attacker's header for EVERY path, i.e. the fork's Worker
  ran on `oaktree-sapling-test.pages.dev` (the tenant's real Pages project). `_redirects`/`_headers`
  reach the same origin, giving an open redirect and response-header control under the journal's
  Pages domain.
  - Worse than [R83]'s H3 leak (which turned symlinks into STATIC files): this is active code on
    the preview origin, which is same-site to every other preview in the project. Still cross-site
    to a `github.io` journal, so the [R136]/H6 boundary to the journal itself holds; the exposure
    is the preview origin and everything sharing it.
  - **Fixed in the engine (Stage 2, trusted), not the frozen shim.** `cmdDeployPreview` now calls
    `stripPagesControlFiles(siteDir)` right after `takePrNumber`, before any deploy path (including
    the artifact-link degrade), removing `_worker.js`, `functions/`, `_routes.json`, `_redirects`,
    `_headers`, `_middleware.js` from the deploy root. Deliberately engine-side: `ci.yml` is
    fork-controlled, so a Stage-1 strip is a guard a fork deletes in the same commit (the symlink
    note already says this); the strip that counts runs in base context behind the pinned release.
    A paper preview is static MyST output, so none of these files is legitimate.
  - Each half proved against unfixed code: neutering `stripPagesControlFiles` fails the unit tests;
    removing the `cmdDeployPreview` call fails an integration test that snoops the dir the fake
    deployer is handed. The shipped bundle was run against a planted `_worker.js` + `_redirects`
    and both were removed before the deploy step.
  - **NON-frozen**, so it ships with the next version bump, not a `--files-only` re-copy.
  - ⚑ **Residual:** conformance's `preview-fork` phase asserts a 200, not that a planted control
    file was stripped, so it would not catch a regression of this. A C-case that plants `_worker.js`
    on the fork branch and asserts the served origin does NOT execute it is the durable guard;
    deferred as its own item, matching the other conformance-assertion gaps ([R123]/[R113]f).
  - Live proof of the FIX end to end (deploy the stripped dir to Cloudflare, confirm no Worker
    executes) is owed at the first dev cut that carries this, since CF tokens live only in GH
    secrets; the unit + integration + shipped-bundle proofs cover the strip itself.

## Pass B status (2026-09-02): the untrusted-PR surface, re-derived

Every hypothesis re-derived from the code, not the 2026-08-01 plan. Verdicts:

- **H1 (forge a green verdict).** Refuted-as-designed, unchanged. `check-post` posts the report's
  `conclusion` verbatim, but forging it needs editing a CODEOWNERS-gated frozen file, which H4
  proved cannot merge unreviewed; [R83]'s advisory banners a shim-touching PR. Residual accepted.
- **H2 (artifact content into a privileged shell).** The head-sha/pr-number path was closed by
  [R90]/[R91]; re-checked live that `check-post.yml`'s meta guard (`[[ =~ ]]`, not `grep -q`)
  refuses a multi-line `pr-number`. The one hole left was `args`, spliced into a bash `run:` and
  reachable via a crafted `v*` tag in the token-bearing publish job: **[R153]**, fixed. The related
  `ref`-step output injection is **[R155]**, fixed. H2 now closed.
- **H3 (extraction overwrites the shim).** Refuted, as Pass A found: `upload-artifact` stores a
  symlink's target as a regular file, and a real dirent cannot be named `..`, so the artifact
  carries no traversal entry. The "serve arbitrary content" side effect [R83] noted is escalated
  by **[R154]** (active code on the preview origin) and fixed there.
- **H4 (CODEOWNERS inert without protection).** The provisioning is effective ([R128]). The gap
  is that conformance tolerates a fixture provisioned before that work and never asserts the
  rulesets or the `zenodo-publish` reviewer are there, so the harness cannot tell a protected repo
  from an unprotected one ([R123]). Not re-fixed; the C-slice that reads rulesets back is the right
  home and stays deferred. It also means [R153]'s v-tag vector is only gated where the ruleset was
  actually applied, which is what that C-slice would establish.
- **H5 (Stage 1 exfil).** Confirmed, unchanged. `ci.yml` build and `check.yml` validate both hold
  `contents: read` only; the Pages deploy job is `if: github.event_name != 'pull_request'`, so a
  fork PR never reaches the write token.
- **H6 (preview on the journal's name).** Was low; re-running it found active code execution on the
  preview origin, confirmed live: **[R154]**, fixed. The cross-site boundary to a `github.io`
  journal still holds.
- **H7 (token minimization).** Code-clean, unchanged: four secrets seeded, tokens by env not argv,
  `wrangler` pinned ([R109]). No new finding.

**Net:** two genuinely-open holes (H2's `args`, H6's active content), plus a class-closure on the
composite action ([R155]). Three PRs, none merged: two frozen ([R153]+[R155] in one, held for the
fleet re-copy) and one engine-side ([R154], ships with the next bump). 497 tests green.

## Ratified deltas (2026-09-02, Pass C opens: STYLE.md codifies terse comments)

Pass C: style, comment retirement, and the reuse/simplification/altitude
cleanups Passes A and B deferred. User's call: full sweep (not comments-only), each piece its own
PR, and amend STYLE.md so the standard is written down rather than applied by judgement. Ships
before the fleet rollout.

(r156)=
- **[R156] STYLE.md's Comments section licensed narrative, which is what produced the verbose
  comments this pass retires.** It read "comments here are load-bearing and the usual delete-what-
  narrates advice does not apply wholesale". Pass B's PRs were called out as over-commented against
  exactly that licence. Rewritten to "strictly necessary and short: state the constraint, not the
  story around it": a constraint stays in one line citing its `[R#]` (the `[R#]` holds the
  "what would go wrong"), a why-not-obvious note stays in a line, narration goes, a long rationale
  becomes a link or an id. This is the bar every Pass C piece applies; landing it first so the
  standard is reviewable on a small diff before it is applied across the codebase.
  - **Revised after review (2026-09-03).** The section now states ONE pointer rule (cite the
    reference the reader of THIS file can open: `[R#]` for engine internals, the user doc page for
    a verb's observable behaviour, self-contained where neither resolves) rather than accumulating
    cases; adds two rules the sweep needs before it is written down, an evergreen rule (no
    "used to"/"replaces": describe the code as it is) and a keep-category for "why this looks wrong
    but is not" (it reads as narration and is the one an agent deletes); pins the JSDoc regime
    (contract first, a constraint riding along is still one line + `[R#]`); shows the example as a
    literal BAD/GOOD pair; and tightens the opener to one line. The success criterion is "every
    `[R#]` resolves, no constraint lost", not a line-count delta.

(r160)=
- **[R160] The doc-resolution check the review asked for already exists.** It asked doc links to
  get the CI treatment `[R#]` has. `docs-links.test.ts` ("every documentation topic resolves")
  already iterates the `DOCS` table and asserts, per entry, that the page file exists AND the
  `(label)=` anchor is present in it, wired into `npm test`. So the rule is not "build a checker"
  but "cite a `DOCS.*` symbol, never a raw path or URL": a symbol is checked, a raw path is not,
  and a raw path to a non-existent page is what rotted in R157's first attempt. STYLE.md states the
  rule and names the test. No new gap; the pattern was established in piece 1 (below).

## Ratified deltas (2026-09-02, Pass C piece 1: `preview.ts`)

First piece, applying [R156]'s standard. `preview.ts` was already well-factored locally (one
`STICKY_MARK`, thin named comment builders, injected seams), so its debt was the comment layer.

(r157)=
- **[R157] `preview.ts` comment retirement.** The module header dropped from a four-bullet port
  narrative to role + the three load-bearing constraints ([R16] never-fail, the Stage-2 rationale,
  the seams). Sixteen JSDoc/inline blocks tersed to the constraint plus its `[R#]`. 442 lines to
  394; every `[R#]` and every invariant kept, no behaviour change, 43 tests green. No local
  simplification was warranted, and none was invented; the sweep's reuse findings are cross-module,
  below.
  - **Adjusted after review (2026-09-03).** Restored three cuts that were load-bearing, not
    narration: `PAGES_CONTROL_FILES`' membership criterion (what qualifies for a security list is
    exactly what the next editor needs), the catch block's "not error-swallowing" (the
    looks-wrong-but-isnt category [R156] now names), and `firstLine`'s "`[`" (why it cannot just use
    `e.message`). Applied the settled pointer rule to `cmdDeployPreview`: the four-step enumeration
    is observable behaviour, so the JSDoc keeps only the contract plus the two non-obvious
    invariants (never-fails, no-op). Success criterion is "every `[R#]` resolves, no constraint
    lost", not the line delta.
  - **Corrected again (2026-09-03).** The first attempt pointed the JSDoc at
    `docs/verbs/deploy-preview.md`, a page that does not exist, in the wrong form: the docs
    convention is a `DOCS.*` symbol (`docs-links.ts`), and there was no verb reference section.
    Resolved with the user's chosen pattern (2026-09-03): a **stub target + symbol**. Added
    `docs/reference/cli.md` (a CLI reference with a `(deploy-preview)=` labelled section, minimal
    but truthful), wired it into the toc, and added `DOCS.cli` / `DOCS.deployPreview`. The JSDoc
    now cites `DOCS.deployPreview`; `docs-links.test.ts` proves the symbol resolves to the page +
    anchor (503 green). The stub is fleshed out later by the docs initiative without the symbol or
    the anchor ever changing, so the link never rots. This is the template for the remaining verbs'
    observable-behaviour references across Pass C.
  - **Loop closed both ways (2026-09-04).** `docs-links.test.ts` asserted symbol → page; nothing
    asserted comment → symbol. A `DOCS.foo` in code is typechecked, but in a COMMENT it is not, so
    a renamed key would leave the citation dangling. Added a guard: every `DOCS.<symbol>` named
    anywhere in `src/` must be a real key, proved by mutation. So comment → symbol → page + anchor
    is checked end to end.

### Open queue from Pass C piece 1 (cross-module reuse, own PR)

(r158)=
- **[R158] `firstLine(e)` is defined twice.** `preview.ts` (zod-aware: names the offending key)
  and `bootstrap.ts:696` (plain first line). The zod-aware one is a superset. Extract one shared
  helper (candidate home: `messages.ts`, which both import and which owns `annotate`/`UserError`),
  and have both call it. Deferred to a shared-helpers PR so it does not cross this piece's boundary.
(r159)=
- **[R159] The `<!-- oak-sticky: <header> -->` marker is built in four places.** `preview.ts`
  (`STICKY_MARK`), `checks.ts:215`, `gh.ts:361` (the `sticky` impl), and `conformance.ts:326`
  (`PREVIEW_STICKY_MARK`). One `stickyMarker(header)` exported once, imported by the rest. Same
  shared-helpers PR.

## Ratified deltas (2026-09-04, Pass C piece 2: shared helpers)

- **[R158] `firstLine(e)` deduplicated.** The zod-aware version (names a zod failure's offending
  key, else the first non-empty trimmed line) now lives once in `messages.ts`, exported beside
  `annotate`/`UserError`; `preview.ts` and `bootstrap.ts` import it and their local copies are
  gone. No cycle: `messages.ts` imports only `docs-links.ts`, and both callers already import it,
  so nothing points back. Behaviour unchanged; the superset only differs on inputs bootstrap's
  callers never see (real `gh` stderr has a non-empty first line, giving an identical result).
- **[R159] `stickyMarker(header)` deduplicated.** One exported helper in `messages.ts` returns
  `` `<!-- oak-sticky: ${header} -->` `` (byte-identical, so `gh.ts`'s `sticky()` still finds and
  replaces existing comments). The four sites (`preview.ts`, `checks.ts`, `gh.ts`,
  `conformance.ts`) call it; the local builders are gone. `messages.ts` is the only low-level
  module all four reach without closing a loop (it imports only `docs-links.ts`); the marker is the
  upsert-key line of the `msg.pr.*` comment bodies that already live there. Behaviour unchanged.

## Ratified deltas (2026-09-04, Pass C piece 3: the leaves)

`schema.ts`, `yaml-io.ts`, `assets.ts`, `ref.ts`. Pass A found these clean; the sweep confirms the
comments are load-bearing and kept them.

(r161)=
- **[R161] `schema.ts` one JSDoc reattached, the leaves otherwise unchanged.** The
  `OaktreeSaplingOptions` "one knob" JSDoc had drifted above `EDITION_ID` (which has its own doc),
  so it documented nothing; moved back onto its export and the trailing "resilience is free"
  narration trimmed to a one-line `.loose()` constraint. `yaml-io.ts`/`assets.ts`/`ref.ts`: no
  change, every comment is a constraint, a named dead end, or a looks-wrong-but-isnt guard under
  [R156]. 504 tests green.
  - Verb-doc candidates recorded for the later docs PR (config-field observable behaviour, not CLI
    verbs): `RegistryEntry.site_url`, `JournalConfig.typst_template`, `PreviewConfig.provider`.

## Ratified deltas (2026-09-04, Pass C piece 4: the build path)

`compose.ts`, `materialize.ts`, `build.ts`, `myst.ts`. `compose()` stays pure; `myst.ts` stays the
only myst-cli importer; the two-pass materialization is preserved.

(r162)=
- **[R162] `compose.ts` tersed, one dead import dropped in `build.ts`.** The whole-entry-merge and
  template-precedence comments cut to their constraints, keeping the load-bearing kernels (exports
  merge by id whole-entry so the winner must be complete, [R52]/[R53]; a `template:` on the
  resolved export can only be the author's, [R72]/[R76]) and dropping the meta-narration.
  `build.ts` lost an unused `node:path` import (the `join` on the hot path is `Array.join`).
  `materialize.ts`/`myst.ts` unchanged (comments load-bearing and already terse). British spelling
  fixes in two test descriptions. 504 tests green.
  - Verb-doc candidates: `compose()`/`ComposeResult`, `runBuild`/`runStart`, `MystEdge`.

## Ratified deltas (2026-09-04, Pass C pieces 5-6: zenodo and cli)

(r163)=
- **[R163] `zenodo.ts` tersed; three exports gained a contract JSDoc.** Python-port history dropped
  from `createFetchTransport`, `listMyDepositions`, `buildMetadata`, `templateArchiveDir`; every
  invariant and `[R#]` kept (concept-DOI "not found" gating [R100], reserved-name collision,
  overwrite guarantee, sandbox/prod host derivation, filename encoding). A `buildBundle` JSDoc that
  had stranded above `assertBundlePreconditions` was reattached, and `buildMetadata`/`cmdStatus`/
  `conceptDoiFor` got the JSDoc they lacked. No citation lost, 504 green.
(r164)=
- **[R164] `cli.ts` tersed; two local dedupes.** Narration and "used to" history trimmed across the
  verb JSDocs and guards while keeping every argument-shape guard and its `[R#]`
  ([R131]/[R133]/[R134]/[R136]/[R137]/[R147]). A `cmdValidate` JSDoc stranded above
  `readEditionQuietly` was reattached. `assetOverridesFrom` and `startOptsFrom` each called
  `flag()`/`num()` twice per field; now computed once into a local (drops a non-null assertion,
  no double port-parse). No citation lost, 504 green including cli-output against the built bundle.
  - The full **verb-doc candidate list** (11 verbs) is captured for the consolidated docs PR that
    ends Pass C: build, start, validate, check-post, deposit, release, deploy-preview, notify,
    bootstrap, upgrade, conformance.

## Ratified deltas (2026-09-04, Pass C pieces 7-10: gh, bootstrap, conformance, validate)

Four modules, each terse-comment + one genuine within-module simplification, no behaviour change,
no `[R#]` lost, 504 green. (The four agents each saw a transient 9-failure `cli-output` blip from a
stale `dist/cli.cjs` in their worktree; `npm test` bundles first and was green, confirmed on main.)

(r165)=
- **[R165] `gh.ts`.** A misplaced `[R103]` transport-allowlist comment (it sat over the `[R138]`
  `owner/name` check) moved onto `assertIngestSource`, its real subject. The identical
  `refs/heads/` strip in `listBranches` and `sweepForkBranches` folded into `matchingHeadRefs`.
(r166)=
- **[R166] `bootstrap.ts`.** Three long JSDoc rationales compressed to the constraint + `[R#]`
  (`engineMystRange`, `STAMP_RENAME`, `renderSiteTemplate`), four redundant step-name labels and
  two unused imports (`existsSync`, `writeDoc`) removed. Every provisioning invariant kept.
  - Noted, not fixed: `cmdBootstrapPaper`/`cmdBootstrapJournal` carry no top-level contract JSDoc
    (rich inline docs only). A gap, left to the verb-docs capstone rather than churned here.
(r167)=
- **[R167] `conformance.ts`.** Four near-identical workflow-run poll bodies folded into one
  `runOutcome(runs, find, label)` helper beside `checkOutcome`; error strings and control flow
  byte-identical, so the cert assertions still match. The `waiting`-gated first publish poll stays
  inline (does not fit the shape). No comment edits needed; all invariants already terse.
(r168)=
- **[R168] `validate.ts`.** The thrice-repeated `JournalConfig.parse({ name: 'unknown' })` literal
  extracted to `emptyJournal()` ([R116]); one test comment de-tensed off "old behaviour". The
  heaviest-cited module was already terse from Pass A; nothing load-bearing cut.

## Ratified deltas (2026-09-04, Pass C pieces 11-12: messages, checks + upgrade)

The last of the per-module comment sweeps. All three were already terse from Pass A, so the changes
are small and comment-only; no behaviour change, no `[R#]` lost, 504 green.

(r169)=
- **[R169] `messages.ts`.** One JSDoc de-tensed (`build.inJournalRepo`, a run-on narrating the past
  failure restated as the present-tense shape-check invariant). No printed string reworded (their
  text is `message-style.md`'s domain); the module's four self-documenting output rules ([R151])
  kept. As Pass A predicted, the most carefully written module needed almost nothing.
(r170)=
- **[R170] `checks.ts` + `upgrade.ts`.** Verbose rationale compressed to one-line constraints:
  `checks.ts`'s `toCheckRun` derived-config drop ([R82]), the notes-placement guard, the Stage-2
  header; `upgrade.ts`'s `readAnswers` de-tensed off an ENOENT-history. Every load-bearing fact
  kept ([R51], [R144], [R117], [R143], [R148]). No simplification warranted; none invented.

## Ratified deltas (2026-09-04, Pass C piece 13: the verb-docs capstone)

(r171)=
- **[R171] Every CLI verb's observable behaviour now has a user-doc stub + a `DOCS.*` symbol.**
  `docs/reference/cli.md` gained ten `(<verb>)=` sections (build, start, validate, check-post,
  deposit, release, notify, bootstrap, upgrade, conformance; deploy-preview already had one),
  `docs-links.ts` the ten symbols, and each `cmd*` JSDoc in `cli.ts` ends with
  `Observable behaviour: DOCS.<symbol>.`, with the step-by-step narration dropped and the contract +
  `[R#]` kept (`cmdBuild` gained the JSDoc it lacked). This realises [R157]'s pattern across the
  whole verb surface: `docs-links.test.ts` proves every symbol resolves to its page + anchor and
  that every `DOCS.<symbol>` cited in source is a real key, so no citation can rot. The stubs are
  fleshed out by the docs initiative without the symbols or anchors moving. Suite is 514 (the +10
  are the new symbol-resolution assertions), docs build clean.

## Pass C complete (2026-09-04)

Every module read against `STYLE.md`'s terse-comment standard ([R156]): the standard itself, then
preview, shared helpers, the leaves, the build path, zenodo, cli, gh, bootstrap, conformance,
validate, messages, checks+upgrade, and the verb-docs capstone. Fourteen PRs (#75-#88), each with
the suite green and every `[R#]` and invariant preserved (the success criterion, not a line delta).
The sweep also took the genuine local cleanups it found: shared `firstLine`/`stickyMarker`
([R158]/[R159]), `runOutcome`, `matchingHeadRefs`, `emptyJournal`, dead imports, and several
orphaned JSDocs reattached. No behaviour changed anywhere.

**The full A/B/C review is done.** Pass A (correctness), Pass B (the untrusted-PR surface), Pass C
(style + quality) are all complete. The standing hold on the fleet rollout ("after Passes B and C")
is lifted. The rollout has its own plan; its frozen batch now also carries Pass
B's [R153]/[R155] (composite-action hardening) and [R154] (preview control-file strip), on top of
Pass A's [R133]/[R41]/[R136]/[R137]. Cut a stable release, certify it, then
`oak upgrade --both` per paper repo, fixtures + one real paper first ([R148]).

## Release + conformance (2026-09-05): `v0.0.0-dev.40` certified 4-path

The A/B/C review's fixes reach the fleet only once a release carries them and each paper is moved
onto it. First step done: a dev release cut from `main` HEAD
`c325c5a` and certified.

- **Cut `v0.0.0-dev.40`** via the `cut-engine-release` workflow (run 33974357514, green). Pre-release,
  so it never becomes `releases/latest`. Tag leaf = source `c325c5a` + `dist/cli.cjs` + `bin/typst`,
  verified. 20 commits ahead of the last certified dev tag (`dev.39`); the new frozen-file delta is
  the Pass B composite-action hardening (`action.yml`/`check.yml`/`ci.yml`).
- **Conformance CERTIFIED, 4-path.** Post-cut `workflow_run` hook fired conformance (run 33974398858),
  approved through the required-reviewer gate, green in 4m37s. `cert.json`: `status ok`, `paths`
  = [push-main, preview-same-repo, deposit, preview-fork], `skipped []`. Fork phase RAN (forkPr 61,
  live `forkPreviewUrl`), so this is a real four-path cert, not a three-path one reading as four.
  `certify` installs via `oak upgrade --both`, so the fixture ran the NEW frozen `action.yml`.

### [R41] guard, live behaviour (the fail-open one)

The guard fails open (empty `IS_FORK` skips), so a green run is not by itself proof. Directions:

- **Skips on non-PR events**: PROVEN live. `push-main` is green, and it runs the same composite
  action; if `IS_FORK` fired on push, that path would have failed. On push/`workflow_run` there is
  no `pull_request` object, `null || false` = `false`, `[ "$IS_FORK" = "true" ] || exit 0` skips.
- **Does not wrongly block a legit fork PR**: PROVEN live. forkPr 61 pinned `v0.0.0-dev.40` (a tag),
  passed `refclass`, reached a preview URL.
- **Refuses a fork PR pinned to a raw SHA / `refs/pull/N/merge`**: script logic PROVEN on the exact
  shipped dev.40 bytes across the full matrix (IS_FORK true/false x ref class; a 40-hex SHA and
  `refs/pull/61/merge` both exit 1, tags/versions exit 0, empty IS_FORK exits 0). NOT YET proven in
  a live runner: it needs a fork PR carrying a bad pin, i.e. fork-side write. `pollomarzo` has no
  push access to `pollobbella/fixture-paper-repo` (404), and the fork PAT lives only in the
  `conformance` environment secret. Note: forkPr 61 being green does NOT prove `IS_FORK=true` was
  reached, because a tag pin passes whether the guard fires or skips; only a live refuse proves it.

### Gate

Stopped here, before any stable release or fleet PR (both are held: a stable cut needs the user's
go per the rollout plan, and fleet `oak upgrade` PRs must not be merged on the user's behalf).

**Decision (2026-09-05, user):** accept the current [R41] evidence. The live fork-PR refuse is left
unproven; the untested step is GitHub's own `head.repo.fork` context value, not engine logic, and
the script + live skip/allow cover the rest. Residual accepted, not closed.

## Stable release (2026-09-05): `v0.0.4` cut + certified

User's call: cut a stable marker for the A/B/C review now, leave the disposable fixtures as-is.

- **Cut `v0.0.4`** from `main` `c325c5a` (cut run 33977876617, green). It is `releases/latest`
  (confirmed via `releases/latest` API), leaf = source + `dist/cli.cjs` + `bin/typst`, parent =
  `main` HEAD. First stable since `v0.0.3`; carries all of Pass A/B/C ([R90]-[R171]).
- **Two-step stable act honoured ([R114]).** A stable tag becomes `latest` before conformance
  certifies it, so: cut, then watch the post-cut cert, yank/supersede if not green. Post-cut hook
  (run 33977913704) approved through the reviewer gate, green in 5m17s. `cert.json`: `status ok`,
  `paths` = [push-main, preview-same-repo, deposit, preview-fork], `skipped []`, forkPr 64 with a
  live `forkPreviewUrl`. Genuine 4-path CERTIFIED; the release stands.
- **npm untouched.** `cut-engine-release.sh` has no npm step, so `v0.0.4` is a git tag only; npm
  stays at `oaktree-sapling@0.0.2`. Provenance/OIDC for a published stable remains the `0.1.0`
  question.

### Fleet: no repin performed

Enumerated at execution time: the only repos pinning `pollomarzo/whitelabel` are seven disposable
test/fixture repos (`fixture-paper-repo`, `oak-bootstrap-test-paper`, `oak-journal-test`,
`uxtest-paper-one`, `oak-ingest-test`, `oak-h4-test`, `oak-preview-test`), on old dev tags. No repo
under `impact-scholars` or `pollomarzo` pins the oak engine as a real paper: the 2026-paper
migration onto the engine has not started, so the rollout's "twelve paper repos / one real paper
first" premise has no current subject. `fixture-paper-repo` is on `v0.0.4` as a side effect of the
cert's own `oak upgrade --both`; the other six test repos are left as-is per the user's call. The
real fleet repin waits on the real-paper migration (frontier).

(r172)=
## [R172] `prepare.yml` uses `secrets` in a step `if:`, DOI reservation is dead (2026-09-08)

Found while standing up a sample journal (`pollomarzo/sapling-review` +
`pollomarzo/sapling-2026-timescales`, external tier, pinned `v0.0.4`) and driving the Zenodo path.

**Bug.** `templates/paper/.github/workflows/prepare.yml:29` gates the sandbox-token guard with
`if: ${{ inputs.sandbox && secrets.ZENODO_TOKEN_SANDBOX == '' }}`. GitHub Actions does not expose
the `secrets` context in a step-level `if:`, so the whole workflow fails to parse.

**Evidence.** `gh workflow run prepare.yml -f sandbox=true` returns `HTTP 422 ... Unrecognized
named-value: 'secrets'` (position 19, `prepare.yml:29`). `workflow_dispatch` is the only trigger,
so the file is entirely dead: the editor-dispatched DOI RESERVATION cannot run on any paper. Present
in `v0.0.4` (certified) and on `main`. Scoped: the only `if:`-with-`secrets` in `templates/`.

**Why conformance missed it.** The 4-path cert drives push-main, preview (same-repo + fork), and
deposit-at-tag; it never dispatches `prepare.yml` (manual, editor-only), so a parse error there is
invisible to the harness.

**Fix (not yet applied to the engine).** Move the secret into the step `env:` and test it in `run:`,
leaving `if:` to read only `inputs.sandbox`:

    - name: Refuse a sandbox run with no sandbox token
      if: ${{ inputs.sandbox }}
      env:
        SANDBOX_TOKEN: ${{ secrets.ZENODO_TOKEN_SANDBOX }}
      run: |
        if [ -z "$SANDBOX_TOKEN" ]; then
          echo "::error::sandbox run requested but ZENODO_TOKEN_SANDBOX is not set; refusing to fall back to the production token"
          exit 1
        fi

Frozen-file change, so it rides the next release + `oak upgrade --files-only`, not a bare version
bump. A parse guard in `check.yml`, or a conformance path that dispatches `prepare.yml`, would have
caught it. **Demo unblock:** the sample paper's `prepare.yml` is patched locally to get a demo
sandbox DOI; that divergence is temporary and superseded when the engine fix ships.

**Applied (2026-09-19).** Fixed as prescribed above, with both halves proved against the unfixed
file. `frozen-guards.test.ts` gained a static check that no `if:` in the frozen shim reads
`secrets` (the parse fault, which no bash-level test can reach, and which that file's header
previously disclaimed) and a behavioural pair driving the guard script with the token set and
unset. Suite 515 to 519. Frozen-file change, so it reaches papers only through the next release
plus `oak upgrade --files-only`, and the sample paper's local patch is superseded then. Closes #90.

(r173)=
## [R173] Seeded files carry a pointer, not an explanation (2026-09-19)

`templates/` was the last comment surface never given a terseness pass. Pass C did `src/`
([R156]-[R171]) and the frozen paper shim had its own earlier; the author-owned seeds had
neither, and they are the worst case. `upgrade.ts:81` scans only `.github/` and `CODEOWNERS`
for drift, so everything else is stamped once and never resynced: a comment written there is
frozen in a tenant's repo, and the URL inside it is the only part that stays editable.

**Rule.** A seed comment says what the file or key is, in one line, plus a deep link to the
docs page that explains it. The explanation lives in `docs/`, which can still be rewritten
after a repo is stamped. A constraint stays inline only when it guards a wrong edit to that
exact line and is not already in docs. After this pass exactly one qualifies: the `site.yml`
note that myst exits 0 on a plugin that never loaded, which otherwise reads as redundant with
`--strict` and invites deleting the grep.

**Applied.** 150 comment lines to 57 across nine seeds, of which 44 are fill-in forms (the
commented-out author block, the registry example entry, the optional `zenodo:` keys) rather
than prose. Nothing was dropped: `reference/files.md` gained `(file-pages-index)=` and
`(file-site-workflow)=` plus the `license`/`LICENSE` note under `#file-editions`, and
`start/paper.md` §2 gained the `extends:` explanation.

**Two defects it surfaced.** `site.yml`'s `--strict` comment asserted both that `--strict`
catches a plugin that never loaded and that it does not; the second is correct and is why the
grep exists. `brand.yml` called `project.options.logo` a watermark, which `guide/branding.md`
had already recorded in prose as wrong ("the one the seeded comments call..."); that clause is
gone from the docs now the seed no longer says it.

**Guard.** `docs-links.test.ts` gained a fourth check: every `DOCS_BASE` URL under `templates/`
must resolve to a real page, and to a real `(label)=` target where it carries an anchor. The
three existing checks are `src/`-scoped, and a seeded URL is the one that cannot be fixed
later. Proved by typoing `#id-pattern` in `journal.yml`.

**Residual.** The eight `design/paper-ci` URLs in the frozen paper shim are covered by that
check now, but their files were left alone: `templates/paper/.github/**` is frozen-class, had
its pass, and a change there costs a fleet re-copy.
