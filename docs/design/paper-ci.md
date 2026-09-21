(design-paper-ci)=

# How a paper repository's CI is built

Every paper repository carries a small set of workflow files that the engine stamps in and `oak upgrade` keeps in sync. They are short, and they are shaped by one problem: a paper repository accepts pull requests from people who are not the editors, and building a paper means running their content.

This page is the reasoning. The files themselves stay brief and point here.

(design-paper-ci-two-stages)=

## Why every job is split in two

A pull request from a fork is untrusted input. Building it runs the author's MyST configuration, their plugins, and whatever their execution environment installs. That is fine as long as the job doing it holds nothing worth stealing.

But the useful outcomes all need write access: posting a check verdict, deploying a preview, commenting on the pull request. GitHub offers `pull_request_target` for that, which runs with the base repository's secrets. It is also the single most common way CI gets compromised, because it hands a write token to a job that has checked out someone else's code.

So each of those flows is two workflows instead:

| | Stage 1 | Stage 2 |
|---|---|---|
| trigger | `pull_request` | `workflow_run`, after Stage 1 finishes |
| context | the pull request's head | the base repository's default branch |
| token | read-only, no secrets | write, plus whatever secret the job needs |
| runs author content | yes | never |
| output | an artifact | the posted result |

Stage 1 computes and uploads. Stage 2 downloads and posts. The build and the token never meet.

`ci.yml` and `preview-deploy.yml` are one such pair, for the site preview. `check.yml` and `check-post.yml` are another, for the editorial checks.

(r13)=

Permissions are scoped to the job, not to the workflow. The workflow default is `contents: read`, and `pages: write` with `id-token: write` sit on the deploy job alone. Granted at workflow level they would also be held by the build job, which is the half that runs fork content.

(design-paper-ci-stage2-inputs)=

## What Stage 2 is allowed to believe

(r91)=

Stage 2 runs in the base context, but the artifact it downloads was written by Stage 1, and **on a pull request GitHub runs the pull request's own copy of the Stage 1 workflow file**. A fork can therefore edit what goes into that artifact. The artifact is untrusted input to a trusted job.

So Stage 2 takes every value it acts on from its own `workflow_run` event, which GitHub populates and nobody else can write. Concretely, the head commit comes from `workflow_run.head_sha`, not from the artifact, even though Stage 1 could easily have written it there.

One value cannot follow that rule. `workflow_run.pull_requests` is empty when the pull request came from a fork, so the pull request number has to travel in the artifact. It is checked before it is used:

- **Shape.** Digits, anchored to the whole string. A line-oriented match passes a multi-line value, and the extra line lands in `$GITHUB_OUTPUT` as a second `name=value` pair.
- **Ownership.** The API is asked which commit that pull request heads at, and the answer must be the commit this run is about. A well-formed number belonging to somebody else's pull request would otherwise redirect the comment onto it.

(r136)=

The preview path checks the shape and not the ownership, so its sticky comment can be aimed at another pull request in the base repository. That is a comment carrying the repository's identity and a link to content the fork controls, and it gates nothing, which is why the check path earned the ownership guard first. Closing it means carrying `workflow_run.head_sha` into the CLI, which is a change to a frozen file and so a fleet-wide re-copy.

(r154)=

The artifact's files are untrusted in the same way its values are. A paper preview is static MyST output, so Stage 2 removes `_worker.js`, `functions/`, `_routes.json`, `_redirects`, `_headers` and `_middleware.js` from the deploy root before any deploy path. A fork that plants `_worker.js` otherwise runs code on the journal's Pages origin, which is same-site to every other preview in that project. The strip lives in the engine rather than in the workflow: `ci.yml` is fork-controlled, so a Stage 1 strip is a guard a fork deletes in the same commit, while Stage 2 runs from the pinned release.

(r137)=

Malformed input gets a sentence, not a stack. A report that is not JSON, or JSON without the field the verb reads, exits 1 naming the file and what is wrong with it. An absent artifact file means a push build and is not an error; a present and malformed one is a corrupt or hostile artifact, and Stage 2 going red on it is correct.

The report content is a separate question, and the design does not solve it. Stage 2 posts the verdict Stage 1 computed, and Stage 1 is the untrusted half, so a fork can author a passing report. The check verdict is therefore not an authorisation decision, and it must not be the only thing standing between a pull request and the main branch.

(design-paper-ci-artifact-contract)=

## The artifact is an interface between two versions

(r146)=

Stage 1 runs from the pull request's head and Stage 2 from the base, so on the pull request that installs a new shim the new Stage 1 meets the old Stage 2. Whatever passes between them is a versioned interface, and the other end of it is whatever the fleet last installed.

Adding a field is safe. Removing one breaks every repository still running the previous Stage 2, on the very pull request that would have updated them, and an editor looking at a red required check reasonably declines to merge it. A removal needs a release of tolerance first: keep writing the field, unread, until no repository is running a shim older than the release that stopped reading it.

(design-paper-ci-shell-values)=

## What a workflow may put in a script

(r153)=

