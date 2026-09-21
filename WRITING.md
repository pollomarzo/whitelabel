# Writing

Prose rules, for the docs and for anything else made of sentences. `STYLE.md` is the same job for code, `message-style.md` for the strings `oak` prints.

These are derived from edits to agent drafts, not introspected: a pattern that shows up across several of those diffs lands here, and anything else is taste and stays out. This file is the single home for them. A drafting agent reads it before writing and a reviewing agent checks against it, so neither gets a private checklist to drift against.

## What each section is for

| | reader | density |
|---|---|---|
| `docs/start/`, `docs/guide/` | a researcher who wants to publish and leave | task-shaped, no rationale |
| `docs/reference/` | someone looking a fact up | one home per fact, no narrative |
| `docs/design/` | a forker asking why it is shaped like this | mechanism and trade-off, the only place rationale belongs |

## Rules

### Do not hard-wrap prose

A paragraph is one line. Not 80, not 95.

The wrap buys nothing rendered, and it makes every later edit a reflow, so a one-word change touches five lines and the real edit is invisible in the diff. Code, tables and genuinely short list items stay as they are.

### Do not assert importance

A clause whose content is *this matters* carries no information. Give the reason, or cut the clause.

```
Bad:   "This is the rule that is easiest to get wrong."
Good:  the rule, then what breaks when it is broken.
```

### Do not over-claim scope

State what the page covers, not what the reader needs.

```
Bad:   "everything you need to configure a journal"
Good:  "configuring journal.yml"
```

### Do not say it twice, once by negation

Keep the positive clause. The denial adds nothing.

```
Bad:   "This is not a build system, just a thin wrapper over mystmd."
Good:  "A thin wrapper over mystmd."
```

### Say it once, at the shortest length that still carries the mechanism

The failure is not long sentences, it is a point made three times: stated, restated as a summary, then again as a consequence. Keep the statement that carries the mechanism and delete the others. A bulleted list whose lead-in already said the same thing in prose is the common case.

### No fact that goes stale the moment something is added

Name the things, do not count them. The reader can see how many there are.

```
Bad:   "the four checks oak validate runs"
Good:  "the checks oak validate runs"
```

Dated liveness claims are the same defect. "Certified live 2026-09-05" is unfalsifiable as soon as whatever backed it is gone: state the rule, not the run.

### Do not cite what the reader cannot open

A pointer to a private notebook, a home directory or a repo nobody outside has access to is dead weight dressed as provenance. Carry the substance across, which is the claim plus its date, and drop the path.

### Describe the thing as it is, not relative to what it replaced

No "no longer", "used to", "replaces", "instead of". `STYLE.md` bans these in comments for the same reason: the reader never saw the earlier version, so the comparison costs them a question and answers none. The exception is a migration guide, where what changed is the subject.

### Do not carry old framing past the fact that produced it

A conclusion outlives the constraint it rested on and quietly becomes false. When a fact moves, grep for it before assuming one edit covers it, because it is usually written down in more than one place.

### Do not imply a decision that has not been made

Where a choice is still open the text says so. A definite article is a claim.

## Design pages

`[R#]` and `design §N` are cited from source comments, and `npm run check:refs` asserts each one resolves to an `(r#)=` or `(design-N)=` anchor under `docs/design/`. An anchor moves between pages; while a citation to it survives it is never duplicated and never dropped. Deleting an entry means deleting its citations in the same commit.

An entry earns prose on a design page when it constrains behaviour now. A bug that was fixed, a run that passed, a sweep that finished: those are deleted rather than archived.

The ref check is the only thing here a machine enforces. The rest is convention that review applies.
