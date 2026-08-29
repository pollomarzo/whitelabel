# {{journal_name}}

Welcome. Rewrite this paragraph: say what the journal publishes, who it is for, and how to
submit. This page is yours: the engine stamps it once and never touches it again.

## Papers

:::{paper-cards}
:::

<!--
The `paper-cards` directive above lists EVERY paper in `registry/papers.yml`, in file order.
That is the right shape for a journal with one edition.

When you grow a second edition, split this into per-edition pages: add
`pages/editions/<edition>.md` with its own title and blurb, filter it with

    :::{paper-cards}
    :edition: <edition>
    :::

and add the file to `toc:` in myst.yml. The edition's display title and blurb live in that
page, deliberately: `editions/<edition>.yml` is a MyST config layer, so a non-MyST key there
is silently ignored and misattributed to a paper's generated config.
-->
