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

(design-paper-ci-stage2-inputs)=
## What Stage 2 is allowed to believe

This is the rule that is easiest to get wrong, and it has been got wrong here before.

Stage 2 runs in the base context, but the artifact it downloads was written by Stage 1, and **on a pull request GitHub runs the pull request's own copy of the Stage 1 workflow file**. A fork can therefore edit what goes into that artifact. The artifact is untrusted input to a trusted job.

So Stage 2 takes every value it acts on from its own `workflow_run` event, which GitHub populates and nobody else can write. Concretely, the head commit comes from `workflow_run.head_sha`, not from the artifact, even though Stage 1 could easily have written it there.

One value cannot follow that rule. `workflow_run.pull_requests` is empty when the pull request came from a fork, so the pull request number has to travel in the artifact. It gets two checks before it is used:

- **Shape.** It must be digits, matched against the whole string. A previous version of this check used `grep -q`, which matches any *line*, so a two-line file passed and the second line was injected into the step's outputs.
- **Ownership.** The API is asked which commit that pull request heads at, and the answer must be the commit this run is about. A well-formed number belonging to somebody else's pull request would otherwise redirect the comment onto it.

The report content itself is a separate question. Stage 2 posts the verdict Stage 1 computed, and Stage 1 is the untrusted half, so a fork can currently author a passing report. That is a known gap rather than a solved problem, and it is why the check verdict should not be the only thing standing between a pull request and the main branch.

(design-paper-ci-engine-ref)=
## Which engine code runs

The composite action at `.github/actions/engine` checks the engine out and runs it. Two coordinates decide what that means:

- `pins.yml` names the engine repository. It is data, but it selects *code*, so it is gated (below).
- The paper's own `myst.yml` names the version, under `project.options.oaktree-sapling.version`. It is deliberately not gated, so an author can move their paper to a newer engine in an ordinary pull request.

Because the repository is pinned and only the version floats, the version can only ever resolve to something inside the engine repository. That is weaker than it sounds: a public repository that accepts pull requests will also resolve `refs/pull/N/merge` for any unmerged one.

What actually constrains it today is that a runnable engine only exists at a release. `dist/cli.cjs` is committed onto release tags and onto nothing else, so a version pointing at a branch tip fails immediately with a message saying so. This is the only enforcement there is. A narrower rule was designed, restricting raw commits and pull-request refs to same-repository pull requests, and it is not wired up.

(design-paper-ci-codeowners)=
## What CODEOWNERS gates, and why those files

`CODEOWNERS` puts an editor in front of any change to a file that can redirect a job to different code:

- `.github/`, which is the workflows and the composite action, including `pins.yml`.
- `CODEOWNERS` itself, so the gate cannot remove itself.
- `paper-environment.yml`, the optional conda environment. It is ordinary-looking configuration, but installing a package runs its hooks, and the environment is set up in the same job as the tokens.

The paper's own content is not gated. Neither is `myst.yml`, which is the point: authors change their paper without an editor in the loop, and the gate exists only around the things that decide what code runs.

Note that CODEOWNERS gates nothing on its own. It requires a branch protection rule or ruleset that demands review from code owners; without one it is documentation.

(design-paper-ci-concurrency)=
## Concurrency keys

Runs are grouped so a new push supersedes an in-flight one for the same pull request. The grouping key has to include the head *repository* as well as the branch. Two forks both working on a branch called `main` would otherwise share a group and cancel each other, and a cancelled Stage 1 uploads no artifact, so Stage 2 never fires and the pull request is left waiting for a check that will never arrive.
