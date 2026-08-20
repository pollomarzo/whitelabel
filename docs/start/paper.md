(start-paper)=
# You just got a paper repository

Your paper has a repository of its own. It holds your manuscript and the GitHub Actions
workflows that build it into a website and a PDF, check it against the journal's editorial
rules, and — when an editor says so — deposit it to Zenodo for a DOI.

The repository was created by an editor running `oak bootstrap paper`. You do not run that
command, and you do not need `oak` installed to write your paper: everything below happens
either in a text editor or on GitHub. Installing `oak` buys you one thing, a local preview,
and that is optional.

:::{note} You may already have a pull request waiting
If the editor imported an existing repository of yours (`oak bootstrap paper --from`), your
files were copied onto a branch called `review` and a pull request from it to `main` is already
open. That pull request is where the work below happens — there is no starter manuscript to
replace, and you should not push to `main`.
:::

## 1. Clone it

```bash
git clone https://github.com/<owner>/<paper-repo>.git
cd <paper-repo>
```

A fresh paper repository holds:

```text
myst.yml       your paper's metadata — id, title, authors, keywords
index.md       the manuscript
bib.bib        your bibliography
CODEOWNERS     the editors, who must approve changes to .github/
.github/       the workflows that build, check, preview and publish the paper
```

`myst.yml`, `index.md` and `bib.bib` are yours. Everything under `.github/` is the journal's:
it is identical in every paper repository, it is approval-gated to the editors, and it is
replaced wholesale when the journal moves papers to a newer engine version. Editing it is not
how you change what your paper does.

## 2. Fill in myst.yml

The seeded `myst.yml` is a form, and until you fill it in the build fails on purpose:

`id`
: Reads `CHANGE-ME-template-placeholder`. Replace it with a fresh, unique id in the shape the
  journal requires — something like `oak-2026-tidal-flats`. This is the first thing to change:
  while the placeholder is there, every build of your paper is red. See
  [id_pattern](../guide/journal-yml.md#id-pattern) for the rule your id has to match.

`title`
: Your paper's title.

`authors:` and `keywords:`
: Both are present but commented out. Uncomment and fill them. They are written out in full,
  with an ORCID and CRediT roles on the example author, because those are exactly the fields
  the [editorial checks](../guide/checks.md) look for — the template shows you the shape rather
  than making you guess it. They stay inert while commented, so nothing fake is ever published
  by accident.

`options.oaktree-sapling`
: The engine version and edition. The editor's bootstrap filled these in and a scheduled
  workflow keeps the version current. Leave them alone.

Then write the paper in `index.md`. Its `abstract` part is not decoration: it is lifted into
the website, onto the PDF's cover page, and into the Zenodo deposit, so keep it self-contained.

(paper-journal-link)=
## 3. Where the journal's settings come from

Your paper's website and PDF carry the journal's name, colours and logo, and your submission is
checked against the journal's rules — but none of that is in your repository. It is fetched at
build time.

The link is one file, `.github/actions/engine/pins.yml`, which names the journal's repository:

```yaml
engine_repo: <owner>/<engine-repo>
instance_repo: <owner>/<journal-repo>
```

Every workflow run clones that journal repository and reads its `journal.yml`, `brand/` and
`editions/` before building you. So the journal's branding and checks can change without
anything changing in your repository, and the next build of your paper picks the change up.
There is no copy of the journal's settings to keep in sync, and nothing to update when the
journal is rebranded.

The practical consequence is for local work: on your machine there is no journal to clone
from, so `oak` has to be told where one is. See [previewing locally](#paper-preview-locally).

## 4. Open a pull request

`main` is protected on a paper repository — you cannot push to it. Work on a branch and open a
pull request:

```bash
git checkout -b my-edits
git add -A
git commit -m "Add the abstract and author list"
git push -u origin my-edits
```

Then open the pull request on GitHub. Two things then happen on it, and both post a comment:

**Journal checks** run over your manuscript and report which passed. Failures come back as
inline annotations on the changed lines where the check can locate the problem, so a missing
ORCID points at the author it is missing from. This check has to pass before the pull request
can merge.

**A preview** of the built paper — the real website, with the journal's branding applied —
is deployed and linked in a comment. If the journal has not configured a preview host, the
comment links the build artifact instead, which you download and open locally. Either way it
is the same build that CI would publish.

Both re-run on every push to the branch, and both update their existing comment rather than
adding a new one.

When the checks are green and an editor is happy, the pull request merges. Merging to `main`
publishes your paper's own website at `https://<owner>.github.io/<paper-repo>/`. As with any
new GitHub Pages site, the first deploy takes a few minutes and a 404 before then is expected.

(paper-preview-locally)=
## Previewing locally

Optional, and only worth it if you are iterating on the manuscript enough that waiting for CI
is annoying. Install the engine, then:

```bash
oak start --instance ../<journal-repo>
```

`--instance` is a path to a local clone of the journal repository — the one named in
`pins.yml`. `oak` does not fetch it for you, so clone it yourself alongside your paper. Without
that path you can still preview, with `oak start --no-instance`, but you get an unbranded
build: no logo, no colours, no edition metadata, and none of the journal's checks. It is useful
for reading your own prose and misleading for anything else.

`oak validate --instance ../<journal-repo>` runs the same editorial checks CI runs, and prints
what fails, without opening a pull request.

## Publishing is the editor's move

You do not mint the DOI. When a version is ready, an editor reserves a Zenodo DOI (which
arrives in your repository as a one-line pull request against `myst.yml`) and tags the release;
tagging is restricted to editors, and the deposit itself waits behind a human approval. Your
part ends when the pull request merges.

## What is not written yet

The full reference for a paper's `myst.yml`, figures, cross-references and supplementary files
is not here yet. The manuscript is a [MyST](https://mystmd.org/) document, so MyST's own
documentation covers the writing; this site covers the parts the journal adds.
