(guide-pins)=
# The three pinned versions

This page is about the journal website, which `oak bootstrap journal --external` stamps into the
journal repository. A `--co-located` repository has no website and none of these three pins.

Everything in that repository is yours: the engine writes the files once, at bootstrap, and
never touches them again. `oak upgrade` moves *paper* repositories to a newer engine version and
does not visit an `--external` journal repository.

The flip side is that three version numbers here are frozen at whatever was current the day you
bootstrapped, and nothing bumps them for you.

| Pin | Where | What it is |
|---|---|---|
| gallery plugin | `myst.yml` → `project.plugins` | the code behind the `paper-cards` list on your landing page, pinned to an engine release |
| site theme | `myst.yml` → `site.template` | the theme the website is built with, pinned to a theme release |
| `mystmd` | `package.json` → `dependencies` | the MyST version that builds the site |

Bumping any of them is an ordinary edit: change the value, commit, push, watch the **Journal
site** run in the Actions tab. If the build fails, the previously deployed site keeps serving.

## The gallery plugin

```yaml
project:
  plugins:
    - https://raw.githubusercontent.com/<engine-repo>/<engine-tag>/plugins/gallery.mjs
```

This provides the `paper-cards` directive that `pages/index.md` uses to list your published
papers from `registry/papers.yml`. It is fetched over the network rather than copied into your
repository because it is code: a vendored copy would be a copy nobody updates.

The tag in that URL is the engine release your repository was bootstrapped with. Bump it to the
engine release you want the gallery's behaviour from: a newer card layout, a new directive
option.

:::{tip} A wrong tag fails loudly, by design
MyST treats a plugin it cannot fetch as a warning: it logs `Unknown plugin`, then
`unknown directive: paper-cards`, and still exits successfully, which would quietly deploy a
journal front page with no papers on it, over a perfectly good one.

The seeded workflow therefore does not trust the exit code. It greps the build log for the
plugin announcing itself, and fails the run with
`the gallery plugin did not load: check the pinned plugin URL in myst.yml (a bad tag 404s
silently)`. If you see that, the tag in the URL does not exist.
:::

## The site theme

```yaml
site:
  template: https://github.com/<theme-repo>/releases/download/<theme-tag>/book-theme.zip
```

The theme is what the website looks like structurally: header, sidebar, navigation, the
options `brand/brand.yml` sets.

Worth knowing before you bump it: **paper builds use the theme version their engine pins**, not
this one. This line controls your journal's landing page only. Moving it far ahead of the engine
your papers are pinned to means the front page and the papers it links to are rendered by
different theme versions.

## mystmd

```json
{
  "dependencies": {
    "js-yaml": "^4.1.0",
    "mystmd": "^1.10.1"
  }
}
```

`package.json` is the site's whole dependency list, and the workflow just runs `npm install`
against it. The `mystmd` range was copied from the engine's own MyST version at bootstrap, so
the website renders with roughly the MyST that builds your papers.

`js-yaml` is there because the gallery plugin imports it, and the install is **not optional**:
MyST downloads a remote plugin into its build cache and imports it from there, so the plugin's
own imports have to resolve from this repository's `node_modules`. If you ever add an import to
a plugin, add the dependency here too.

## Not these: the pin inside a paper repository

A paper repository carries a version pin of its own: the engine release its workflows run,
in `.github/actions/engine/pins.yml`, alongside the journal repository it belongs to. That one
is a different mechanism with a different upgrade path (`oak upgrade` opens a pull request that
moves it), and it is documented with the paper repository. That page is not written yet.
