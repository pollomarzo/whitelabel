/**
 * preview.test.ts: the deploy-preview / notify logic ([R69]), exercised through FAKE seams
 * (no Cloudflare, no git/gh). Proves the degrade-never-fail contract ([R16]), the `.pr-number`
 * strip ([R26]), journal-driven CF config ([R27]), and the new-version reminder ([R23]).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  takePrNumber,
  previewBranch,
  planPreview,
  recordUrlForDoi,
  hasVersionTag,
  previewComment,
  artifactComment,
  newVersionComment,
  loadJournalPreview,
  cmdDeployPreview,
  runNewVersionReminder,
  STICKY_PREVIEW,
  STICKY_NEWVERSION,
  LABEL_EDITOR_ACTION,
  type PagesDeployer,
  type GhPr,
} from '../src/preview.js';
import { JournalConfig } from '../src/schema.js';

/* --------------------------------------------------------------------------
 * Fakes
 * ------------------------------------------------------------------------ */

interface Sticky {
  header: string;
  body: string;
}
interface Label {
  label: string;
}

function fakeGh(over: Partial<GhPr> = {}): {
  gh: GhPr;
  stickies: Sticky[];
  labels: Label[];
} {
  const stickies: Sticky[] = [];
  const labels: Label[] = [];
  const gh: GhPr = {
    sticky(_root, _pr, header, body) {
      stickies.push({ header, body });
    },
    addLabel(_root, _pr, label) {
      labels.push({ label });
    },
    versionTags() {
      return [];
    },
    ...over,
  };
  return { gh, stickies, labels };
}

const okDeployer = (url = 'https://paper-repo-7.pages.dev'): PagesDeployer => ({
  async deploy() {
    return url;
  },
});
const failDeployer = (msg = 'CF 500'): PagesDeployer => ({
  async deploy() {
    throw new Error(msg);
  },
});

const previewCfg = (over: Record<string, unknown> = {}) =>
  JournalConfig.parse({
    name: 'x',
    preview: { provider: 'cloudflare', cf_project_name: 'journal-x', ...over },
  }).preview;

function siteWithPr(pr: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'oak-preview-'));
  if (pr !== null) writeFileSync(join(dir, '.pr-number'), pr + '\n');
  return dir;
}

/* --------------------------------------------------------------------------
 * Pure logic
 * ------------------------------------------------------------------------ */

describe('takePrNumber', () => {
  it('reads and DELETES .pr-number ([R26])', () => {
    const dir = siteWithPr('42');
    expect(takePrNumber(dir)).toBe('42');
    expect(existsSync(join(dir, '.pr-number'))).toBe(false); // stripped before serving
  });
  it('returns null when absent', () => {
    expect(takePrNumber(siteWithPr(null))).toBeNull();
  });
  it('treats a blank file as null', () => {
    expect(takePrNumber(siteWithPr('   '))).toBeNull();
  });
});

describe('previewBranch', () => {
  it('substitutes {repo}/{pr} and uses the short repo name', () => {
    expect(previewBranch('paper-{repo}-{pr}', 'impact-scholars/geetha-2026-pd', '9')).toBe(
      'paper-geetha-2026-pd-9',
    );
  });
  it('slugifies to a CF-safe alias and truncates', () => {
    const b = previewBranch('{repo}_{pr}', 'Owner/Weird Name!!', '3');
    expect(b).toMatch(/^[a-z0-9-]+$/);
    expect(b.length).toBeLessThanOrEqual(28);
    expect(b.endsWith('-')).toBe(false);
  });
});

describe('planPreview', () => {
  const cf = { apiToken: 't', accountId: 'a' };
  it('deploys to cloudflare when provider + secrets + project name are all present', () => {
    const plan = planPreview({ preview: previewCfg(), cf, repo: 'o/r', pr: '5' });
    expect(plan).toMatchObject({
      mode: 'cloudflare',
      projectName: 'journal-x',
      branch: 'paper-r-5',
    });
  });
  it('degrades when provider is not cloudflare', () => {
    const plan = planPreview({
      preview: previewCfg({ provider: 'artifact' }),
      cf,
      repo: 'o/r',
      pr: '5',
    });
    expect(plan).toMatchObject({ mode: 'artifact' });
  });
  it('degrades when secrets are absent ([R6])', () => {
    const plan = planPreview({ preview: previewCfg(), cf: {}, repo: 'o/r', pr: '5' });
    expect(plan).toMatchObject({ mode: 'artifact', reason: expect.stringContaining('secrets') });
  });
  it('degrades when cf_project_name is unset', () => {
    const plan = planPreview({
      preview: previewCfg({ cf_project_name: undefined }),
      cf,
      repo: 'o/r',
      pr: '5',
    });
    expect(plan).toMatchObject({
      mode: 'artifact',
      reason: expect.stringContaining('cf_project_name'),
    });
  });
});

