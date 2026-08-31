/**
 * bootstrap.test.ts: `oak bootstrap` rendering + orchestration (slice 5), through FAKE
 * provisioning seams (no gh/git). Proves: pins.yml/CODEOWNERS/myst.yml render + byte-copy of
 * the rest; the new-model ingest restoring the whole editor-side `.github/`; idempotent
 * GET-then-act; secrets set-if-provided else a printed runbook; org-team vs personal bypass;
 * and the journal external (instance-config ⊎ the journal site, public) vs co-located
 * (shim + starter paper, no site) tiers.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { themeZipUrl } from '../src/assets.js';
import {
  renderPaperTemplate,
  renderInstanceTemplate,
  renderSiteTemplate,
  galleryPluginUrl,
  engineMystRange,
  buildReviewTree,
  cmdBootstrapPaper,
  cmdBootstrapJournal,
  RULESET_V_TAGS,
  RULESET_PROTECT_MAIN,
  type Provisioner,
  type EnvironmentReviewer,
  type TemplateAnswers,
  type BootstrapDeps,
} from '../src/bootstrap.js';
import { LABEL_EDITOR_ACTION, LABEL_ZENODO_FAILED } from '../src/preview.js';

const PAPER_ROOT = 'templates/paper';
const INSTANCE_ROOT = 'templates/instance';
const SITE_ROOT = 'templates/site';
const MYST_RANGE = '^9.9.9';
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
 * renderPaperTemplate / renderInstanceTemplate
 * ------------------------------------------------------------------------ */

describe('renderPaperTemplate', () => {
  it('renders pins.yml + CODEOWNERS + myst.yml and byte-copies the rest', () => {
    const dest = tmp();
    const written = renderPaperTemplate(PAPER_ROOT, dest, answers());

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
    expect(readFileSync(join(dest, rel), 'utf8')).toBe(readFileSync(join(PAPER_ROOT, rel), 'utf8'));

    // the engine README is NOT stamped; the instance skeleton lives in a separate tree
    expect(existsSync(join(dest, 'README.md'))).toBe(false);
    expect(existsSync(join(dest, 'journal.yml'))).toBe(false);
    expect(written).toContain('.github/workflows/version-bump.yml');
  });

  it('seeds a LICENSE for the licence the edition asserts ([R127])', () => {
    const dest = tmp();
    const written = renderPaperTemplate(PAPER_ROOT, dest, answers());
    expect(written).toContain('LICENSE');
    // The seeded edition asserts a licence to readers and to Zenodo; the paper repo must carry
    // the matching text, and changing one without the other is what this pins.
    const edition = parseDocument(
      readFileSync(join(INSTANCE_ROOT, 'editions/edition.yml'), 'utf8'),
    );
    expect(edition.getIn(['project', 'license'])).toBe('CC-BY-4.0');
    expect(readFileSync(join(dest, 'LICENSE'), 'utf8')).toContain(
      'Creative Commons Attribution 4.0 International Public License',
    );
  });

  it('co-located writes instance_repo: .', () => {
    const dest = tmp();
    renderPaperTemplate(PAPER_ROOT, dest, answers({ instanceRepo: '.' }));
    const pins = parseDocument(readFileSync(join(dest, '.github/actions/engine/pins.yml'), 'utf8'));
    expect(pins.get('instance_repo')).toBe('.');
  });
});

describe('renderInstanceTemplate', () => {
  it('sets journal name and renames the edition file to <edition>.yml', () => {
    const dest = tmp();
    renderInstanceTemplate(INSTANCE_ROOT, dest, answers({ edition: 'ed-2026' }));
    const journal = parseDocument(readFileSync(join(dest, 'journal.yml'), 'utf8'));
    expect(journal.get('name')).toBe('Test Journal');
    expect(existsSync(join(dest, 'editions/ed-2026.yml'))).toBe(true);
    expect(existsSync(join(dest, 'editions/edition.yml'))).toBe(false);
    expect(existsSync(join(dest, 'brand/logo.svg'))).toBe(true);
    expect(existsSync(join(dest, 'registry/papers.yml'))).toBe(true);
  });
});

