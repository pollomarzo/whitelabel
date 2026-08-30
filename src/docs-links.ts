/**
 * docs-links.ts: the tenant-facing documentation link table.
 *
 * Messages, seeded templates and errors reference a SYMBOL here, never a URL string. Two
 * consequences worth keeping: the domain lives in exactly one constant (`DOCS_BASE` in
 * `assets.ts`), and a page move is a one-line edit in this file rather than a hunt through
 * prose.
 *
 * Each value is a TOPIC: a page path, optionally with an anchor. Every anchor names an
 * explicit `(label)=` target written into the page at that spot, never a heading slug,
 * which would move silently when the heading is reworded. `docs/` and this table are
 * therefore edited together; the docs build fails on a label that no longer resolves.
 */
import { DOCS_BASE } from './assets.js';

export const DOCS = {
  /** What to do with a journal repo that `oak bootstrap journal` has just created. */
  journalStart: 'start/journal',
  /** Getting an edit from a local clone onto main, and what that triggers. */
  journalPush: 'start/journal#push-your-edits',
  /** Why the journal website 404s for a few minutes after the first push. */
  journalFirstDeploy: 'start/journal#first-deploy',

  /** What to do with a paper repo an editor has just created, the author's first read. */
  paperStart: 'start/paper',
  /** How a paper repo reaches the journal's settings: `pins.yml`, resolved at build time. */
  paperJournalLink: 'start/paper#paper-journal-link',
  /** Previewing a paper locally, and why `--instance` has to be given a path. */
  paperPreviewLocally: 'start/paper#paper-preview-locally',

  /** `journal.yml` field by field. */
  journalYml: 'guide/journal-yml',
  /** The paper-id rule: what it gates, how to change it, how a failure reads. */
  idPattern: 'guide/journal-yml#id-pattern',
  /** Pointing the journal at its own typst PDF template. */
  typstTemplate: 'guide/journal-yml#typst-template',

  /** The editorial checks a paper is held to. */
  checks: 'guide/checks',
  /** Adding, removing, and de-fanging checks. */
  checksChanging: 'guide/checks#changing-the-set',
  /** `oak validate` runs the paper's own plugin code; read before validating a submission. */
  validateRunsPaperCode: 'guide/checks#validate-runs-paper-code',

  /** Branding: what each knob in `brand/brand.yml` actually changes. */
  branding: 'guide/branding',
  /** The text beside the logo at the top of every page. */
  logoText: 'guide/branding#logo-text',
  /** Where the journal's colours come from, for the website and for the PDF. */
  brandColours: 'guide/branding#colours',
  /** The image the PDF puts on the first page. */
  pdfLogo: 'guide/branding#pdf-logo',

  /** The three versions in the journal repo that nothing bumps for you. */
  pins: 'guide/pins',

  /** Every file in a journal repo and who reads it. */
  files: 'reference/files',
  /** `journal.yml`. */
  fileJournalYml: 'reference/files#file-journal-yml',
  /** `brand/brand.yml`. */
  fileBrandYml: 'reference/files#file-brand-yml',
  /** `editions/<edition>.yml`. */
  fileEditions: 'reference/files#file-editions',
  /** `registry/papers.yml`. */
  fileRegistry: 'reference/files#file-registry',
} as const;

export type DocsTopic = (typeof DOCS)[keyof typeof DOCS];

/** A topic → the URL to print. `base` is injectable so a fork can point elsewhere; a trailing
 *  slash on an injected base is stripped, since `<base>//<topic>` is a different URL to most
 *  servers and an easy thing to hand us. */
export function docsUrl(topic: string, base: string = DOCS_BASE): string {
  return `${base.replace(/\/+$/, '')}/${topic}`;
}
