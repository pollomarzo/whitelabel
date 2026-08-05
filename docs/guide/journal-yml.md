(guide-journal-yml)=
# journal.yml

`journal.yml` sits at the root of the journal repository and holds the journal's settings. It
is data — no logic, no code — and every paper build clones this repository to read it, so a
change here reaches every paper's *next* build, including papers that merged months ago.

Unknown keys are ignored rather than rejected, so a newer setting cannot break a paper pinned
to an older engine.

## The fields

`name`
: Your journal's name. `oak bootstrap journal --name` writes it. Nothing displays it today — it
  does not rename your website (that is `project.title` in the site's `myst.yml`) and it is not
  the name printed on a paper's PDF (that is `venue` in `editions/<id>.yml`). Keep the three
  consistent by hand. The key is **required** even so: it is the one field this file cannot be
  parsed without, so deleting it breaks every paper build that reads the file.

`url`
: Accepted and stored; nothing reads it yet.

`tier`
: `paper`, and leave it there. The other values name granularities that are not built.

`id_sentinel`
: The one id that is always rejected — the placeholder that ships in the paper template. It
  stops a submission going out with the template's id still in it. See below.

`id_pattern`
: The shape every other paper id must have. See below.

`typst_template`
: Your own PDF template, if the engine's is not enough. See below.

`preview:`
: How a pull-request preview of a paper is served.
  `provider: artifact` (the default) attaches the built site to the CI run as a downloadable
  artifact and comments a link on the pull request. `provider: cloudflare` deploys a live
  preview URL instead, and needs both `cf_project_name` here and the `CLOUDFLARE_*` secrets on
  each paper repository — if any of the three is missing the run quietly falls back to the
  artifact link rather than failing. `branch_pattern` names the Cloudflare branch alias;
  `{repo}` and `{pr}` are substituted, and the result is lowercased and truncated to 28
  characters.

`zenodo:`
: `community` submits every deposit to that Zenodo community; `description_blurb` is a
  paragraph appended to every deposit's description. A fresh journal has neither, and deposits
  work without them.

`checks:`
: The editorial checks a paper must pass. See [editorial checks](checks.md).

(id-pattern)=
## id_pattern — the paper id rule

Every paper declares an id in its own `myst.yml` (`project.id`). It is the journal's permanent
handle for that paper: the deposit key, and what `registry/papers.yml` lists. `id_pattern` is
the rule those ids must satisfy.

The seeded value is:

```yaml
id_sentinel: CHANGE-ME-template-placeholder
id_pattern: "^[a-z0-9]+-\\d{4}-[a-z0-9-]+$"
```

which admits `oak-2026-tidal-flats` and rejects `Tidal Flats`, `oak-26-tidal-flats` and
`oak-2026-Tidal-Flats`.

### What it gates

`oak validate` checks a paper's id three ways, and the first two come from this file:

1. **The sentinel.** An id equal to `id_sentinel` fails: `paper id "…" is the template
   placeholder; every paper needs a fresh unique id`.
2. **The pattern.** An id that does not match fails: `paper id "…" does not match the journal
   id pattern /…/`.
3. **Uniqueness.** An id already in `registry/papers.yml` under a different paper fails.

All three block in a pull request: they land in the **Journal checks** run, which the author
sees as a failed check and a comment, and if the paper repository requires that check, the pull
request cannot merge until the id is fixed.

The uniqueness check softens to a warning in two cases, both local: when there is no registry
to read (you passed `--no-instance`, or the journal checkout has none), and when the run cannot
tell which registry entry is the paper's *own* — which happens in a checkout with no GitHub
remote, since that is how a paper is matched to its entry. CI always has the repository name,
so the gate stays hard there. The first two checks never soften.

### Editing it safely

- **The regex is used exactly as you write it.** Nothing anchors it for you, so keep the `^`
  and `$`; without them, `oak-2026-x` and `nonsense-oak-2026-x-nonsense` both pass.
- **Mind the YAML quoting.** In double quotes a backslash is an escape, so `\d` has to be
  written `\\d`. In single quotes it does not: `'^[a-z0-9]+-\d{4}-[a-z0-9-]+$'` is the same
  pattern, and easier to read.
- **Test it before you push.** It runs as a JavaScript regular expression:
  `node -e 'console.log(/^[a-z0-9]+-\d{4}-[a-z0-9-]+$/.test("oak-2026-tidal-flats"))'`.
- **Deleting the key turns the pattern check off.** Both `id_pattern` and `id_sentinel` are
  optional; drop either and that check stops running. Uniqueness still applies. If your journal
  has no id convention worth enforcing, dropping `id_pattern` is a legitimate choice — but keep
  `id_sentinel`, because a submission still carrying the template's id is a real mistake and
  the only thing that catches it.

:::{warning} Tightening the pattern is retroactive
Papers are re-checked on every pull request against them, using the pattern as it is *now*.
Making the rule stricter can fail a paper that merged under the old rule, and the id in a
published paper is not safe to change — it is the deposit key. Loosen freely; tighten before
you publish, not after.
:::

(typst-template)=
## typst_template — your own PDF template

Leave it commented out and papers render with the engine's PDF template, which is already
brandable: [the image on the first page](branding.md#pdf-logo) and
[the accent colour](branding.md#colours) are options, not template edits. Most journals need
nothing here.

If you do ship your own, the value takes one of MyST's three template forms, and the difference
between two of them catches people out:

- `./typst-template` or `../shared/typst` — a **path**, relative to the directory `journal.yml`
  is in.
- `/srv/typst-template` — an absolute path.
- `https://…/template.zip` — a URL. Prefer one that names a tag or a release; a URL that tracks
  a branch can change under you without the reference changing, and `oak validate` warns about
  it.
- `lapreprint-typst` — a **name**, looked up in MyST's template registry.

Only values starting with `./` or `../` are treated as paths. A bare `typst-template` is a
template *name* even if a directory of exactly that name sits next to `journal.yml` — one
string always means one thing, whatever happens to be on disk. `oak validate` warns in the one
case where you would guess wrong: a bare name that shadows a real directory here.

A paper may override your template with its own, in its `exports:` entry. That is allowed and
applied — the engine does not forbid it — but `oak validate` reports it on the pull request, so
a paper stepping away from the journal's identity is a reviewed decision rather than a silent
one.