describe('renderSiteTemplate', () => {
  it('stamps the four rendered values and byte-copies the rest', () => {
    const dest = tmp();
    const written = renderSiteTemplate(SITE_ROOT, dest, answers(), MYST_RANGE);

    const myst = parseDocument(readFileSync(join(dest, 'myst.yml'), 'utf8'));
    expect(myst.getIn(['project', 'title'])).toBe('Test Journal');
    // Rendered FROM the constant, not duplicated, so there is no drift to test for.
    expect(myst.getIn(['site', 'template'])).toBe(themeZipUrl());
    expect(myst.getIn(['project', 'plugins', 0])).toBe(galleryPluginUrl('me/engine', 'v1.2.3'));
    // The brand stays a LOCAL single-entry extends chain (no siblings to race, [R72]).
    expect(myst.get('extends')?.toJSON()).toEqual(['./brand/brand.yml']);

    const index = readFileSync(join(dest, 'pages/index.md'), 'utf8');
    expect(index).toContain('# Test Journal');
    expect(index).not.toContain('{{');

    // ONE dependency list: MyST is pinned in package.json beside the plugin's js-yaml, so
    // the workflow needs no version of its own and is byte-copied.
    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['mystmd']).toBe(MYST_RANGE);
    expect(pkg.dependencies['js-yaml']).toBeTruthy(); // resolvable from THIS repo's node_modules

    // Byte-copied: no `{{token}}` of ours survives because there are none left to render.
    // (It DOES contain `${{ … }}`: those are GitHub Actions expressions, not our tokens.)
    const wf = readFileSync(join(dest, '.github/workflows/site.yml'), 'utf8');
    expect(wf).toBe(readFileSync(join(SITE_ROOT, '.github/workflows/site.yml'), 'utf8'));
    expect(wf).not.toContain('mystmd@');
    // The install is not optional: a remote plugin is imported from _build/cache/, so its
    // bare imports resolve against this repo's node_modules.
    expect(wf).toContain('npm install');
    // --strict is the ONLY thing that catches a remote plugin that failed to load.
    expect(wf).toContain('--strict');
    // BASE_URL from configure-pages: this tier deploys to `<owner>.github.io/<repo>/`, and
    // without it MyST emits root-absolute asset URLs so every image/CSS/JS 404s (found live).
    expect(wf).toContain('configure-pages');
    expect(wf).toContain('BASE_URL: ${{ steps.pages.outputs.base_path }}');
    // A plugin that never loads does NOT fail --strict (verified live): myst logs
    // "Unknown plugin" + "unknown directive" and exits 0. The workflow must therefore assert
    // a POSITIVE signal: the plugin's own name in the build log.
    expect(wf).toContain('Paper Gallery.*loaded');

    // Ships as `gitignore`, stamped as `.gitignore`, npm strips the dotted name from every
    // tarball, so an npm-installed engine would otherwise seed a repo without one.
    expect(readFileSync(join(dest, '.gitignore'), 'utf8')).toBe(
      readFileSync(join(SITE_ROOT, 'gitignore'), 'utf8'),
    );
    expect(existsSync(join(dest, 'README.md'))).toBe(false); // one repo, one README
  });

  it('the stamped plugin URL is pinned to the engine TAG, not a branch', () => {
    const dest = tmp();
    renderSiteTemplate(SITE_ROOT, dest, answers({ version: 'v2.0.0' }), MYST_RANGE);
    const myst = parseDocument(readFileSync(join(dest, 'myst.yml'), 'utf8'));
    expect(myst.getIn(['project', 'plugins', 0])).toBe(
      'https://raw.githubusercontent.com/me/engine/v2.0.0/plugins/gallery.mjs',
    );
  });
});

