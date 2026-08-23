# Message style

Rules for every string `oak` prints (`src/messages.ts`). Comments and test code are exempt.

1. No em or en dashes. Use a period, semicolon, colon, comma, or parentheses.
2. Don't hide the stack: mystmd, gh, git, Cloudflare, Zenodo do the work; name them. `oak` is the engine, in prose as well as in flag and field names.
3. Every default or auto-resolved value is declared in the plan, with its source: `(flag)` or "built-in default".
4. An error names the file and the fix, prefixes `oak <verb>:`, and never shows a stack.
5. A refusal explains why once. More than that wants a docs link, not prose.
6. Links are `docsUrl(DOCS.<topic>)`, never a raw URL.
7. Short beats complete. If a clause survives deletion, delete it.
8. No filler ("Oops", "Sorry", "Unfortunately"), no exclamation marks, no emoji outside PR comments.
9. British spelling (colour, behaviour).
10. Keep `${…}` holes and `oak <verb>:` prefixes; tests assert on fragments.
