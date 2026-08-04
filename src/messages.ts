/**
 * messages.ts — the strings `oak` prints to a person, and the plumbing that decides how they
 * are printed. Kept out of the code that produces them so the wording can be read and edited
 * as prose (user decision, 2026-08-04: "every single string shown to the user should be
 * validated by me").
 *
 * The output rules these strings follow (open-tasks/cli-output-pass.md):
 *   1. Nothing the CLI assumes may be silent — every default or auto-resolved value is declared
 *      in the plan before the confirm prompt.
 *   2. No design-doc jargon ([S#]/[R#], "frozen shim", "instance-config", "build_type=workflow").
 *   3. Human prose on stderr by default; the JSON envelope only under `--json`, on stdout.
 *   4. An error names the file and the fix, and never shows a stack trace to a tenant.
 */

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Output plumbing — not prose, but it decides HOW the prose is printed.
 * ═════════════════════════════════════════════════════════════════════════════════════════ */

/** Are we inside a GitHub Actions run? Annotations mean something only there. */
export function inCI(): boolean {
  return Boolean(process.env.GITHUB_ACTIONS ?? process.env.CI);
}

/**
 * A warning/error line. `::warning::…` is GitHub-Actions syntax: in a workflow log it becomes an
 * annotation on the run, and in a tenant's terminal it is line noise in front of the sentence
 * that matters (the UX test read one as part of the error). So the annotation is added ONLY in
 * CI, where a multi-line message must also be escaped — a raw newline silently truncates the
 * annotation to its first line.
 */
export function annotate(kind: 'warning' | 'error', message: string): string {
  if (!inCI()) return kind === 'warning' ? `warning: ${message}` : message;
  return `::${kind}::${message.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`;
}

/**
 * An error whose message was written FOR a tenant. `main()` prints it as a plain sentence and
 * exits 2 — no stack trace, no annotation. Anything else reaching the top level is an engine
 * bug, and gets the stack it needs. The class lives here because the message and the promise
 * "this prints without a stack" are one decision.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * oak build
 * ═════════════════════════════════════════════════════════════════════════════════════════ */

export const build = {
  done: (id: string): string => `oak build: done (id=${id})`,

  /**
   * `oak build` run in the journal repo. The journal repo carries a `journal.yml` but its
   * `myst.yml` is the WEBSITE, not a paper — before the shape check, the co-located rung took
   * that `journal.yml` as proof of a paper and the run died deep inside the config read.
   */
  inJournalRepo: (root: string): string =>
    `oak build: ${root} is the journal repo, not a paper. Its journal.yml holds the journal's ` +
    `settings and its myst.yml is the journal website — there is no manuscript here to build.\n` +
    `The website builds itself: every push to main runs the "Journal site" workflow, which ` +
    `publishes it to GitHub Pages. To look at it before you push, run \`npm install\` once in ` +
    `this repo and then \`npx myst start\`.\n` +
    `To build a paper, run oak build inside that paper's checkout, or pass ` +
    `--paper <path to the paper>.`,

  /**
   * The engine coordinate a paper carries (`project.options.oaktree-sapling.version|edition`)
   * is missing. Names the FILE and the FIX, because the reader is looking at a paper that used
   * to work.
   */
  missingEngineCoordinate: (field: 'version' | 'edition', mystPath: string): string =>
    `oak: ${mystPath} has no engine ${field} — add the \`${field}:\` line back under ` +
    `\`project.options.oaktree-sapling\` (\`oak bootstrap paper\` writes ` +
    `${field === 'version' ? 'it and the edition' : 'it and the version'} when it creates a ` +
    `paper, and \`oak upgrade\` is what changes the version afterwards).\n` +
    (field === 'version'
      ? `It names the engine release that builds this paper, e.g. \`version: v0.1.0\`.`
      : `It names which of the journal's editions this paper appears in — the ids are the ` +
        `filenames under editions/ in the journal repo.`),
};

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * oak validate
 * ═════════════════════════════════════════════════════════════════════════════════════════ */

export const validate = {
  /** `oak validate` typed in the journal repo — the same shape check `oak build` makes, and the
   *  same reason: without it the run dies on an engine coordinate a journal repo never has. */
  inJournalRepo: (root: string): string =>
    `oak validate: ${root} is the journal repo, not a paper — journal.yml holds the journal's ` +
    `settings, and there is no manuscript here to check. The journal's settings are checked by ` +
    `each paper's own build, which reads them.\n` +
    `Run oak validate inside a paper's checkout, or pass --paper <path to the paper>.`,
};

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Last resort
 * ═════════════════════════════════════════════════════════════════════════════════════════ */

/** An engine fault (not a tenant's mistake): say so, then show the stack it needs. */
export const engineCrash = (stack: string): string =>
  `oak: the engine hit an unexpected error. This is a bug in oak, not something you did wrong ` +
  `— the details below are what to report.\n${stack}`;
