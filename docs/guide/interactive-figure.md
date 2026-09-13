(guide-interactive-figure)=
# Interactive figures

A figure can be an interactive chart on the web and a static image in the PDF. Build it with
[Altair](https://altair-viz.github.io), commit the notebook with its output (the build does not
run notebooks), and embed the cell in `index.md`.

## The cell

One code cell in `figure.ipynb`, tagged `remove-input` so the code stays hidden. Its output holds
both an interactive form for the web and a static image for the PDF:

```python
#| label: fig-tau
import altair as alt, vl_convert as vlc
from IPython.display import display

alt.renderers.set_embed_options(actions=False)          # drop the chart's export menu
chart = alt.Chart(alt.Data(values=rows)).mark_line().encode(x="level:Q", y="tau:Q")

display(
    {
        "text/html": chart._repr_mimebundle_(None, None)["text/html"],  # web: interactive
        "image/png": vlc.vegalite_to_png(chart.to_json()),              # PDF: static
    },
    raw=True,
)
```

Run the cell so the output is saved, and keep it that way when you commit.

## The embed

In `index.md`, place it as a figure, with the caption in the directive body:

```markdown
:::{figure} #fig-tau
:label: fig-timescales
Your caption.
:::
```

Interactive on the web, a static chart in the PDF.
