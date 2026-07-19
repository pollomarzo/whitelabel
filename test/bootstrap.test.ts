/**
 * bootstrap.test.ts — `oak bootstrap` rendering + orchestration (slice 5), through FAKE
 * provisioning seams (no gh/git). Proves: pins.yml/CODEOWNERS/myst.yml render + byte-copy of
 * the rest; the new-model ingest restoring the whole editor-side `.github/`; idempotent
 * GET-then-act; secrets set-if-provided else a printed runbook; org-team vs personal bypass;
 * and the journal external (no shim, public) vs co-located (shim + starter paper) tiers.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  renderTemplate,
  renderInstanceConfig,
  buildReviewTree,
  cmdBootstrapPaper,
  cmdBootstrapJournal,
  RULESET_V_TAGS,
  type Provisioner,
  type TemplateAnswers,
  type BootstrapDeps,
} from '../src/bootstrap.js';

const TEMPLATE_ROOT = 'copier-template';
const tmp = (p = 'oak-bs-') => mkdtempSync(join(tmpdir(), p));

const answers = (over: Partial<TemplateAnswers> = {}): TemplateAnswers => ({
  engineRepo: 'me/engine',
  instanceRepo: 'me/instance-config',
  owner: '@alice',
  version: 'v1.2.3',
  edition: 'ed-2026',
  journalName: 'Test Journal',
  ...over,
});

/* --------------------------------------------------------------------------
 * renderTemplate / renderInstanceConfig
 * ------------------------------------------------------------------------ */

describe('renderTemplate', () => {
  it('renders pins.yml + CODEOWNERS + myst.yml and byte-copies the rest', () => {
    const dest = tmp();
    const written = renderTemplate(TEMPLATE_ROOT, dest, answers());

    const pins = parseDocument(readFileSync(join(dest, '.github/actions/engine/pins.yml'), 'utf8'));
    expect(pins.get('engine_repo')).toBe('me/engine');
    expect(pins.get('instance_repo')).toBe('me/instance-config');

    const co = readFileSync(join(dest, 'CODEOWNERS'), 'utf8');
    expect(co).toMatch(/\/\.github\/\s+@alice/);
    expect(co).toMatch(/\/CODEOWNERS\s+@alice/);
    expect(co).not.toContain('@pollomarzo');

    const myst = parseDocument(readFileSync(join(dest, 'myst.yml'), 'utf8'));
    expect(myst.getIn(['project', 'options', 'oaktree-sapling', 'version'])).toBe('v1.2.3');
    expect(myst.getIn(['project', 'options', 'oaktree-sapling', 'edition'])).toBe('ed-2026');

    // a byte-copied frozen file is identical to source
    const rel = '.github/workflows/ci.yml';
    expect(readFileSync(join(dest, rel), 'utf8')).toBe(readFileSync(join(TEMPLATE_ROOT, rel), 'utf8'));

    // the template README + instance skeleton are NOT stamped into a paper
    expect(existsSync(join(dest, 'README.md'))).toBe(false);
    expect(existsSync(join(dest, 'instance-config'))).toBe(false);
    expect(written).toContain('.github/workflows/version-bump.yml');
  });

  it('co-located writes instance_repo: .', () => {
    const dest = tmp();
    renderTemplate(TEMPLATE_ROOT, dest, answers({ instanceRepo: '.' }));
    const pins = parseDocument(readFileSync(join(dest, '.github/actions/engine/pins.yml'), 'utf8'));
    expect(pins.get('instance_repo')).toBe('.');
  });
});

describe('renderInstanceConfig', () => {
  it('sets journal name and renames the edition file to <edition>.yml', () => {
    const dest = tmp();
    renderInstanceConfig(TEMPLATE_ROOT, dest, answers({ edition: 'ed-2026' }));
    const journal = parseDocument(readFileSync(join(dest, 'journal.yml'), 'utf8'));
    expect(journal.get('name')).toBe('Test Journal');
    expect(existsSync(join(dest, 'editions/ed-2026.yml'))).toBe(true);
    expect(existsSync(join(dest, 'editions/edition.yml'))).toBe(false);
    expect(existsSync(join(dest, 'brand/logo.svg'))).toBe(true);
    expect(existsSync(join(dest, 'registry/papers.yml'))).toBe(true);
  });
});

describe('buildReviewTree (new-model ingest)', () => {
  it('restores the WHOLE editor-side .github, including pins.yml (author-side dropped)', () => {
    const author = {
      'index.md': 'author paper',
      '.github/actions/engine/pins.yml': 'engine_repo: EVIL/attacker',
      '.github/workflows/ci.yml': 'malicious',
    };
    const main = {
      '.github/actions/engine/pins.yml': 'engine_repo: me/engine',
      '.github/workflows/ci.yml': 'frozen ci',
      'CODEOWNERS': '/.github/ @alice',
    };
    const review = buildReviewTree(author, main);
    expect(review['index.md']).toBe('author paper'); // author content survives
    expect(review['.github/actions/engine/pins.yml']).toBe('engine_repo: me/engine'); // editor-side
    expect(review['.github/workflows/ci.yml']).toBe('frozen ci');
    expect(review['CODEOWNERS']).toBe('/.github/ @alice');
  });
});