describe('recordUrlForDoi', () => {
  it('maps a sandbox DOI', () => {
    expect(recordUrlForDoi('10.5072/zenodo.12345')).toEqual({
      doi: '10.5072/zenodo.12345',
      recordUrl: 'https://sandbox.zenodo.org/records/12345',
    });
  });
  it('maps a prod DOI', () => {
    expect(recordUrlForDoi('10.5281/zenodo.999')).toEqual({
      doi: '10.5281/zenodo.999',
      recordUrl: 'https://zenodo.org/records/999',
    });
  });
  it('errors on an unrecognized prefix', () => {
    expect(recordUrlForDoi('10.9999/x')).toHaveProperty('error');
  });
});

describe('hasVersionTag', () => {
  it('detects v* tags, ignoring blanks', () => {
    expect(hasVersionTag(['v1.0.0', 'other'])).toBe(true);
    expect(hasVersionTag(['sometag', ''])).toBe(false);
    expect(hasVersionTag([])).toBe(false);
  });
});

describe('comment bodies', () => {
  it('preview comment carries the sticky marker + URL', () => {
    const b = previewComment('https://x.pages.dev');
    expect(b).toContain(`oak-sticky: ${STICKY_PREVIEW}`);
    expect(b).toContain('https://x.pages.dev');
  });
  it('artifact comment carries the marker, run URL, and reason', () => {
    const b = artifactComment('https://gh/o/r/actions', 'no secrets');
    expect(b).toContain(`oak-sticky: ${STICKY_PREVIEW}`);
    expect(b).toContain('https://gh/o/r/actions');
    expect(b).toContain('no secrets');
  });
  it('new-version comment carries the marker, record URL, and DOI', () => {
    const b = newVersionComment('10.5281/zenodo.1', 'https://zenodo.org/records/1');
    expect(b).toContain(`oak-sticky: ${STICKY_NEWVERSION}`);
    expect(b).toContain('https://zenodo.org/records/1');
    expect(b).toContain('10.5281/zenodo.1');
  });
});

describe('loadJournalPreview', () => {
  it('returns schema defaults with no instance', () => {
    expect(loadJournalPreview(null).provider).toBe('artifact');
  });
  it('reads the fixture-instance journal.yml (provider: artifact)', () => {
    expect(loadJournalPreview('test/fixture-instance').provider).toBe('artifact');
  });
});

/* --------------------------------------------------------------------------
 * Orchestration: cmdDeployPreview
 * ------------------------------------------------------------------------ */

const baseInput = (siteDir: string, over: Record<string, unknown> = {}) => ({
  siteDir,
  repoRoot: '/repo',
  instanceRoot: null,
  repo: 'o/r',
  serverUrl: 'https://github.com',
  cf: { apiToken: 't', accountId: 'a' },
  mystPath: join(siteDir, 'no-myst.yml'), // absent ⇒ notify no-DOI path (not reached w/o tags)
  ...over,
});

