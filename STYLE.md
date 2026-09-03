# Style

This is relative to code. Every string `oak` prints is `message-style.md`'s.

## Module headers

Every module opens with a short block comment; if there's lots to say, a dedicated docs page should be created. It contains: the filename, a one-line role, then optionally the constraint or decision that explains why the module exists at all. It cites `design §N` or `[R#]`.

```ts
/**
 * yaml-io.ts: working-tree myst.yml round-trips (design §12 "no sed/grep", [R3]).
 *
 * <optionally, the constraint, and what would go wrong without it, in few lines max>
 */
```

The role line is what a reader skims in `NOTES.md`'s module map.

## Comments

Comments earn their place or go: state the constraint, not the story.

**Keep**, each in one line:

- A comment stating a **constraint, invariant, or ratified decision**, citing the reference the reader can open (below) rather than restating it.
- A comment saying **why this is not the obvious approach**: a dead end, named.
- A comment saying **why this looks wrong but is not**. It guards against a plausible wrong edit, so it reads as narration and is the one most likely to be deleted by mistake. Keep it.

**Go:**

- A comment **narrating the next line**.
- A comment describing **what the code used to do**. Comments describe the code as it is, not relative to what it replaced: no "no longer", "used to", "replaces", "instead of".
- A **long rationale**: it becomes a link or an `[R#]`, never a paragraph.

When in doubt, cut. A three-line justification is a one-line constraint plus its reference.

### Which reference to cite

Cite the one the reader *of this file* can open:

- `[R#]` for engine internals (resolves in the ledger).
- the user doc page for a verb's **observable behaviour**: test it by asking whether the sentence is still true reading only the CLI's observable behaviour; if so it is user docs, not a source comment.
- where neither resolves, the one line must be self-contained.

```ts
// BAD:  read from brand.yml directly, not the merged config, so that only
//       brand-declared assets are treated as brand-relative
// GOOD: read from brand.yml, not merged config [R42]
```

Every cited `[R#]` must resolve in the ledger; a doc link owes the same CI treatment, a path-and-anchor resolution check, or it rots faster than the comment it replaced ([R160]). Seeded files under `templates/` carry **no** `[R#]` (a tenant cannot resolve them); the engine's own `templates/*/README.md` may, since those stay in the engine repo.

### JSDoc

Every export gets one: contract first (what it returns, what it throws), in a line or two. A constraint riding along in a JSDoc is still one line plus its `[R#]`. Cross-reference other symbols with `{@link Name}`, not a bare mention.

## Naming

- `SCREAMING_SNAKE` for module constants (`DOCS_BASE`, `THEME_REPO`, `DERIVED_CONFIG_FILE`).
- `camelCase` for everything else. `read*` for a raw lift out of a file, `render*` for template-to-string, `run*` / `cmd*` for verb entry points.
- Spell the tool out: `engineRepo`, not `repo`. Coordinates that appear in YAML keep the YAML spelling (`engine_repo` in a file, `engineRepo` in TS).
- British spelling, matching `message-style.md` rule 9.

## Errors

- A fault the tenant caused is a `UserError` carrying a `msg.*` string. It names the file and the fix, and never reaches them as a stack.
- A fault the engine caused is an ordinary `Error` and may be ugly.
- Never throw a string literal, and never build a tenant-facing sentence at the throw site: the words live in `messages.ts`.

## Readers and errors

A reader returns undefined/empty when absence is a meaningful value, a rung declining or an option unset. It throws when absence means the operation cannot proceed at all. Validation belongs to `oak validate` and `checks.ts`, in one place, where it can be reported coherently.

Narrow YAML reads with a guard (`typeof v === 'string' && v`), never a cast.

## Seams and purity

Side effects are injected, not imported, so the logic under them stays testable offline:

- `compose()` is **pure**. Keep it that way.
- Network, `git`, and `gh` live in `gh.ts` so `zenodo.ts` stays network-free under test.
- mystmd is behind `MystEdge`; `myst.ts` is the **only** module importing myst-cli.
- `materialize.ts` exists so `build.ts` and `validate.ts` do not import each other.

Injectables take a default in the signature (`base: string = DOCS_BASE`), rather than an options object, when there is exactly one of them.

## Module boundaries

The import graph is layered and has no cycles. Keep it that way: if a new import would close a loop, the shared thing wants its own module. `cli.ts` reaches verbs through `await import()` so the bundle does not pull every module into every invocation.

Type-only imports across layers are fine.

## YAML

Round-trip through the `yaml` Document API, never a textual patch, never `sed` ([R3]). This preserves the author's key order and comments.

## Enforced vs convention

| | |
|---|---|
| **Enforced** | prettier (`npm run format:check`), `tsc --noEmit`, vitest |
| **Convention only** | everything in this file, plus every rule in `message-style.md` |

A punctuation or comment-shape CI gate is difficult to create and worse to enforce, so these stay conventions that review applies. It may be that in the future we turn some things (i.e. module cycles) into testable CI gates.