A value reaches a `run:` script through `env:`, never through `${{ }}` spliced into the script body. A spliced expression is substituted before bash parses the line, so a metacharacter in the value starts a command, while an `env:` read is a variable and stops there. The composite action's dispatch step needs its `args` to word-split, and does that with `set -f` so splitting does not also glob. `test/frozen-guards.test.ts` lints every frozen `run:` for `${{`, so the class cannot come back one workflow at a time.

(r155)=

A value written to `$GITHUB_OUTPUT` is checked before it is written. The engine ref is read out of the paper's own `myst.yml`, which a fork controls, and a block scalar carrying a newline makes it two lines, so the `echo` appends a second `name=value` pair of the author's choosing. The guard is a positive charset test refusing anything outside `A-Za-z0-9._/-`, which no real git ref carries.

(r172)=

The `secrets` context does not exist in a step-level `if:`. A workflow that reads one there fails to parse, which costs the whole file rather than the step, and a file reachable only by `workflow_dispatch` can sit dead without anything going red. A secret is read into `env:` and tested in `run:`.

(design-paper-ci-engine-ref)=

## Which engine code runs

The composite action at `.github/actions/engine` checks the engine out and runs it. The coordinates that decide what that means:

- `pins.yml` names the engine repository. It is data, but it selects _code_, so it is gated (below).
- The paper's own `myst.yml` names the version, under `project.options.oaktree-sapling.version`. It is deliberately not gated, so an author can move their paper to a newer engine in an ordinary pull request.

(r196)=

Because the repository is pinned and only the version floats, the version can only ever resolve to something inside the engine repository. That is weaker than it sounds: a public repository that accepts pull requests will also resolve `refs/pull/N/merge` for any unmerged one. The trust boundary is therefore the repository *and* the class of ref, not the repository alone.

(r41)=

What constrains it: `dist/cli.cjs` is committed onto release tags and onto nothing else, so a runnable engine only exists at a release and a version pointing at a branch tip fails immediately with a message saying so. And on a pull request from a fork, the composite action's `refclass` step refuses a ref that is a bare 40-character commit or a `refs/pull/N/merge`, before the engine is checked out. Those two classes are for dogfooding from inside the repository; release tags, dev tags and branches pass.

The check runs in the workflow rather than in the engine, because it has to decide what engine to fetch before there is an engine to run. `src/ref.ts` holds the same policy as a pure model with a test, and is deliberately not wired to anything. It is the one place in this codebase where duplicating a model is correct, so do not "fix" it by making the action call it.

It fails open: the guard reads `github.event.pull_request.head.repo.fork`, and on any event without a pull request that value is empty and the step exits 0. That is intended, because a push or a `workflow_run` builds a ref the base repository controls. It does mean a green run is not by itself evidence that the guard fired.

(r97)=

Both coordinates fail loudly when absent, not only the ref. `yq` prints the literal `null` for a missing key, so an unguarded read of a mis-rendered `pins.yml` hands `repository: null` to the checkout and the run dies somewhere downstream with a message naming neither the file nor the key.

(design-paper-ci-codeowners)=

## What CODEOWNERS gates, and why those files

(r92)=

`CODEOWNERS` puts an editor in front of any change to a file that can redirect a job to different code:

- `.github/`, which is the workflows and the composite action, including `pins.yml`.
- `CODEOWNERS` itself, so the gate cannot remove itself.
- `paper-environment.yml`, the optional conda environment. It is ordinary-looking configuration, but installing a package runs its hooks, and the environment is set up in the same job as the tokens.

The paper's own content is not gated. Neither is `myst.yml`, which is the point: authors change their paper without an editor in the loop, and the gate exists only around the things that decide what code runs.

Note that CODEOWNERS gates nothing on its own. It requires a branch protection rule or ruleset that demands review from code owners; without one it is documentation.

(design-paper-ci-concurrency)=

## Concurrency keys

(r15)=

Runs are grouped so a new push supersedes an in-flight one for the same pull request. The grouping key has to include the head _repository_ as well as the branch. Two forks both working on a branch called `main` would otherwise share a group and cancel each other, and a cancelled Stage 1 uploads no artifact, so Stage 2 never fires and the pull request is left waiting for a check that will never arrive.

(r94)=

Both stages need that key, and the pull request group also has to be distinct from the push-to-`main` group. A fork opening a pull request from a branch called `main` otherwise lands in the same group as the branch itself and cancels an in-flight Pages deploy.

(design-paper-ci-testing)=

## How the frozen workflows are tested

(r99)=

`test/frozen-guards.test.ts` pulls a step's `run:` script out of the real YAML by step id and executes it as bash, so the assertion lands on the shipped bytes rather than on a copy of them. Asserting which files get stamped says nothing about what any of them does, and these are the files with the largest blast radius in a paper repository.

(r90)=

Each guard carries a case that fails against the unfixed step. A guard written in answer to a finding is only known to close it once the finding's own input has been run through it, and a confident comment on a guard that does not hold is worse than no comment, because it is the reason nobody reads the guard again.

This is bash, not a runner: `${{ }}` is already resolved by the time a real step runs, `$GITHUB_OUTPUT` is a real file there, and the shell setup differs. So it covers script logic, plus the expression-level faults checked statically. A green run here is necessary and not sufficient, and the live conformance run is what exercises the real thing.