/* --------------------------------------------------------------------------
 * Fake Provisioner
 * ------------------------------------------------------------------------ */

interface FakeState {
  ownerType?: 'Organization' | 'User';
  repos?: Set<string>;
  branches?: Set<string>; // "repo/branch"
  rulesets?: Set<string>; // "repo/name"
  pages?: Set<string>;
  policies?: Set<string>; // "repo/env/name"
  visibility?: 'public' | 'private';
}

function fakeProv(state: FakeState = {}) {
  const calls: Record<string, unknown[]> = {
    createRepo: [], seedBranch: [], ingestReviewBranch: [], openPr: [], grantTeamWrite: [],
    createRuleset: [], enablePages: [], upsertEnvironment: [], createBranchPolicy: [],
    createLabel: [], setSecret: [], setRepoPublic: [],
  };
  const rec = (k: string, ...args: unknown[]) => calls[k]!.push(args.length === 1 ? args[0] : args);
  const prov: Provisioner = {
    ownerType: () => state.ownerType ?? 'User',
    repoExists: (r) => state.repos?.has(r) ?? false,
    createRepo: (r, o) => rec('createRepo', { r, o }),
    branchExists: (r, b) => state.branches?.has(`${r}/${b}`) ?? false,
    seedBranch: (r, b, _d, m) => rec('seedBranch', { r, b, m }),
    ingestReviewBranch: (r, o) => rec('ingestReviewBranch', { r, o }),
    prExists: (r, h) => state.branches?.has(`${r}/pr:${h}`) ?? false,
    openPr: (r, o) => {
      rec('openPr', { r, o });
      return `https://github.com/${r}/pull/1`;
    },
    grantTeamWrite: (r, t) => rec('grantTeamWrite', { r, t }),
    teamId: () => 4242,
    rulesetExists: (r, n) => state.rulesets?.has(`${r}/${n}`) ?? false,
    createRuleset: (r, b) => rec('createRuleset', { r, b }),
    pagesEnabled: (r) => state.pages?.has(r) ?? false,
    enablePages: (r) => rec('enablePages', r),
    environmentExists: () => false,
    upsertEnvironment: (r, n) => rec('upsertEnvironment', { r, n }),
    branchPolicyExists: (r, e, n) => state.policies?.has(`${r}/${e}/${n}`) ?? false,
    createBranchPolicy: (r, e, n, t) => rec('createBranchPolicy', { r, e, n, t }),
    createLabel: (r, n) => rec('createLabel', { r, n }),
    setSecret: (r, n) => rec('setSecret', { r, n }),
    repoVisibility: () => state.visibility ?? 'public',
    setRepoPublic: (r) => rec('setRepoPublic', r),
  };
  return { prov, calls };
}

function deps(prov: Provisioner): BootstrapDeps {
  return { prov, templateRoot: TEMPLATE_ROOT, log: () => {}, confirm: async () => true, workdir: () => tmp('oak-seed-') };
}

const paperInput = (over: Record<string, unknown> = {}) => ({
  repo: 'me/paper',
  edition: 'ed-2026',
  engineVersion: 'v1.2.3',
  engineRepo: 'me/engine',
  authedUser: 'alice',
  private: false,
  secrets: {},
  ...over,
});

/* --------------------------------------------------------------------------
 * cmdBootstrapPaper
 * ------------------------------------------------------------------------ */