describe('cmdDeployPreview', () => {
  it('deploys to cloudflare and posts the preview comment (provider: cloudflare)', async () => {
    const dir = siteWithPr('7');
    const { gh, stickies } = fakeGh();
    const out = await cmdDeployPreview(baseInput(dir, { instanceRoot: instanceCf(dir) }), {
      deployer: okDeployer(),
      gh,
    });
    expect(out.exitCode).toBe(0);
    expect(out.result.preview).toBe('cloudflare');
    expect(stickies.some((s) => s.header === STICKY_PREVIEW && s.body.includes('pages.dev'))).toBe(
      true,
    );
    expect(existsSync(join(dir, '.pr-number'))).toBe(false); // stripped
  });

  it('degrades to an artifact comment when the CF deploy throws, never fails ([R16])', async () => {
    const dir = siteWithPr('7');
    const { gh, stickies } = fakeGh();
    const out = await cmdDeployPreview(baseInput(dir, { instanceRoot: instanceCf(dir) }), {
      deployer: failDeployer('boom'),
      gh,
    });
    expect(out.exitCode).toBe(0); // NOT a failure
    expect(out.result.preview).toBe('artifact');
    const c = stickies.find((s) => s.header === STICKY_PREVIEW)!;
    expect(c.body).toContain('boom');
    expect(c.body).toContain('/actions');
  });

  it('degrades to an artifact comment when no CF secrets are present', async () => {
    const dir = siteWithPr('7');
    const { gh, stickies } = fakeGh();
    const out = await cmdDeployPreview(baseInput(dir, { cf: {} }), { deployer: okDeployer(), gh });
    expect(out.result.preview).toBe('artifact');
    expect(stickies.some((s) => s.header === STICKY_PREVIEW)).toBe(true);
  });

  it('deep-links the degrade comment to the specific Paper CI run (artifactRunId)', async () => {
    const dir = siteWithPr('7');
    const { gh, stickies } = fakeGh();
    await cmdDeployPreview(baseInput(dir, { cf: {}, artifactRunId: '12345' }), {
      deployer: okDeployer(),
      gh,
    });
    const c = stickies.find((s) => s.header === STICKY_PREVIEW)!;
    expect(c.body).toContain('/actions/runs/12345');
  });

  it('no-ops when there is no .pr-number', async () => {
    const dir = siteWithPr(null);
    const { gh, stickies } = fakeGh();
    const out = await cmdDeployPreview(baseInput(dir), { deployer: okDeployer(), gh });
    expect(out.result.preview).toBe('skipped');
    expect(stickies).toHaveLength(0);
  });

  it('runs the new-version reminder inline ([R16]), posts on an already-published paper', async () => {
    const dir = siteWithPr('7');
    const mystPath = join(dir, 'myst.yml');
    writeFileSync(mystPath, 'project:\n  doi: 10.5281/zenodo.55\n');
    const { gh, stickies, labels } = fakeGh({ versionTags: () => ['v1.0.0'] });
    const out = await cmdDeployPreview(baseInput(dir, { cf: {}, mystPath }), {
      deployer: okDeployer(),
      gh,
    });
    expect((out.result.notify as Record<string, unknown>).reminder).toBe('posted');
    expect(stickies.some((s) => s.header === STICKY_NEWVERSION)).toBe(true);
    expect(labels.some((l) => l.label === LABEL_EDITOR_ACTION)).toBe(true);
  });

  it('propagates a notify failure (published-but-unlinked) even after posting the preview ([R16] is CF-only)', async () => {
    const dir = siteWithPr('7');
    const mystPath = join(dir, 'myst.yml'); // no project.doi
    writeFileSync(mystPath, 'project:\n  title: x\n');
    const { gh, stickies } = fakeGh({ versionTags: () => ['v1.0.0'] });
    const out = await cmdDeployPreview(baseInput(dir, { cf: {}, mystPath }), {
      deployer: okDeployer(),
      gh,
    });
    expect(out.exitCode).toBe(1); // the run fails loudly
    expect(out.result.status).toBe('error');
    expect(stickies.some((s) => s.header === STICKY_PREVIEW)).toBe(true); // preview still posted
  });
});

// A minimal instance dir with a cloudflare-provider journal.yml.
function instanceCf(near: string): string {
  const dir = mkdtempSync(join(near, '..', 'oak-inst-'));
  writeFileSync(
    join(dir, 'journal.yml'),
    'name: J\npreview:\n  provider: cloudflare\n  cf_project_name: journal-x\n',
  );
  return dir;
}

/* --------------------------------------------------------------------------
 * Orchestration: runNewVersionReminder
 * ------------------------------------------------------------------------ */

describe('runNewVersionReminder', () => {
  const mystWith = (doi?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'oak-notify-'));
    const p = join(dir, 'myst.yml');
    writeFileSync(p, doi ? `project:\n  doi: ${doi}\n` : 'project:\n  title: x\n');
    return p;
  };
  const input = (mystPath: string, tags: string[]) => ({
    input: { repoRoot: '/repo', mystPath, repo: 'o/r', pr: '3' },
    gh: fakeGh({ versionTags: () => tags }),
  });

  it('skips on a first-deposit paper (no v* tags)', () => {
    const { input: i, gh } = input(mystWith('10.5281/zenodo.1'), []);
    const out = runNewVersionReminder(i, gh.gh);
    expect(out.result.reminder).toBe('skipped');
    expect(gh.stickies).toHaveLength(0);
  });

  it('posts + labels when published with a valid DOI', () => {
    const { input: i, gh } = input(mystWith('10.5072/zenodo.9'), ['v1.0.0']);
    const out = runNewVersionReminder(i, gh.gh);
    expect(out.result.reminder).toBe('posted');
    expect(out.result.record_url).toBe('https://sandbox.zenodo.org/records/9');
    expect(gh.labels).toHaveLength(1);
  });

  it('hard-errors (exit 1) when a v* tag exists but the DOI is missing, published but unlinked', () => {
    const { input: i, gh } = input(mystWith(undefined), ['v2.0.0']);
    const out = runNewVersionReminder(i, gh.gh);
    expect(out.exitCode).toBe(1);
    expect(out.result.reminder).toBe('error');
    expect(gh.stickies).toHaveLength(0);
  });

  it('hard-errors (exit 1) on an unparseable DOI prefix', () => {
    const { input: i, gh } = input(mystWith('10.1234/foo'), ['v2.0.0']);
    const out = runNewVersionReminder(i, gh.gh);
    expect(out.exitCode).toBe(1);
    expect(out.result.reminder).toBe('error');
  });
});
