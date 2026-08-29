# Message style

Rules for every string `oak` prints. Most live in `src/messages.ts`, but the seeded
workflows under `templates/` and `ci/run.sh` print too, and nothing enforces these rules
there; check them by hand when you touch one.

1. No em or en dashes. Use a period, semicolon, colon, comma, or parentheses. Comments,
   docs and test names follow this too, by convention and not by a check: a CI gate on a
   punctuation mark would be a stranger thing to find in the repo than the dashes were.
2. Don't hide the stack: mystmd, gh, git, Cloudflare, Zenodo do the work; name them. `oak` is the engine, in prose as well as in flag and field names.
3. Every default or auto-resolved value is declared in the plan, with its source: `(flag)` or "built-in default".
4. An error names the file and the fix, prefixes `oak <verb>:`, and never shows a stack.
5. A refusal explains why once. More than that wants a docs link, not prose.
6. Links are `docsUrl(DOCS.<topic>)`, never a raw URL.
7. Short beats complete. If a clause survives deletion, delete it.
8. No filler ("Oops", "Sorry", "Unfortunately"), no exclamation marks, no emoji outside PR comments.
9. British spelling (colour, behaviour).
10. Keep `${…}` holes and `oak <verb>:` prefixes; tests assert on fragments.