describe('engineMystRange', () => {
  it('copies the engine package.json myst-cli range VERBATIM (no parsing/normalizing)', () => {
    // myst-cli sits in devDependencies (it ships inlined in the bundle, so the published
    // package installs nothing); npm publishes that block verbatim, so the range is still
    // there to read. Either block counts; the point is the range is copied, not parsed.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = pkg.dependencies?.['myst-cli'] ?? pkg.devDependencies?.['myst-cli'];
    expect(declared).toBeTruthy();
    expect(engineMystRange('.')).toBe(declared);
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
      CODEOWNERS: '/.github/ @alice',
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
  defaultBranch?: string;
  rulesets?: Set<string>; // "repo/name"
  pages?: Set<string>;
  policies?: Set<string>; // "repo/env/name"
  visibility?: 'public' | 'private';
  actionsCanApprovePrs?: boolean;
  environments?: Set<string>; // "repo/env"
  reviewers?: EnvironmentReviewer[]; // what the zenodo-publish env already has
}

function fakeProv(state: FakeState = {}) {
  const calls: Record<string, unknown[]> = {
    createRepo: [],
    allowActionsApprovePrs: [],
    seedBranch: [],
    setDefaultBranch: [],
    ingestReviewBranch: [],
    openPr: [],
    grantTeamWrite: [],
    createRuleset: [],
    enablePages: [],
    upsertEnvironment: [],
    createBranchPolicy: [],
    createLabel: [],
    setSecret: [],
    setRepoPublic: [],
  };
  const rec = (k: string, ...args: unknown[]) => calls[k]!.push(args.length === 1 ? args[0] : args);
  const prov: Provisioner = {
    ownerType: () => state.ownerType ?? 'User',
    repoExists: (r) => state.repos?.has(r) ?? false,
    createRepo: (r, o) => rec('createRepo', { r, o }),
    branchExists: (r, b) => state.branches?.has(`${r}/${b}`) ?? false,
    defaultBranch: () => state.defaultBranch ?? 'main',
    setDefaultBranch: (r, b) => rec('setDefaultBranch', { r, b }),
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
    userId: (login) => (login === 'alice' ? 77 : 99),
    actionsCanApprovePrs: () => state.actionsCanApprovePrs ?? false,
    allowActionsApprovePrs: (r) => rec('allowActionsApprovePrs', r),
    environmentExists: (r, n) => state.environments?.has(`${r}/${n}`) ?? false,
    environmentReviewers: () => state.reviewers ?? [],
    upsertEnvironment: (r, n, v) => rec('upsertEnvironment', { r, n, v }),
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
  return {
    prov,
    paperTemplateRoot: PAPER_ROOT,
    instanceTemplateRoot: INSTANCE_ROOT,
    siteTemplateRoot: SITE_ROOT,
    mystRange: MYST_RANGE,
    log: () => {},
    confirm: async () => true,
    workdir: () => tmp('oak-seed-'),
  };
}

const paperInput = (over: Record<string, unknown> = {}) => ({
  repo: 'me/paper',
  // Required since the instance-less bootstrap fix: a paper must name the journal it belongs
  // to, or its pins.yml claims a co-located journal.yml the render never writes.
  instance: 'me/instance-config',
  edition: 'ed-2026',
  engineVersion: 'v1.2.3',
  engineRepo: 'me/engine',
  authedUser: 'alice',
  private: false,
  requireChecks: true,
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

  it('refuses an instance-less bootstrap up front instead of shipping pins.yml instance_repo: .', async () => {
    // The UX-test defect: without --instance the paper seeded `instance_repo: .`, which claims
    // a co-located journal.yml this render never writes, so the repo bootstrapped "ok" and the
    // first CI run died on "no instance-config resolved". Fail here, where the flag is.
    const { prov, calls } = fakeProv();
    const out = await cmdBootstrapPaper(paperInput({ instance: undefined }), deps(prov));
    expect(out.exitCode).toBe(2);
    expect(out.result.status).toBe('error');
    expect(String(out.result.error)).toContain('--instance');
    expect(String(out.result.error)).toContain('pins.yml');
    // Nothing was touched: the check precedes every effect.
    expect(calls.createRepo).toHaveLength(0);
    expect(calls.seedBranch).toHaveLength(0);
  });

  it('refuses a paper with no --edition instead of inventing one', async () => {
    // The same class as the missing --instance: `edition` is written into the paper's
    // myst.yml and must match an editions/<id>.yml the JOURNAL already has, so a default
    // invented here is a guaranteed CI failure dressed up as a convenience.
    const { prov, calls } = fakeProv();
    const out = await cmdBootstrapPaper(paperInput({ edition: undefined }), deps(prov));
    expect(out.exitCode).toBe(2);
    expect(out.result.status).toBe('error');
    expect(String(out.result.error)).toContain('--edition');
    expect(String(out.result.error)).toContain('editions/');
    // The journal it would have belonged to is named, so the reader knows where to look.
    expect(String(out.result.error)).toContain('me/instance-config');
    expect(calls.createRepo).toHaveLength(0);
    expect(calls.seedBranch).toHaveLength(0);
  });

  it('the plan DECLARES every value the run resolved, before the confirm', async () => {
    // Nothing the CLI assumes may be silent: the prompt is only consent if the defaults are
    // on the screen above it. These lines are what the reader is agreeing to.
    const { prov } = fakeProv();
    const plans: string[][] = [];
    const d = deps(prov);
    d.confirm = async (plan) => {
      plans.push(plan);
      return false;
    };
    await cmdBootstrapPaper(
      paperInput({ resolved: { engineVersionFrom: 'latest-release', engineRepoFrom: 'default' } }),
      d,
    );
    const plan = plans[0]!.join('\n');
    expect(plan).toContain('journal repo   : me/instance-config');
    expect(plan).toContain('edition        : ed-2026');
    // The auto-resolved ones say so, and say which flag pins them.
    expect(plan).toMatch(/engine version : v1\.2\.3: the newest engine release right now/);
    expect(plan).toContain('--engine-version');
    expect(plan).toMatch(/engine repo    : me\/engine: built-in default/);
    expect(plan).toMatch(/review owner   : @alice: your own GitHub login/);
  });

  it('a value that WAS passed is declared as passed, not as a default', async () => {
    const { prov } = fakeProv();
    const plans: string[][] = [];
    const d = deps(prov);
    d.confirm = async (plan) => {
      plans.push(plan);
      return false;
    };
    await cmdBootstrapPaper(
      paperInput({
        owner: '@org/editors',
        resolved: { engineVersionFrom: 'flag', engineRepoFrom: 'flag' },
      }),
      d,
    );
    const plan = plans[0]!.join('\n');
    expect(plan).toContain('engine version : v1.2.3 (--engine-version)');
    expect(plan).toContain('engine repo    : me/engine (--engine-repo)');
    expect(plan).toContain('review owner   : @org/editors (--owner)');
    expect(plan).not.toContain('no --engine-version given');
  });

  it('--instance . is the explicit co-located opt-in and still bootstraps', async () => {
    const { prov, calls } = fakeProv();
    const out = await cmdBootstrapPaper(paperInput({ instance: '.' }), deps(prov));
    expect(out.exitCode).toBe(0);
    expect(calls.seedBranch).toHaveLength(1);
  });

  it('the instance lands in pins.yml as instance_repo', async () => {
    const { prov, calls } = fakeProv();
    const seedDirs: string[] = [];
    const d = deps(prov);
    d.workdir = () => {
      const dir = tmp('oak-seed-');
      seedDirs.push(dir);
      return dir;
    };
    await cmdBootstrapPaper(paperInput({ instance: 'me/journal' }), d);
    expect(calls.seedBranch).toHaveLength(1);
    const pins = parseDocument(
      readFileSync(join(seedDirs[0]!, '.github/actions/engine/pins.yml'), 'utf8'),
    );
    expect(pins.get('instance_repo')).toBe('me/journal');
  });

  it('an aborted run says why, and a re-run warns that main will not be re-stamped', async () => {
    // Two halves of the same UX defect: a bare "aborted" with no reason, printed for a re-run
    // that would not have changed pins.yml even if confirmed.
    const { prov } = fakeProv({
      repos: new Set(['me/paper']),
      branches: new Set(['me/paper/main']),
    });
    const plans: string[][] = [];
    const d = deps(prov);
    d.confirm = async (plan) => {
      plans.push(plan);
      return false;
    };
    const out = await cmdBootstrapPaper(paperInput(), d);
    expect(out.result.status).toBe('aborted');
    expect(String(out.result.reason)).toContain('not confirmed');
    const plan = plans[0]!.join('\n');
    expect(plan).toContain('will NOT rewrite');
    expect(plan).toContain('pins.yml');
  });

  it('protect-main requires "Journal checks" by default; --no-require-checks omits it', async () => {
    const bodyOf = (calls: Record<string, unknown[]>) =>
      (
        calls.createRuleset as Array<{
          b: {
            name: string;
            rules: Array<{
              type: string;
              parameters?: { required_status_checks?: Array<{ context: string }> };
            }>;
          };
        }>
      ).find((c) => c.b.name === 'protect-main')!.b;
    const hasJournalCheck = (body: ReturnType<typeof bodyOf>) =>
      body.rules.some(
        (r) =>
          r.type === 'required_status_checks' &&
          (r.parameters?.required_status_checks ?? []).some((c) => c.context === 'Journal checks'),
      );

    const on = fakeProv();
    await cmdBootstrapPaper(paperInput(), deps(on.prov));
    expect(hasJournalCheck(bodyOf(on.calls))).toBe(true);

    const off = fakeProv();
    await cmdBootstrapPaper(paperInput({ requireChecks: false }), deps(off.prov));
    expect(hasJournalCheck(bodyOf(off.calls))).toBe(false);
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
    const out = await cmdBootstrapPaper(paperInput({ secrets: { zenodoToken: 'zt' } }), deps(prov));
    expect(calls.setSecret).toHaveLength(1);
    expect(out.result.secrets_set).toEqual(['ZENODO_TOKEN']);
    const runbook = (out.result.runbook as string[]).join('\n');
    expect(runbook).toContain('ZENODO_TOKEN_SANDBOX');
    expect(runbook).toContain('CLOUDFLARE_API_TOKEN');
    expect(runbook).not.toContain('zt'); // never the value
  });

  it('allows Actions to open pull requests, or the first DOI write-back fails ([R122])', async () => {
    const { prov, calls } = fakeProv();
    const out = await cmdBootstrapPaper(paperInput(), deps(prov));
    expect(calls.allowActionsApprovePrs).toEqual(['me/paper']);
    expect((out.result.actions as Record<string, string>).actions_pull_requests).toBe('allowed');

    const already = fakeProv({ actionsCanApprovePrs: true });
    await cmdBootstrapPaper(paperInput(), deps(already.prov));
    expect(already.calls.allowActionsApprovePrs).toHaveLength(0); // GET-then-act
  });

  it('names a zenodo-publish reviewer: the team on an org, the owner on an account ([R123])', async () => {
    const org = fakeProv({ ownerType: 'Organization' });
    const orgOut = await cmdBootstrapPaper(
      paperInput({ repo: 'org/paper', owner: '@org/editors' }),
      deps(org.prov),
    );
    expect(org.calls.upsertEnvironment).toEqual([
      { r: 'org/paper', n: 'zenodo-publish', v: [{ type: 'Team', id: 4242 }] },
    ]);
    expect((orgOut.result.actions as Record<string, string>).zenodo_reviewers).toBe(
      'Team org/editors',
    );

    const personal = fakeProv({ ownerType: 'User' });
    await cmdBootstrapPaper(paperInput(), deps(personal.prov));
    expect(personal.calls.upsertEnvironment).toEqual([
      { r: 'me/paper', n: 'zenodo-publish', v: [{ type: 'User', id: 77 }] },
    ]);
  });

  it('an org owner naming no team leaves the gate open, and says so ([R123])', async () => {
    const { prov, calls } = fakeProv({ ownerType: 'Organization' });
    const out = await cmdBootstrapPaper(
      paperInput({ repo: 'org/paper', owner: '@org' }),
      deps(prov),
    );
    expect(calls.upsertEnvironment).toEqual([{ r: 'org/paper', n: 'zenodo-publish', v: [] }]);
    expect((out.result.actions as Record<string, string>).zenodo_reviewers).toBe('none');
    expect((out.result.runbook as string[]).join('\n')).toContain('settings/environments');
  });

  it('a re-run keeps a zenodo-publish reviewer added by hand ([R123])', async () => {
    const { prov, calls } = fakeProv({
      environments: new Set(['me/paper/zenodo-publish']),
      reviewers: [{ type: 'User', id: 12 }],
    });
    const out = await cmdBootstrapPaper(paperInput(), deps(prov));
    expect(calls.upsertEnvironment).toHaveLength(0);
    expect((out.result.actions as Record<string, string>).zenodo_reviewers).toBe('already set');
  });

  it('provisions exactly the labels its consumers ask for ([R127], [R128])', async () => {
    const { prov, calls } = fakeProv();
    await cmdBootstrapPaper(paperInput(), deps(prov));
    expect((calls.createLabel as Array<{ n: string }>).map((c) => c.n)).toEqual([
      LABEL_EDITOR_ACTION,
      LABEL_ZENODO_FAILED,
    ]);
  });

  it('makes main the default branch of a repo that defaulted elsewhere ([R127])', async () => {
    const moved = fakeProv({ defaultBranch: 'master', repos: new Set(['me/paper']) });
    await cmdBootstrapPaper(paperInput(), deps(moved.prov));
    expect(moved.calls.setDefaultBranch).toEqual([{ r: 'me/paper', b: 'main' }]);

    const already = fakeProv();
    await cmdBootstrapPaper(paperInput(), deps(already.prov));
    expect(already.calls.setDefaultBranch).toHaveLength(0);
  });

  it('the merge gate is what protect-main says it is ([R128])', async () => {
    const { prov, calls } = fakeProv();
    await cmdBootstrapPaper(paperInput(), deps(prov));
    const pm = (calls.createRuleset as Array<{ b: any }>).find(
      (c) => c.b.name === RULESET_PROTECT_MAIN,
    )!.b;
    const pr = pm.rules.find((r: any) => r.type === 'pull_request');
    expect(pr.parameters.require_code_owner_review).toBe(true);
    const checks = pm.rules.find((r: any) => r.type === 'required_status_checks');
    expect(checks.parameters.required_status_checks).toEqual([{ context: 'Journal checks' }]);
  });

  it('the v* tag rule stops a tag being moved or deleted, not only created ([R128])', async () => {
    const { prov, calls } = fakeProv();
    await cmdBootstrapPaper(paperInput(), deps(prov));
    const vt = (calls.createRuleset as Array<{ b: any }>).find(
      (c) => c.b.name === RULESET_V_TAGS,
    )!.b;
    expect(vt.rules.map((r: any) => r.type).sort()).toEqual(['creation', 'deletion', 'update']);
  });

  it('a paper repo is public unless the editor asked otherwise ([R128])', async () => {
    const open = fakeProv();
    await cmdBootstrapPaper(paperInput(), deps(open.prov));
    expect((open.calls.createRepo[0] as { o: { private: boolean } }).o.private).toBe(false);

    const closed = fakeProv();
    await cmdBootstrapPaper(paperInput({ private: true }), deps(closed.prov));
    expect((closed.calls.createRepo[0] as { o: { private: boolean } }).o.private).toBe(true);
  });

  it('a solo editor may merge their own gated PR, and still cannot push to main ([R127])', async () => {
    const personal = fakeProv({ ownerType: 'User' });
    await cmdBootstrapPaper(paperInput(), deps(personal.prov));
    const pm = (personal.calls.createRuleset as Array<{ b: any }>).find(
      (c) => c.b.name === RULESET_PROTECT_MAIN,
    )!.b;
    expect(pm.bypass_actors).toEqual([
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' },
    ]);

    // An org team reviews each other, so it gets no bypass on the merge gate.
    const org = fakeProv({ ownerType: 'Organization' });
    await cmdBootstrapPaper(
      paperInput({ repo: 'org/paper', owner: '@org/editors' }),
      deps(org.prov),
    );
    const orgPm = (org.calls.createRuleset as Array<{ b: any }>).find(
      (c) => c.b.name === RULESET_PROTECT_MAIN,
    )!.b;
    expect(orgPm.bypass_actors).toEqual([]);
  });

  it('org owner grants the team + uses a Team bypass; personal uses a repo-admin bypass', async () => {
    const org = fakeProv({ ownerType: 'Organization' });
    await cmdBootstrapPaper(
      paperInput({ repo: 'org/paper', owner: '@org/editors' }),
      deps(org.prov),
    );
    expect(org.calls.grantTeamWrite).toHaveLength(1);
    const vTags = (org.calls.createRuleset as Array<{ b: any }>).find(
      (c) => c.b.name === RULESET_V_TAGS,
    )!.b;
    expect(vTags.bypass_actors[0].actor_type).toBe('Team');

    const personal = fakeProv({ ownerType: 'User' });
    await cmdBootstrapPaper(paperInput(), deps(personal.prov));
    expect(personal.calls.grantTeamWrite).toHaveLength(0);
    const vt2 = (personal.calls.createRuleset as Array<{ b: any }>).find(
      (c) => c.b.name === RULESET_V_TAGS,
    )!.b;
    expect(vt2.bypass_actors[0].actor_type).toBe('RepositoryRole');
    expect(vt2.bypass_actors[0].actor_id, 'GitHub id of the repository admin role').toBe(5);
  });
});

/* --------------------------------------------------------------------------
 * cmdBootstrapJournal
 * ------------------------------------------------------------------------ */

describe('cmdBootstrapJournal', () => {
  /** Journal bootstrap with a workdir we can inspect afterwards. */
  const journalDeps = (prov: Provisioner, seedDirs: string[]) => {
    const d = deps(prov);
    d.workdir = () => {
      const dir = tmp('oak-seed-');
      seedDirs.push(dir);
      return dir;
    };
    return d;
  };

  it('--external: public repo, instance scaffold ⊎ the journal site, Pages, no rulesets/env', async () => {
    const { prov, calls } = fakeProv();
    const seedDirs: string[] = [];
    const out = await cmdBootstrapJournal(
      {
        repo: 'me/config',
        tier: 'external',
        name: 'J',
        edition: 'ed-2026',
        engineVersion: 'v1',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        secrets: {},
      },
      journalDeps(prov, seedDirs),
    );
    expect((calls.createRepo[0] as { o: { private: boolean } }).o.private).toBe(false);
    expect(calls.seedBranch).toHaveLength(1);
    expect(calls.createRuleset).toHaveLength(0); // still no rulesets: registry upkeep is [S5]
    expect(calls.enablePages).toHaveLength(1); // ...but the site needs Pages
    expect(out.result.tier).toBe('external');
    expect(out.result.site_url).toBe('https://me.github.io/config/');

    // The union: instance-config data AND the site, in one repo (A′).
    const seed = seedDirs[0]!;
    expect(existsSync(join(seed, 'journal.yml'))).toBe(true);
    expect(existsSync(join(seed, 'registry/papers.yml'))).toBe(true);
    expect(existsSync(join(seed, 'myst.yml'))).toBe(true);
    expect(existsSync(join(seed, 'pages/index.md'))).toBe(true);
    expect(existsSync(join(seed, '.github/workflows/site.yml'))).toBe(true);
    const myst = parseDocument(readFileSync(join(seed, 'myst.yml'), 'utf8'));
    expect(myst.getIn(['site', 'template'])).toBe(themeZipUrl());
    expect(myst.getIn(['project', 'plugins', 0])).toBe(galleryPluginUrl('me/engine', 'v1'));
    expect(myst.getIn(['project', 'title'])).toBe('J');
  });

  it('--external --no-site: neither the site files nor Pages', async () => {
    const { prov, calls } = fakeProv();
    const seedDirs: string[] = [];
    const out = await cmdBootstrapJournal(
      {
        repo: 'me/config',
        tier: 'external',
        name: 'J',
        edition: 'ed-2026',
        engineVersion: 'v1',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        site: false,
        secrets: {},
      },
      journalDeps(prov, seedDirs),
    );
    expect(calls.enablePages ?? []).toHaveLength(0);
    expect(out.result.site_url).toBeUndefined();
    const seed = seedDirs[0]!;
    expect(existsSync(join(seed, 'journal.yml'))).toBe(true);
    expect(existsSync(join(seed, 'myst.yml'))).toBe(false);
    expect(existsSync(join(seed, '.github'))).toBe(false);
  });

  it('--external re-run does not re-enable Pages (GET-then-act)', async () => {
    const { prov, calls } = fakeProv({
      repos: new Set(['me/config']),
      branches: new Set(['me/config/main']),
      pages: new Set(['me/config']),
    });
    await cmdBootstrapJournal(
      {
        repo: 'me/config',
        tier: 'external',
        edition: 'ed-2026',
        engineVersion: 'v1',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        secrets: {},
      },
      deps(prov),
    );
    expect(calls.enablePages ?? []).toHaveLength(0);
  });

  it('--external re-run forces a private repo back to public', async () => {
    const { prov, calls } = fakeProv({
      repos: new Set(['me/config']),
      branches: new Set(['me/config/main']),
      visibility: 'private',
    });
    await cmdBootstrapJournal(
      {
        repo: 'me/config',
        tier: 'external',
        edition: 'ed-2026',
        engineVersion: 'v1',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        secrets: {},
      },
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
      {
        repo: 'me/journal',
        tier: 'co-located',
        name: 'J',
        edition: 'ed-2026',
        engineVersion: 'v9',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        requireChecks: true,
        secrets: {},
      },
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
    // ...and byte-unchanged by the site work: repo=journal's index is the deferred
    // `assemble()` work ([S7]), so this tier must NOT acquire a site.
    expect(existsSync(join(seed, 'pages/index.md'))).toBe(false);
    expect(existsSync(join(seed, '.github/workflows/site.yml'))).toBe(false);
    expect(existsSync(join(seed, 'package.json'))).toBe(false);
    const myst = parseDocument(readFileSync(join(seed, 'myst.yml'), 'utf8'));
    expect(myst.getIn(['project', 'options', 'oaktree-sapling', 'version'])).toBe('v9'); // the PAPER starter
  });

  it('a defaulted --edition is DECLARED, and names the file it will write', async () => {
    // The journal path may default the edition (unlike a paper: the same value names the
    // editions/<id>.yml this very run writes, so it is self-consistent), but the tenant is
    // told, because every paper will have to spell that id back.
    const { prov } = fakeProv();
    const seedDirs: string[] = [];
    const plans: string[][] = [];
    const d = journalDeps(prov, seedDirs);
    d.confirm = async (plan) => {
      plans.push(plan);
      return true;
    };
    await cmdBootstrapJournal(
      {
        repo: 'me/config',
        tier: 'external',
        name: 'J',
        engineVersion: 'v1',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        requireChecks: true,
        secrets: {},
        resolved: { engineVersionFrom: 'flag', engineRepoFrom: 'default' },
      },
      d,
    );
    const plan = plans[0]!.join('\n');
    expect(plan).toMatch(/edition        : edition \(placeholder; no --edition given\)/);
    expect(plan).toContain('editions/edition.yml');
    expect(existsSync(join(seedDirs[0]!, 'editions/edition.yml'))).toBe(true);
  });

  it('the plan does NOT claim a review owner an external journal never uses', async () => {
    // An external journal repo gets no CODEOWNERS and no team grant. Declaring a value we
    // do not honour is the same failure as hiding one we do.
    const { prov } = fakeProv();
    const plans: string[][] = [];
    const ext = journalDeps(prov, []);
    ext.confirm = async (plan) => {
      plans.push(plan);
      return false;
    };
    await cmdBootstrapJournal(
      {
        repo: 'me/config',
        tier: 'external',
        name: 'J',
        edition: 'ed',
        engineVersion: 'v1',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        requireChecks: true,
        secrets: {},
      },
      ext,
    );
    expect(plans[0]!.join('\n')).not.toContain('review owner');

    // ...but the co-located tier DOES write CODEOWNERS, so there it must be declared.
    const colo = journalDeps(fakeProv().prov, []);
    colo.confirm = async (plan) => {
      plans.push(plan);
      return false;
    };
    await cmdBootstrapJournal(
      {
        repo: 'me/journal',
        tier: 'co-located',
        name: 'J',
        edition: 'ed',
        engineVersion: 'v1',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        requireChecks: true,
        secrets: {},
      },
      colo,
    );
    expect(plans[1]!.join('\n')).toContain('review owner   : @alice');
  });

  it('--co-located --no-site is a usage ERROR, not a silent no-op', async () => {
    const { prov } = fakeProv();
    const out = await cmdBootstrapJournal(
      {
        repo: 'me/journal',
        tier: 'co-located',
        site: false,
        name: 'J',
        edition: 'ed',
        engineVersion: 'v9',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        requireChecks: true,
        secrets: {},
      },
      journalDeps(prov, []),
    );
    // The tier never stamps a site, so a flag reading "turn the site off" must not look
    // like it did something. Fail with the reason instead.
    expect(out.exitCode).toBe(2);
    expect(out.result.status).toBe('error');
    expect(String(out.result.error)).toContain('--external');
  });
});

describe('buildReviewTree drops author files under editor-controlled paths ([R121])', () => {
  it('drops an author .github path that main does not have', () => {
    // The existing fixture gives main a SUPERSET of the author's editor-controlled paths, so the
    // second loop's overwrite masks a missing filter. This is the author-only case.
    const tree = buildReviewTree(
      { 'index.md': 'a', '.github/workflows/evil.yml': 'on: push' },
      { '.github/workflows/ci.yml': 'frozen' },
    );
    expect(Object.keys(tree).sort()).toEqual(['.github/workflows/ci.yml', 'index.md']);
  });
});

/* --------------------------------------------------------------------------
 * A failed step is recorded, not thrown ([R125])
 * ------------------------------------------------------------------------ */

describe('a failing provisioning step ([R125])', () => {
  it('a settings failure is recorded, the other settings still run, and the run reports incomplete', async () => {
    // A 403 at the first ruleset used to discard the actions map and print a stack, leaving
    // a repo whose remaining settings were never attempted.
    const { prov, calls } = fakeProv();
    prov.createRuleset = () => {
      throw new Error('gh api failed (exit 1): 403 rulesets are not available on private repos');
    };
    const out = await cmdBootstrapPaper(paperInput(), deps(prov));
    expect(out.exitCode).toBe(1);
    expect(out.result.status).toBe('incomplete');
    const actions = out.result.actions as Record<string, string>;
    expect(actions.repo).toBe('created');
    expect(actions.main).toBe('seeded');
    expect(actions.protect_main).toMatch(/^failed: .*403/);
    expect(actions.v_tags).toMatch(/^failed: /);
    // Independent steps are all attempted: the whole picture, not the first exception.
    expect(actions.pages).toBe('enabled');
    expect(calls.enablePages).toHaveLength(1);
    expect(calls.createLabel).toHaveLength(2);
    expect((out.result.failed as string[]).join('\n')).toContain('protect_main');
    const runbook = (out.result.runbook as string[]).join('\n');
    expect(runbook).toContain('protect_main');
    expect(runbook).toContain('re-run');
  });

  it('a repo that cannot be created stops the run, but in the same envelope, not a stack', async () => {
    const { prov, calls } = fakeProv();
    prov.createRepo = () => {
      throw new Error('gh repo create failed (exit 1): 403 name already taken');
    };
    const out = await cmdBootstrapPaper(paperInput(), deps(prov));
    expect(out.exitCode).toBe(1);
    expect(out.result.status).toBe('incomplete');
    expect((out.result.actions as Record<string, string>).repo).toMatch(/^failed: /);
    // Nothing downstream can act on a repo that does not exist.
    expect(calls.seedBranch).toHaveLength(0);
    expect(calls.createRuleset).toHaveLength(0);
  });

  it('a seed failure skips the ingest chain, but the settings are still provisioned', async () => {
    const { prov, calls } = fakeProv();
    prov.seedBranch = () => {
      throw new Error('git push failed (exit 1): remote hung up');
    };
    const out = await cmdBootstrapPaper(paperInput({ from: 'https://github.com/a/b' }), deps(prov));
    expect(out.result.status).toBe('incomplete');
    // No main means no base to restore the frozen .github/ from and no PR base.
    expect(calls.ingestReviewBranch).toHaveLength(0);
    expect(calls.openPr).toHaveLength(0);
    expect(calls.createRuleset).toHaveLength(2);
    expect((out.result.actions as Record<string, string>).main).toMatch(/^failed: /);
  });

  it('a secret gh refuses lands in the by-hand list; the others are still set', async () => {
    const { prov } = fakeProv();
    const setCalls: string[] = [];
    prov.setSecret = (_r, name) => {
      setCalls.push(name);
      if (name === 'ZENODO_TOKEN')
        throw new Error('gh secret set failed (exit 1): resource not accessible');
    };
    const out = await cmdBootstrapPaper(
      paperInput({ secrets: { zenodoToken: 'zt', cfToken: 'ct' } }),
      deps(prov),
    );
    expect(setCalls).toEqual(['ZENODO_TOKEN', 'CLOUDFLARE_API_TOKEN']); // the loop carried on
    expect(out.result.secrets_set).toEqual(['CLOUDFLARE_API_TOKEN']);
    // The BY-HAND list itself, parsed: the step-failure line names the secret too, and
    // ZENODO_TOKEN is a substring of ZENODO_TOKEN_SANDBOX, so both looser assertions pass
    // with the refused secret missing from this list.
    const byHand = (out.result.runbook as string[]).find((l) =>
      l.includes('settings/secrets/actions'),
    );
    const byHandNames = byHand!.split(' : ')[1]!.split('.')[0]!.split(', ');
    expect(byHandNames).toContain('ZENODO_TOKEN');
    expect(byHandNames).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(out.result.status).toBe('incomplete');
  });

  it('the external journal tier reports a failed Pages step the same way', async () => {
    const { prov } = fakeProv();
    prov.enablePages = () => {
      throw new Error('gh api failed (exit 1): 403');
    };
    const out = await cmdBootstrapJournal(
      {
        repo: 'me/config',
        tier: 'external',
        name: 'J',
        edition: 'ed-2026',
        engineVersion: 'v1',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        secrets: {},
      },
      deps(prov),
    );
    expect(out.exitCode).toBe(1);
    expect(out.result.status).toBe('incomplete');
    expect((out.result.actions as Record<string, string>).pages).toMatch(/^failed: /);
    expect(out.result.site_url).toBeTruthy();
    expect((out.result.runbook as string[]).join('\n')).toContain("'pages'");
  });

  it('the co-located journal tier: a settings failure still seeds main and reports incomplete', async () => {
    const { prov, calls } = fakeProv();
    prov.createRuleset = () => {
      throw new Error('gh api failed (exit 1): 403');
    };
    const out = await cmdBootstrapJournal(
      {
        repo: 'me/journal',
        tier: 'co-located',
        name: 'J',
        edition: 'ed-2026',
        engineVersion: 'v1',
        engineRepo: 'me/engine',
        authedUser: 'alice',
        requireChecks: true,
        secrets: {},
      },
      deps(prov),
    );
    expect(calls.seedBranch).toHaveLength(1);
    expect(out.result.status).toBe('incomplete');
    expect((out.result.actions as Record<string, string>).protect_main).toMatch(/^failed: /);
  });

  it('an existing zenodo-publish environment is left alone when there is no reviewer to add ([R127])', async () => {
    // The PUT carries the whole environment, so re-PUTting it to add nobody cleared any
    // field a tenant set by hand; the plan invites re-running.
    const { prov, calls } = fakeProv({
      ownerType: 'Organization',
      environments: new Set(['org/paper/zenodo-publish']),
    });
    const out = await cmdBootstrapPaper(
      paperInput({ repo: 'org/paper', owner: '@org' }),
      deps(prov),
    );
    expect(calls.upsertEnvironment).toHaveLength(0);
    expect((out.result.actions as Record<string, string>).zenodo_reviewers).toBe('none');
    expect((out.result.runbook as string[]).join('\n')).toContain('settings/environments');
    expect(out.result.status).toBe('ok'); // no reviewer is a runbook item, not a failure
  });

  it('--private warns in the plan that the settings steps need a paid plan ([R127])', async () => {
    const { prov } = fakeProv();
    const plans: string[][] = [];
    const d = deps(prov);
    d.confirm = async (plan) => {
      plans.push(plan);
      return false;
    };
    await cmdBootstrapPaper(paperInput({ private: true }), d);
    const plan = plans[0]!.join('\n');
    expect(plan).toContain('403');
    expect(plan).toContain('rulesets or Pages');
    // The warning is tied to the flag, not printed on every plan.
    await cmdBootstrapPaper(paperInput(), d);
    expect(plans[1]!.join('\n')).not.toContain('free plan');
  });
});
