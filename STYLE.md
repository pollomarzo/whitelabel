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

Comments earn their place or go. Keep them strictly necessary and short: state the constraint, not the story around it. A comment that survives review is load-bearing; the narrative around it is not.

- A comment stating a **constraint, invariant, or ratified decision stays**, in one line, citing its `[R#]` (or a docs link) rather than restating it. The `[R#]` holds the "what would go wrong"; do not spell it out.
- A comment saying **why this is not the obvious approach stays**, in a line. `readBrandAssetOptions`'s "read from brand.yml directly, not the merged config" is the model: the dead end, named, nothing more.
- A comment **narrating the next line goes**.
- A **long rationale** becomes a link or an `[R#]`, never a paragraph in the source.

When in doubt, cut. A three-line justification is a one-line constraint plus its `[R#]`.

Every export gets JSDoc, kept to the contract (what it returns, what it throws), not a narrative. Cross-reference other symbols with `{@link Name}`, not a bare mention.

Every cited `[R#]` must resolve in the ledger. Seeded files under `templates/` carry **no** `[R#]` (a tenant cannot resolve them); the engine's own `templates/*/README.md` may, since those stay in the engine repo.

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
