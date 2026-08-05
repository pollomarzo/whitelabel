(start-journal)=
# You just bootstrapped a journal

`oak bootstrap journal` created a repository on GitHub, pushed one commit to it, and (unless
you passed `--no-site`) turned on GitHub Pages so the journal website can deploy from a
workflow. It left nothing on your machine — the seeding happens in a temporary clone that is
thrown away — so the two things to do now are get a copy and edit `journal.yml`.

:::{note} This page describes `--external`
`oak bootstrap journal` takes exactly one of `--external` or `--co-located`. `--external` is the
usual choice and the one described here: the journal gets a repository of its own, and papers
live in repositories that point back at it. A `--co-located` repository is both the journal and
a single paper — it holds a manuscript and the workflows that build it, has no website, and is
upgraded by `oak upgrade` like any paper repository. Only the journal settings below apply to
it.
:::

## 1. Clone it

```bash
git clone https://github.com/<owner>/<journal-repo>.git
cd <journal-repo>
```

You should see:

```text
journal.yml          the journal's settings
brand/brand.yml      logo, favicon, the text beside the logo
brand/logo.svg       a placeholder mark, yours to replace
editions/<id>.yml    one edition, named by --edition
registry/papers.yml  the list of published papers — empty for now
myst.yml             the journal website
pages/index.md       the website's landing page
package.json         the website's build dependencies
.gitignore           keeps the website's build output and node_modules out of git
.github/workflows/site.yml   builds and deploys the website on every push to main
```

Every one of those files is yours to rewrite. `oak upgrade` moves *paper* repositories to a
newer engine version; an `--external` journal repository is not one, so nothing here is
overwritten by a later upgrade. See [what each file is](../reference/files.md).

## 2. Edit journal.yml first

[`journal.yml`](../guide/journal-yml.md) is the file every paper build reads. Three fields
matter on day one:

`name`
: Your journal's name. `--name` set it if you passed one; otherwise it still reads
  `CHANGE-ME Journal`.

`id_pattern`
: The shape every paper's id must have. The seeded value is
  `^[a-z0-9]+-\d{4}-[a-z0-9-]+$` — for example `oak-2026-tidal-flats`. A paper whose id does
  not match fails its checks and cannot merge, so decide this before the first submission.
  See [id_pattern](../guide/journal-yml.md#id-pattern), including how to turn it off.

`checks`
: The five editorial checks a submission is held to. See
  [editorial checks](../guide/checks.md).

:::{note} Your journal's name is written in four places, and `--name` only reaches two of them
`--name` sets `journal.yml`'s `name` and the website's title (`myst.yml` `project.title`, plus
the heading in `pages/index.md`). Two more still say `CHANGE-ME Journal` after bootstrap:
`brand/brand.yml`'s `logo_text`, which is the text readers see at the top of every page, and
`editions/<id>.yml`'s `venue`, which is the journal name printed on each paper's PDF. Fix both
by hand.
:::

Then rewrite `pages/index.md` — the landing page says "Rewrite this paragraph" for a reason —
and replace `brand/logo.svg`. See [branding](../guide/branding.md).

(push-your-edits)=
## 3. Commit and push

Bootstrap deliberately adds no branch protection to this repository, so a push to `main` is all
it takes:

```bash
git add -A
git commit -m "Set the journal's name and id pattern"
git push
```

That push does two things. It redeploys the website, because
`.github/workflows/site.yml` runs on every push to `main`. And it changes what papers are
checked against: a paper's build clones this repository at build time and reads the settings
then, so the next build of every paper — not just new ones — uses the file you just pushed.

If you would rather review changes to the journal before they take effect, add a branch
protection rule yourself; the engine does not impose one.

(first-deploy)=
## 4. The website takes a few minutes

The website is served at `https://<owner>.github.io/<journal-repo>/`. It appears only after the
**Journal site** workflow run finishes, and GitHub Pages then takes a minute or two to start
serving a brand-new site. A 404 immediately after your first push is expected — watch the run
in the repository's **Actions** tab, then reload.

If a later site build fails, the last successful deploy keeps serving. A bad entry in
`registry/papers.yml` cannot take the journal offline; it shows up as a red run, which is the
intended trade.

## Previewing before you push

The website is a plain MyST project, so you can run it locally:

```bash
npm install     # once — the paper gallery needs the dependencies listed in package.json
oak start
```

`oak start` in the journal repository serves the website with no engine machinery involved. If
the paper gallery is missing from the preview, you skipped `npm install`.

`oak build` and `oak validate` are for papers and refuse to run here: there is no manuscript in
this repository, and the website builds itself in CI.

## What comes next

Adding papers means creating a paper repository per submission (`oak bootstrap paper`) and
adding an entry to `registry/papers.yml` when one is published. Both are documented on their
own pages, which are not written yet.
