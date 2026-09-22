(design-index)=

# How it works

This section answers why the system is shaped the way it is. It is for somebody changing the engine, forking it, or trying to understand a decision they disagree with. If you only want to run a journal or publish a paper, start from [Run a journal](../start/journal.md) or [Write a paper](../start/paper.md); the guides go into each setting one at a time[^guides], and nothing here is required reading.

Start with this page. It covers the three things the rest of the section assumes you already know.

## There is no central website

A journal is not one repository. It is one **journal repository** holding the settings every paper reads, and one repository **per paper**.

The journal repository holds the journal-level configuration[^journal-config] and no manuscripts. Each paper repository holds one manuscript and knows almost nothing about the journal: it builds itself, checking out the engine, building the paper into a website and a PDF, and depositing it to Zenodo when a version is published.

So adding a paper means adding a repository. Nothing is assembled in one place, no service runs between them, and a paper that has been published keeps building after the journal moves on. The cost is that a change to how papers build has to reach every paper repository, which is what `oak upgrade` is for.

One repository per paper is the only topology the engine builds today, and it is what this page describes. A co-located tier, where a single repository holds the journal and many papers at once, is designed but not built ([R188]). It is the part of this model most likely to be revisited.

## The engine does not render anything

[MyST](https://mystmd.org) does the rendering: Markdown to a website, and Markdown to a PDF through typst. The engine does not reimplement that and does not fork it.

What the engine adds is everything around a build that a single paper cannot know by itself.[^around] MyST is called as a library rather than as a subprocess: `src/myst.ts` constructs a MyST `Session` and calls `loadConfig` and `build` on it directly ([R51]). It is the only module in the engine that imports myst-cli, so every other module is testable without the toolchain installed.

## A paper's configuration is assembled at build time

A paper's `myst.yml` is an ordinary MyST project file. It carries no `extends:`, and it says nothing about the journal. Its one engine-specific line names the engine version, under `project.options.oaktree-sapling.version`.

Everything else is worked out when the paper builds. `oak build` assembles this chain:

| | comes from | carries |
|---|---|---|
| `paper-base.yml` | the engine | what every paper in every journal gets |
| `editions/<edition>.yml` | the journal repository | what this batch of papers gets |
| `brand/brand.yml` | the journal repository | logo, colours, the mark on the PDF |
| `myst.yml` | the paper | the manuscript's own frontmatter |

By the time MyST sees them they are all local paths on disk. Nothing is fetched during a build, so a build is reproducible and a network failure cannot change its output.

The assembled result is written to **`myst.oak.yml`**, next to the paper's `myst.yml`, and MyST is pointed at that file instead. It opens with a banner saying it is generated, the paper template gitignores it, and it is rewritten on every build.[^cleanup]

Why a generated file, rather than just adding an `extends:` line to the paper's config? Because of how MyST resolves `extends:`. The paper's own config wins over everything it extends, and entries like PDF export definitions are merged whole rather than field by field, so an extended layer cannot adjust one field of something the paper declares. An engine that needs to override anything therefore cannot express itself as a layer. It composes the answer itself and hands MyST the finished config.

## The pages here

Each page takes one part of the system and explains why it is built that way. What each part _does_ belongs in [Reference](../reference/files.md); this section is only for the reasoning, and it exists because that reasoning is otherwise invisible in the code.

[How a paper repository's CI is built](paper-ci.md) is the first of them: why every job is split in two, what a job holding a token is allowed to believe, and what `CODEOWNERS` gates.

[The design brief](brief.md) and [the decision record](record.md) are the working notes the section is being written from. They are long, they are dated, and they are gradually being folded into pages like the one above. They will be deleted when they are empty.

[^guides]: [journal.yml](../guide/journal-yml.md) is every setting and what changing it does; [branding](../guide/branding.md) is the logo, the colours and the mark on the PDF; [editorial checks](../guide/checks.md) is what a submission is held to; [pinned versions](../guide/pins.md) is what nothing upgrades for you; [interactive figures](../guide/interactive-figure.md) is for a paper that needs one.

[^journal-config]: The journal's name, its branding, the editorial checks a submission has to pass, the editions papers are grouped into, and the registry of what has been published. [Files](../reference/files.md) takes them one at a time.

[^around]: Where the journal's settings live, which version of the engine to run, what the editorial checks are, how a preview gets deployed, how a DOI gets reserved, and how an author's pull request gets built without handing it a token.

[^cleanup]: It is not deleted when the build ends. MyST's HTML build finishes by calling `process.exit(0)`, so anything registered to run at the end of the process never runs on a successful build. Deleting the file by hand is always safe.
