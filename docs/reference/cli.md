(ref-cli)=
# CLI reference

`oak` runs inside a paper's CI; an editor rarely invokes it by hand. This page describes what each verb produces, seen from the outside.

(deploy-preview)=
## deploy-preview

Deploys a pull request's built paper to a preview URL and posts the link as a comment on the PR. It runs in the trusted second CI stage, so it works for pull requests opened from forks. When the journal configures no Cloudflare preview, or the deploy fails, it comments a link to the build artifact instead; it never fails the run.

(build)=
## build

Composes the paper against its journal and builds it in two passes: the typst PDF and the HTML site. It refuses to run in a journal repo, which has nothing to build. `--exports-only` produces only the PDF, offline, with no theme fetch; `--no-exports` produces only the HTML.

(start)=
## start

Composes the paper, then runs mystmd's live dev server so a local edit shows up in the browser. In a journal repo it serves the journal website instead. It watches `myst.yml` and recomposes the derived config whenever you save a change.

(validate)=
## validate

Runs the engine's own Layer-A invariants together with the journal's chosen Layer-B editorial checks, prints the verdict and every finding, and returns non-zero when a check fails. `--report` writes the JSON envelope that `check-post` later reads. It never posts to GitHub itself.

(check-post)=
## check-post

Reads a report that `validate` has already written and posts the outcome as a first-class Check Run on the pull request, plus a single sticky comment that updates in place. It runs in the trusted base context that holds the write token. Posting is best-effort: if a post fails it degrades to a workflow warning rather than failing the run.

(deposit)=
## deposit

`oak deposit <prepare|publish|status>` drives the Zenodo deposit. `prepare` reserves the concept DOI, reusing an unsubmitted draft if one exists, and opens the pull request that writes `project.doi`, `project.github` and `project.date` into `myst.yml`, best-effort. A production `prepare` may replace a committed sandbox DOI, never the reverse. `publish` uploads the built PDF and bundle; `status` reports the deposit's state. `--sandbox` uses the sandbox token and never reaches for the production one.

(release)=
## release

`oak release --tag vX` builds the paper in a child process, publishes its Zenodo deposit, attaches the bundle to that tag's GitHub Release, and finishes by posting a commit comment on success or opening a failure issue otherwise. `--no-build` skips the build and deposits the `_build` already in the paper directory; the publish workflow uses it so the paper's code runs in a job that holds no token. The DOI's prefix picks the sandbox or production token. The deposit stays a draft: the public DOI exists once an editor clicks Publish on Zenodo.

(notify)=
## notify

`oak notify new-version` posts the standalone new-version reminder to a pull request. The PR number comes from `--pr`, or from a `.pr-number` file in the site directory given with `--site`.

(bootstrap)=
## bootstrap

`oak bootstrap <paper|journal>` onboards a new repo from the engine's templates at a resolved engine version. `journal` needs exactly one of `--external` or `--co-located` to say where the journal website lives. `--owner` names who reviews changes to the gated files and approves a Zenodo publish run; an organisation passes a team, such as `@your-org/editors`.

(upgrade)=
## upgrade

Re-renders a paper's templated files at the target engine version and compares them against a local `--paper` directory or a cloned `--repo`. `--version-only`, `--files-only` and `--both` pick what it reconciles. It opens an upgrade pull request with the differences, and does nothing when the paper is already up to date. The weekly `version-bump.yml` runs `--version-only`, and an editor merges its pull request once the preview build looks right.

(conformance)=
## conformance

`oak conformance <reset|certify>` runs the paper-CI conformance harness. `reset` is an idempotent teardown of a certification run's ephemeral state. `certify` runs the certification, optionally through a fork-PR preview phase first, and `--record` persists the tag-keyed verdict.
