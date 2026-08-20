(guide-branding)=
# Branding

`brand/brand.yml` is the journal's visual identity, and it is applied in two places: the
journal website (whose `myst.yml` extends it directly) and every paper build, which pulls this
repository in and layers the brand over the paper's own configuration. One file, both surfaces.

What a fresh journal gets is deliberately small:

```yaml
version: 1
site:
  options:
    logo_text: CHANGE-ME Journal
    # logo: https://example.org/logo.svg
    # favicon: https://example.org/logo.svg
    # logo_url: https://example.org
project:
  options:
    logo: ./logo.svg
```

Two namespaces, two consumers: **`site:` is the website theme** (HTML — the journal's pages and
each paper's pages), **`project:` is the PDF**. A key in the wrong one does nothing.

(logo-text)=
## logo_text — the words at the top of every page

`site.options.logo_text` is the short text the site theme shows next to the logo in the header
of every page, on the journal website and on each paper's site.

`oak bootstrap journal --name` does **not** write it. A journal that has been bootstrapped and
not edited says `CHANGE-ME Journal` at the top of every page it serves. This is usually the
first thing to fix.

## The images

`site.options.logo`
: The mark in the site header, beside `logo_text`. A fresh `brand.yml` ships this key commented
  out, so out of the box the header shows `logo_text` and no image — `brand/logo.svg` reaches
  the PDF only, through `project.options.logo` below. The two namespaces are read
  independently: setting one does not fill in the other.

`site.options.logo_dark`
: An alternative used in dark mode.

`site.options.favicon`
: The browser-tab icon. A fresh `brand.yml` declares none, and `oak validate` warns about that
  on every paper until you set one.

`site.options.logo_url`
: Where clicking the logo goes. Without it, the logo links to the site's own front page.

`site.options.style`
: A CSS file — see [colours](#colours).

Paths in these fields are relative to the `brand/` directory, so `./logo.svg` is
`brand/logo.svg`; the engine rewrites them to absolute paths at build time so they still
resolve when a paper in another repository builds. These four may also be full URLs — the site
build fetches them.

(colours)=
## Colours

There is no colour key in `brand.yml`, and the site theme has no colour option — its options are
the images above plus layout switches. Colour comes from two different places depending on what
you are colouring.

**The website and the paper pages** take their colours from CSS. `site.options.style` names a
CSS file, resolved the same way as the images:

```yaml
site:
  options:
    style: ./custom.css
```

with `brand/custom.css` next to `logo.svg`. It is loaded on the journal website and on every
paper site, so it is the one place to restyle the whole journal.

**The PDF** has an accent colour of its own: the engine's PDF template takes a `theme` option,
which colours the title, links, cross-references, and the labels on the margin notes and the
abstract. Body headings are not affected — they are set in smallcaps and italics, not in
colour. It is a [typst](https://typst.app) colour expression, and the default is
`blue.darken(30%)`:

```yaml
project:
  options:
    logo: ./logo.svg
    theme: red.darken(30%)
```

(pdf-logo)=
## The image on the PDF's first page

`project.options.logo` is the one the seeded comments call "the typst PDF watermark", which
undersells and mis-describes it. Concretely: the engine's PDF template places this image at the
**top of the first page, in the left margin, at about a quarter of the text width**. It is a
publisher's mark on page one — not a tint behind the text, and it appears on that page only.
This is the one field a fresh `brand.yml` sets, pointing at `brand/logo.svg`. Using the same
file in the site header takes a second entry, `site.options.logo`.

Two constraints, both enforced by `oak validate` as warnings on the paper's pull request:

- **It must be a file committed in this repository.** The PDF renderer cannot fetch a URL. A
  URL here produces `brand watermark "…" is a URL: the PDF renderer cannot fetch it`.
- **It must resolve.** A path pointing at nothing produces `brand typst watermark "…" does not
  resolve to a file`, and the PDF renders without any mark.

Removing the key is allowed: `brand declares no watermark image` is a warning, and papers build
without one.

## Trying it

Brand edits are visible without pushing anything. In a paper checkout:

```bash
oak start --instance <path to your journal clone>
```

previews that paper with your journal's branding applied — the same configuration its CI
builds. In the journal repository, `oak start` previews the website itself.
