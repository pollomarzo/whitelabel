(ref-files)=
# Files in a journal repository

What `oak bootstrap journal --external` leaves you with, and who reads each file.

| File | Read by | For |
|---|---|---|
| `journal.yml` | `oak`, on every paper build | the journal's settings |
| `brand/brand.yml` | every paper build and the website | logo, favicon, colours |
| `brand/logo.svg` | the PDF, and the website once you point `site.options.logo` at it | the journal's mark |
| `editions/<id>.yml` | the paper build that names this edition | venue, licence, funding |
| `registry/papers.yml` | the website's gallery | the list of published papers |
| `myst.yml` | MyST, in the site workflow | the website |
| `pages/index.md` | MyST | the landing page |
| `package.json` | `npm install`, in the site workflow | the website's build dependencies |
| `.gitignore` | git | keeps `_build/` and `node_modules/` out of the repository |
| `.github/workflows/site.yml` | GitHub Actions | builds and deploys the website |

Two things this repository does not have: any engine machinery (no workflow runs `oak` here;
the website is a plain MyST build) and any branch protection (bootstrap adds none; see
[pushing edits](../start/journal.md#push-your-edits)).

It does have one hard requirement: **it must stay public.** Every paper build clones it without
a token, including builds of pull requests opened from forks. `oak bootstrap journal` creates it
public, and a later re-run of that command against an existing private repository makes it
public again, but nothing watches the setting in between. Making this repository private breaks
every paper's next build until someone notices.

(file-journal-yml)=
## journal.yml

The journal's settings: its name, the rule paper ids must follow, the editorial checks a
submission must pass, how previews are served, and optional Zenodo details. It is the file to
edit first, and it is data only: nothing in it is executed.

Field by field: [journal.yml](../guide/journal-yml.md).

(file-brand-yml)=
## brand/brand.yml

The journal's visual identity, applied both to the website and to every paper's site and PDF.
`site:` options are the website theme's; `project:` options are the PDF's.

What each knob does: [branding](../guide/branding.md).

`brand/logo.svg` is a placeholder mark. Replacing it with your own file of the same name puts
it on every paper's PDF; putting it in the site header as well needs one added line, since a
fresh `brand.yml` sets the PDF image only. See [branding](../guide/branding.md#logo-text).

(file-editions)=
## editions/&lt;edition&gt;.yml

An edition is a batch of papers (a year, an issue, a cohort), and each paper names exactly one
of them. The **filename is the edition's id**: `editions/2026.yml` is the edition `2026`, which
is what a paper's `myst.yml` refers to. A paper naming an edition that has no file here fails to
build.

The file carries the frontmatter every paper in that edition inherits:

```yaml
version: 1
project:
  subject: Article
  venue: CHANGE-ME Journal
  license: CC-BY-4.0
  open_access: true
  # funding: |
  #   Your funder
```

`venue` is the journal name printed on the paper and its PDF, and bootstrap does **not**
substitute `--name` here: a fresh edition file says `CHANGE-ME Journal`.

To add an edition, copy the file and name it after the new id. Two things not to do:

- **Do not add `extends:`.** The engine assembles the list of configuration layers a paper build
  uses (the engine's defaults, this edition, your brand), and checks that no two of them
  declare the same key, because MyST resolves that list in whatever order the files finish
  loading, so a key declared twice has no reliable winner. Keys pulled in by an edition's *own*
  `extends:` are invisible to that check, and a collision between one of them and your brand can
  land differently from one build to the next.
- **Do not add keys MyST does not know**, such as a display title or a blurb for the edition.
  MyST drops them (verified: `⚠️ 'config.project' extra keys ignored: display_title, blurb`),
  and the warning names the *paper's* configuration file rather than this one, because the file
  being read is the paper's, so the message points somewhere the key does not appear. Edition
  display text belongs on a page of the website.

(file-registry)=
## registry/papers.yml

The list of published papers: the source of the gallery on your landing page. It starts as an
empty list (`[]`), and an entry looks like:

```yaml
- id:       oak-2026-tidal-flats
  slug:     tidal-flats
  location: { repo: your-org/tidal-flats-paper, path: . }
  edition:  2026
  doi:      10.5281/zenodo.1234567     # optional, once deposited
  site_url: https://journal.example.org/tidal-flats   # optional
```

`id`
: The paper's own `project.id`, the one [the id rule](../guide/journal-yml.md#id-pattern)
  governs. It has to be unique across the registry; a paper claiming an id already listed
  against another paper fails its checks.

`slug`
: The short name used in the paper's URL path and its thumbnail path.

`location`
: Where the paper lives. `repo` as `owner/name`, and `path` within it (`.` for a repository
  holding one paper).

`edition`
: Which edition it appears in; a filename under `editions/` without the extension.

`doi`
: Shown on the card once the paper has been deposited.

`site_url`
: Only when the paper is not published where it would be guessed. Left out, the gallery derives
  `https://<owner>.github.io/<repo-name>` from `location.repo`. Set it for a custom domain or
  hosting that is not GitHub Pages.

Adding a paper is a manual edit here. That is deliberate: it is the editorial act of
publishing. Since the website lives in this same repository, the commit that adds the entry is
also what redeploys the gallery.

The registry stays a list of pointers: each card's title, keywords and thumbnail are fetched
from the paper's own repository when the site builds, so nothing here needs updating when a
paper's title changes.
