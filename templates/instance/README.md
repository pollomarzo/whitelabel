# The instance-config template (journal identity scaffold)

This is what `oak bootstrap journal` stamps as a journal's INSTANCE-CONFIG — the tenant's
**data-only** identity: editions, brand, and the paper registry (design §4, §5). It carries
**no frozen shim** and no `.github/` — it is not a build unit, so it needs no rulesets,
environments, or CODEOWNERS gate. Unlike the paper template, everything here is
tenant-editable data that `compose()` wires into the MyST `extends:` chain; the engine only
*serves* it version-pinned, it never freezes it.

| File | Role |
|---|---|
| `journal.yml` | journal identity + defaults: `name`, `url`, preview provider, `zenodo:` community/blurb ([R19], [R27]) |
| `editions/<edition>.yml` | per-edition MyST config (venue, funding); selected per paper by `options.oaktree-sapling.edition` |
| `brand/brand.yml` | colors, footer, nav — the venue's visual identity, extended into every paper build |
| `brand/logo.svg` | the brand logo (a real file typst/theme load by path; the watermark rides here too) |
| `registry/papers.yml` | the paper registry `[{slug, location, doi, edition}]` — the gallery's source (§9 shape) |

## The two journal tiers

`oak bootstrap journal` stamps this template in one of two shapes:

- **`--external`** → a standalone, **public** ([R32], dec. 16) instance-config repo that many
  paper repos clone at build time. This template *is* the whole repo — no shim.
- **`--co-located`** → this scaffold is stamped into the **same** repo as the frozen paper
  shim (`templates/paper/`), flattened to the root, with `pins.yml`'s `instance_repo: .`. The
  repo is then both a build unit and its own instance-config (repo=journal).

The two source trees write **disjoint** root paths (enforced by
`test/template.test.ts`), so the co-located union never collides.

## What `oak bootstrap` renders

Only `journal.yml`'s `name` is rendered from answers, and `editions/edition.yml` is renamed to
`editions/<edition>.yml`; every other file is byte-copied verbatim. The tenant edits the rest
by hand — it is their journal's identity, not engine-frozen policy.
