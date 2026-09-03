(ref-cli)=
# CLI reference

`oak` runs inside a paper's CI; an editor rarely invokes it by hand. This page describes what each
verb produces, seen from the outside.

(deploy-preview)=
## deploy-preview

Deploys a pull request's built paper to a preview URL and posts the link as a comment on the PR.
It runs in the trusted second CI stage, so it works for pull requests opened from forks. When the
journal configures no Cloudflare preview, or the deploy fails, it comments a link to the build
artifact instead; it never fails the run.
