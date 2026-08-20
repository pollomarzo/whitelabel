(guide-checks)=
# Editorial checks

The `checks:` list in `journal.yml` is what a submission is held to. It lives in the journal
repository, which only editors can write, so an author cannot weaken it from inside their own
paper.

A fresh journal starts with five:

```yaml
checks:
  - id: authors-exist
  - id: authors-have-orcid
  - id: authors-have-credit-roles
  - id: abstract-exists
  - id: keywords-defined
```

## What the seeded five mean

All five read the paper's frontmatter — the `authors:`, `abstract` and `keywords:` a manuscript
declares in its `myst.yml` or at the top of `index.md`.

`authors-exist`
: The paper lists at least one author. One result for the paper.

`authors-have-orcid`
: Every author has an `orcid:`. One result **per author**, so a five-author paper with two
  ORCIDs reports three separate failures, each naming the author.

`authors-have-credit-roles`
: Every author has at least one `roles:` entry, and each role is a valid
  [CRediT](https://credit.niso.org/) role. One result per author per role — a misspelled role
  fails on its own ("… has an invalid CRediT role of …") rather than being ignored.

`abstract-exists`
: The paper has an abstract. This is the abstract as MyST understands it — the `abstract:` part
  of the document, not a heading called "Abstract".

`keywords-defined`
: The paper declares at least one keyword.

Each result carries a message and, where the check can locate the problem, a line in the file,
which GitHub shows as an inline annotation on the pull request.

(changing-the-set)=
## Changing the set

Edit `checks:`, commit, push. The next build of every paper picks it up.

**Every selected check blocks by default.** Marking one `optional` makes it advisory — it still
runs, still reports, and never fails the pull request:

```yaml
checks:
  - id: authors-have-orcid
    optional: true
```

**Checks with options** take them as extra keys on the same entry:

```yaml
checks:
  - id: abstract-length
    max: 250
  - id: keywords-length
    max: 6
  - id: word-count
    max: 3500
```

**The ids come from a fixed catalog.** The editorially useful ones are:

| id | what it requires |
|---|---|
| `abstract-exists` | an abstract |
| `abstract-length` | the abstract is at most `max` words (default 400) |
| `authors-exist` | at least one author |
| `authors-corresponding` | at least one author has an email |
| `authors-have-affiliations` | every author has an affiliation |
| `authors-have-orcid` | every author has an ORCID |
| `authors-have-credit-roles` | every author has valid CRediT roles |
| `data-availability-exists` | a data-availability statement |
| `keywords-defined` | at least one keyword |
| `keywords-length` | at most `max` keywords (default 5) |
| `keywords-unique` | no repeated keywords |
| `links-resolve` | every external link resolves |
| `doi-exists` | every citation has a valid DOI |
| `word-count` | the body is within `min`/`max` words |
| `figure-count` | the figure/table count is within `min`/`max` |
| `exports-exist` | the declared export files exist after a build |

The catalog also contains checks mirroring MyST's own build rules (`image-exists`,
`link-resolves`, `valid-page-frontmatter` and others); they are available by id in the same
way.

**A typo is not silently ignored.** An id that is not in the catalog is reported as
`unknown check id "…"`, which fails like any other blocking result — so a misspelled check is
loud rather than an unnoticed hole in the gate.

**`exports-exist` needs a build.** It inspects files a build produces, so a plain `oak validate`
in a fresh checkout reports it as `requires build artifacts — run oak build first` and does not
gate on it.

## Where the checks run

**On every pull request.** The paper repository's **Journal checks** workflow clones the journal
repository, reads this list, runs it, and reports. The result is a GitHub check run plus a
comment on the pull request carrying the same table, updated on every push. Paper repositories
bootstrapped without `--no-require-checks` require that check to pass before a pull request can
merge.

**Locally**, over a paper you have checked out, with a checkout of the journal repository to
read the settings from:

```bash
oak validate --paper ../some-paper --instance .
```

Without `--instance` there are no journal settings to read, so no editorial checks run; `oak
validate --no-instance` says so explicitly in its output and checks only what the engine can
check on its own.

The report mixes in the engine's own findings — a missing `index.md`, a paper id that breaks
[the id rule](journal-yml.md#id-pattern), a brand image that does not resolve — in the same
table as the editorial results.

(validate-runs-paper-code)=
## `oak validate` runs the paper's own code

:::{danger} Validating a submission locally executes the author's JavaScript
A MyST project can declare `plugins:` in its `myst.yml`. When a project is loaded, MyST runs
every plugin listed there: a local `.mjs` file (or a URL, which it downloads first) is imported
into the running process, and a plugin declared as `type: executable` is *executed* as a
program. `oak validate` loads the paper's project, so **it runs whatever the author put there,
as you, with your files, your SSH keys and your tokens.**

In CI this is contained: the checks run in a throwaway container whose token is read-only and
holds no secrets. On your laptop there is no such box.

Before validating a submission you have not read:

- open the paper's `myst.yml` and look at `plugins:`. No entry, no risk from this.
- if there is one, read it, or let CI do the run — the pull request already runs the same
  checks and posts the same report.
:::