describe('cmdBootstrapPaper', () => {
  it('bare mode: creates + seeds main, no review/PR, provisions', async () => {
    const { prov, calls } = fakeProv();
    const out = await cmdBootstrapPaper(paperInput(), deps(prov));
    expect(out.result.mode).toBe('bare');
    expect(calls.createRepo).toHaveLength(1);
    expect(calls.seedBranch).toHaveLength(1);
    expect(calls.ingestReviewBranch).toHaveLength(0);
    expect(calls.openPr).toHaveLength(0);
    expect(calls.createRuleset).toHaveLength(2); // protect-main + v-tags
    expect(calls.enablePages).toHaveLength(1);
  });

  it('--from ingest: seeds main, builds review, opens PR', async () => {
    const { prov, calls } = fakeProv();
    const out = await cmdBootstrapPaper(paperInput({ from: 'https://github.com/a/b' }), deps(prov));
    expect(out.result.mode).toBe('ingest');
    expect(calls.seedBranch).toHaveLength(1);
    expect(calls.ingestReviewBranch).toHaveLength(1);
    expect(calls.openPr).toHaveLength(1);
    expect(out.result.pr).toContain('/pull/');
  });

  it('idempotent re-run: skips existing repo/main/ruleset/pages/policy', async () => {
    const { prov, calls } = fakeProv({
      repos: new Set(['me/paper']),
      branches: new Set(['me/paper/main']),
      rulesets: new Set(['me/paper/protect-main', 'me/paper/editors-only-v-tags']),
      pages: new Set(['me/paper']),
      policies: new Set(['me/paper/zenodo-publish/v*']),
    });
    const out = await cmdBootstrapPaper(paperInput(), deps(prov));
    expect(calls.createRepo).toHaveLength(0);
    expect(calls.seedBranch).toHaveLength(0);
    expect(calls.createRuleset).toHaveLength(0);
    expect(calls.enablePages).toHaveLength(0);
    expect(calls.createBranchPolicy).toHaveLength(0);
    expect((out.result.actions as Record<string, string>).repo).toBe('exists');
  });

  it('sets provided secrets and prints a runbook for the missing ones', async () => {
    const { prov, calls } = fakeProv();
    const out = await cmdBootstrapPaper(
      paperInput({ secrets: { zenodoToken: 'zt' } }),
      deps(prov),
    );
    expect(calls.setSecret).toHaveLength(1);
    expect(out.result.secrets_set).toEqual(['ZENODO_TOKEN']);
    const runbook = (out.result.runbook as string[]).join('\n');
    expect(runbook).toContain('ZENODO_TOKEN_SANDBOX');
    expect(runbook).toContain('CLOUDFLARE_API_TOKEN');
    expect(runbook).not.toContain('zt'); // never the value
  });

  it('org owner grants the team + uses a Team bypass; personal uses a repo-admin bypass', async () => {
    const org = fakeProv({ ownerType: 'Organization' });
    await cmdBootstrapPaper(paperInput({ repo: 'org/paper', owner: '@org/editors' }), deps(org.prov));
    expect(org.calls.grantTeamWrite).toHaveLength(1);
    const vTags = (org.calls.createRuleset as Array<{ b: any }>).find((c) => c.b.name === RULESET_V_TAGS)!.b;
    expect(vTags.bypass_actors[0].actor_type).toBe('Team');

    const personal = fakeProv({ ownerType: 'User' });
    await cmdBootstrapPaper(paperInput(), deps(personal.prov));
    expect(personal.calls.grantTeamWrite).toHaveLength(0);
    const vt2 = (personal.calls.createRuleset as Array<{ b: any }>).find((c) => c.b.name === RULESET_V_TAGS)!.b;
    expect(vt2.bypass_actors[0].actor_type).toBe('RepositoryRole');
  });
});

/* --------------------------------------------------------------------------
 * cmdBootstrapJournal
 * ------------------------------------------------------------------------ */

describe('cmdBootstrapJournal', () => {
  it('--external: public repo, instance scaffold, no rulesets/env', async () => {
    const { prov, calls } = fakeProv();
    const out = await cmdBootstrapJournal(
      { repo: 'me/config', tier: 'external', name: 'J', edition: 'ed-2026', engineVersion: 'v1', engineRepo: 'me/engine', authedUser: 'alice', secrets: {} },
      deps(prov),
    );
    expect((calls.createRepo[0] as { o: { private: boolean } }).o.private).toBe(false);
    expect(calls.seedBranch).toHaveLength(1);
    expect(calls.createRuleset).toHaveLength(0); // data-only repo
    expect(out.result.tier).toBe('external');
  });

  it('--external re-run forces a private repo back to public', async () => {
    const { prov, calls } = fakeProv({ repos: new Set(['me/config']), branches: new Set(['me/config/main']), visibility: 'private' });
    await cmdBootstrapJournal(
      { repo: 'me/config', tier: 'external', edition: 'ed-2026', engineVersion: 'v1', engineRepo: 'me/engine', authedUser: 'alice', secrets: {} },
      deps(prov),
    );
    expect(calls.setRepoPublic).toHaveLength(1);
  });

  it('--co-located: seeds shim + starter paper + instance-config, provisions', async () => {
    const { prov, calls } = fakeProv();
    const seedDirs: string[] = [];
    const d = deps(prov);
    d.workdir = () => {
      const dir = tmp('oak-colo-');
      seedDirs.push(dir);
      return dir;
    };
    await cmdBootstrapJournal(
      { repo: 'me/journal', tier: 'co-located', name: 'J', edition: 'ed-2026', engineVersion: 'v9', engineRepo: 'me/engine', authedUser: 'alice', secrets: {} },
      d,
    );
    expect(calls.createRuleset).toHaveLength(2); // it IS a build unit
    // the seed dir carries BOTH the frozen shim and the co-located instance-config,
    // with pins.yml instance_repo: .
    const seed = seedDirs[0]!;
    expect(existsSync(join(seed, '.github/workflows/ci.yml'))).toBe(true);
    expect(existsSync(join(seed, 'myst.yml'))).toBe(true);
    expect(existsSync(join(seed, 'journal.yml'))).toBe(true);
    const pins = parseDocument(readFileSync(join(seed, '.github/actions/engine/pins.yml'), 'utf8'));
    expect(pins.get('instance_repo')).toBe('.');
  });
});
