(guide-interactive-figure)=
# Interactive figures

A figure can be an interactive chart on the web and a static image in the PDF. It takes one
notebook cell that emits both, because nothing in the toolchain will derive the second from the
first.

## Why the cell emits two things

MyST reads a notebook's committed outputs. It does not execute the notebook, and it does not know
what a Vega-Lite spec is. For a static export it keeps `image/*`, `text/html` and `text/plain`,
and only an image becomes a figure in the PDF.

Altair on its own emits `text/html`. That is interactive on the web and **nothing** in the PDF:
you get your caption with an empty box above it, and the build does not warn you. Altair cannot
emit both forms at once either, because its renderers are exclusive: `html` gives you the HTML,
`svg` and `png` give you the image, and none of them gives you the pair. So the cell assembles
the mimebundle itself.

## The cell

One code cell in `figure.ipynb`, tagged `remove-input` so the code stays hidden. That is a cell
tag, set in the notebook's cell metadata, not a `#|` line.

```python
#| label: fig-tau
import altair as alt, vl_convert as vlc
from IPython.display import display

rows = [...]  # your data
chart = alt.Chart(alt.Data(values=rows)).mark_line().encode(x="level:Q", y="tau:Q")

display(
    {
        "text/html": chart._repr_mimebundle_(None, None)["text/html"],  # web: interactive
        "image/svg+xml": vlc.vegalite_to_svg(chart.to_json()),          # PDF: static, vector
    },
    raw=True,
)
```

Both packages are yours to install, and the version bound is not decorative:

```
pip install "altair<6" vl-convert-python
```

Altair 6 emits Vega-Lite v6, which does not match the version the theme renders. A plain
`pip install altair` gets you 6.x today, and the failure is a chart that silently does not draw.

**SVG, not PNG.** `vegalite_to_png` defaults to 72 ppi at the chart's declared size, around
350 pixels, which typst then stretches to 90% of the text column. It is visibly blurry on the
page. SVG is vector, so there is no resolution to get wrong. If you need a raster for some other
reason, pass `ppi=300`.

Run the cell so the output is saved, and keep it that way when you commit. The build will not
regenerate it.

:::{tip} Leave the chart's `…` menu alone
It is tempting to hide it with `alt.renderers.set_embed_options(actions=False)`. Don't: that menu
is how a reader saves your figure as PNG or SVG, or takes the Vega-Lite spec behind it.
:::

## The embed

In `index.md`, place it as a figure, with the caption in the directive body:

```markdown
:::{figure} #fig-tau
:label: fig-timescales
Your caption.
:::
```

Interactive on the web, a static chart in the PDF.

## Not this: `:placeholder:`

:::{warning} A placeholder replaces the live output, it does not back it up
MyST's `figure` directive takes a `:placeholder:` image, documented as the static stand-in for an
output that needs a running kernel. It reads like the answer to this exact problem. It is not.

Declaring one suppresses the interactive output everywhere, so the web gets the static image too
and the chart stops being a chart. Declaring it inside the cell instead, with
`#| placeholder: static.svg`, is worse: the page then renders the placeholder *and* the live
chart, one above the other.

Neither form belongs in a paper. Emit both mimetypes from the cell, as above.
:::
