(docs-home)=
# Oaktree Sapling

A small journal, run on GitHub. Each paper lives in its own repository and builds itself into
a website and a PDF; a separate journal repository holds the settings every paper build reads:
the journal's name, its branding, the editorial checks a submission has to pass, and the
list of what has been published. Publishing a version deposits it to Zenodo for a DOI.

`oak` is the command-line tool that sets those repositories up and does the building,
checking, previewing and publishing.

::::{grid} 1 1 3 3

:::{card} Run a journal
[After bootstrap](start/journal.md): clone it, make the first edits, push, watch the site go
live.

[journal.yml](guide/journal-yml.md): every setting and what changing it does.

[Editorial checks](guide/checks.md): what a submission is held to.

[Branding](guide/branding.md): logo, colours, the mark on the PDF.

[Pinned versions](guide/pins.md): what nothing upgrades for you.

[Files](reference/files.md): one line each, and who reads them.
:::

:::{card} Write a paper
[Your paper repository](start/paper.md): what is in it, what to fill in, how to submit.

[Editorial checks](guide/checks.md): what your submission is held to.

The reference for writing the manuscript itself is not written yet.
:::

:::{card} Understand how it works
Why the system is shaped the way it is.

Not written yet.
:::

::::
