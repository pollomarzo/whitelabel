# The instance-config template (journal identity scaffold)

This is what `oak bootstrap journal` stamps as a journal's INSTANCE-CONFIG: the tenant's
**data-only** identity: editions, brand, and the paper registry (design §4, §5). It carries
**no frozen shim** and no `.github/`: it is not a build unit, so it needs no rulesets,
environments, or CODEOWNERS gate. Unlike the paper template, everything here is
tenant-editable data that `compose()` wires into the MyST `extends:` chain; the engine only
*serves* it version-pinned, it never freezes it.

| File | Role |
|---|---|
| `journal.yml` | journal identity + defaults: `name`, `url`, preview provider, `zenodo:` community/blurb ([R19], [R27]), optional `typst_template:` ([R76]) |
| `editions/<edition>.yml` | per-edition MyST config (venue, funding); selected per paper by `options.oaktree-sapling.edition` |
| `brand/brand.yml` | colors, footer, nav: the venue's visual identity, extended into every paper build |
| `brand/logo.svg` | the brand logo (a real file typst/theme load by path; the watermark rides here too) |
| `registry/papers.yml` | the paper registry `[{id, slug, location, doi?, site_url?, edition}]`, the gallery's source (§9 shape) |
| `myst.yml`, `pages/`, `package.json`, `.github/workflows/site.yml` | the **journal site** (below), stamped by `--external` unless you pass `--no-site` |

## The journal site

`oak bootstrap journal --external` also stamps a **website** into this repo: a plain MyST
project that builds with `myst build --html` and deploys to GitHub Pages at
`https://<owner>.github.io/<this-repo>/`. `oak` never runs there: it is not an engine build.

Folding the site into instance-config buys the thing that matters: **the editorial PR that
adds a registry entry is also the deploy trigger.** Publish → visible, one act, one repo.

**You own every byte of it.** It is not frozen and `oak upgrade` does not touch it. Rewrite
`pages/index.md`, add pages, restyle it. Only three values are platform pins, and you bump
all three by hand:

| Pin | Where | Bump when |
|---|---|---|
| gallery plugin URL | `myst.yml` `project.plugins` | you want a newer engine's gallery |
| `site.template` (theme zip) | `myst.yml` `site.template` | same: it is the theme that engine version pins |
| `mystmd` | `package.json` | you want a newer MyST |

The plugin URL is remote because it is *code*; the brand is a **local** `./brand/brand.yml`
extends, so the site needs no network to know what your journal looks like.

`package.json` also declares `js-yaml`, which the gallery plugin imports, and the
workflow's `npm install` is **not optional**: MyST downloads a remote plugin into
`_build/cache/` and imports it from there, so the plugin's dependencies must resolve from
this repo's own `node_modules`. If you add an import to a plugin, add it here too.

**The gallery.** `pages/index.md` carries `:::{paper-cards}` with no options, which lists
every registered paper in registry file order. When you grow a second edition, add
`pages/editions/<edition>.md` with its own title and blurb, filter it with `:edition:`, and
add it to `toc:`. The edition's display text lives in that page on purpose: a non-MyST key
in `editions/<edition>.yml` is silently ignored and misattributed to a paper's generated
config.

**A failing site build is not an outage.** Pages keeps serving the last successful deploy, so
a registry entry pointing at a repo that will not fetch leaves the live journal exactly as it
was until you fix the entry. That is why the build fails loudly (`--strict`) instead of
skipping the broken card: a visibly broken card in front of readers is worse than a red run
in front of an editor.

**Branch protection is yours to add.** Bootstrap deliberately does not put rulesets on this
repo: registry upkeep is a manual editorial PR into a repo only editors can write, and how
tightly to gate it is your journal's policy call, not the engine's.

Pass `--no-site` at bootstrap for a config repo with no website.

## Shipping your own typst template (optional)

The engine's template is already brandable by parameter (watermark, colors), so most
journals need nothing here. If yours does, set `typst_template:` in `journal.yml`, a myst
template `name`, a `path`, or a `URL`. Precedence is **author > journal > engine**: a paper
may override it with its own `exports[].template`, which is allowed and applied, with `oak
validate` flagging it on the PR so the divergence from journal identity gets reviewed.

Two things worth knowing: only `./`- and `../`-prefixed values are paths relative to this
directory (a bare `typst-template` is a template *name*, even if a directory of that name
sits next to `journal.yml`); and a non-engine template's resolved bytes are archived into
every Zenodo deposit (`template.zip`), so DOI'd PDFs stay reproducible whatever the source.

## The two journal tiers

`oak bootstrap journal` stamps this template in one of two shapes:

- **`--external`** → a standalone, **public** ([R32], dec. 16) instance-config repo that many
  paper repos clone at build time. This template plus the journal site (`templates/site/`)
  *is* the whole repo, no shim.
- **`--co-located`** → this scaffold is stamped into the **same** repo as the frozen paper
  shim (`templates/paper/`), flattened to the root, with `pins.yml`'s `instance_repo: .`. The
  repo is then both a build unit and its own instance-config (repo=journal).

Each unioned pair (`paper ⊎ instance`, `site ⊎ instance`) writes **disjoint** root paths,
enforced by `test/template.test.ts`, so neither union ever collides. `--co-located` gets no
site: an index page over many papers in one repo is separate, unbuilt work.

## What `oak bootstrap` renders

From this template, only `journal.yml`'s `name`, and `editions/edition.yml` renamed to
`editions/<edition>.yml`. From the site template, four values: the gallery plugin URL, the
theme zip, the journal name, and the MyST version in the workflow. Every other file is
byte-copied verbatim. The tenant edits the rest by hand: it is their journal's identity, not
engine-frozen policy.
