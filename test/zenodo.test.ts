/**
 * zenodo.test.ts: the deposit port's logic, exercised through a FAKE transport (no
 * network) and a FAKE git context (no git/gh). Proves the slice-3 corrections:
 * pagination past 100 ([R20]/[R35.1]), id-first identity ([R7]), tenant bytes from
 * journal.yml ([R19]), the `deposit/` folder + collision guard ([R28]), and the
 * prepare/publish envelope + [R29] env transition.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { parseDocument } from 'yaml';
import {
  ZenodoApi,
  buildMetadata,
  buildBundle,
  paperUrn,
  cmdPrepare,
  cmdPublish,
  BundleCollisionError,
  assertBundlePreconditions,
  TemplateArchiveError,
  RESERVED_BUNDLE_NAMES,
  EngineArchiveError,
  ZENODO_PROD,
  ZENODO_SANDBOX,
  readStampedTemplate,
  resolveTemplateDir,
  type ZenodoTransport,
  type TransportResponse,
  type GitContext,
  type Deposition,
} from '../src/zenodo.js';

/* --------------------------------------------------------------------------
 * Fakes
 * ------------------------------------------------------------------------ */

interface Recorded {
  method: string;
  url: string;
  opts: Parameters<ZenodoTransport['request']>[2];
}

/** A fake transport driven by a handler; records every call. */
function fakeTransport(handler: (r: Recorded) => { status?: number; json: unknown }): {
  transport: ZenodoTransport;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const transport: ZenodoTransport = {
    async request(method, url, opts): Promise<TransportResponse> {
      const rec = { method, url, opts };
      calls.push(rec);
      const { status = 200, json } = handler(rec);
      const text = JSON.stringify(json);
      return { ok: status >= 200 && status < 300, status, text, json: () => json };
    },
  };
  return { transport, calls };
}

const fakeGit: GitContext = {
  async headSha() {
    return 'deadbeef';
  },
  async gitArchive(_root, outZip) {
    // A real zip carrying what an engine release ref commits, so `engine.zip` reads as one.
    const zip = new AdmZip();
    zip.addFile('dist/cli.cjs', Buffer.from('// bundle'));
    zip.addFile('bin/typst', Buffer.from('typst'));
    zip.writeZip(outZip);
  },
  async reviewPr() {
    return '42';
  },
};

const dep = (over: Partial<Deposition> = {}): Deposition => ({
  id: 1,
  conceptrecid: 1,
  submitted: false,
  links: {
    html: 'https://sandbox.zenodo.org/deposit/1',
    bucket: 'https://sandbox.zenodo.org/bucket/1',
  },
  metadata: {},
  ...over,
});

/* --------------------------------------------------------------------------
 * Pagination: [R20]/[R35.1]
 * ------------------------------------------------------------------------ */

describe('listMyDepositions pagination', () => {
  it('walks pages until a short page (past the 100 cap)', async () => {
    // 250 records: full pages of 100, 100, then a short 50 → three requests.
    const all = Array.from({ length: 250 }, (_, i) => dep({ id: i + 1 }));
    const { transport, calls } = fakeTransport(({ opts }) => {
      const page = Number(opts.params?.page);
      const size = Number(opts.params?.size);
      return { json: all.slice((page - 1) * size, page * size) };
    });
    const api = new ZenodoApi(transport, true, 't');
    const got = await api.listMyDepositions();
    expect(got.length).toBe(250);
    expect(calls.length).toBe(3);
    expect(calls[0]!.opts.params).toMatchObject({ size: 100, page: 1 });
  });
});

/* --------------------------------------------------------------------------
 * Identity: id-first, github fallback ([R7])
 * ------------------------------------------------------------------------ */

describe('findDeposit', () => {
  const id = 'fixture-2026-sample-paper';
  const gh = 'https://github.com/o/r';
  const match = dep({
    id: 7,
    metadata: {
      related_identifiers: [{ identifier: paperUrn(id), relation: 'isVersionOf', scheme: 'urn' }],
    },
  });

  it('matches by id URN first (query keyed on the urn)', async () => {
    const { transport, calls } = fakeTransport(({ opts }) => {
      const q = String(opts.params?.q ?? '');
      return { json: q.includes(paperUrn(id)) ? [match] : [] };
    });
    const api = new ZenodoApi(transport, true, 't');
    const found = await api.findDeposit({ paperId: id, githubUrl: gh });
    expect(found?.id).toBe(7);
    // the very first query is the id URN, before github
    expect(String(calls[0]!.opts.params?.q)).toContain(paperUrn(id));
  });

  it('falls back to github URL when the id has no hit', async () => {
    const byUrl = dep({ id: 9, metadata: { related_identifiers: [{ identifier: gh }] } });
    const { transport } = fakeTransport(({ opts }) => {
      const q = String(opts.params?.q ?? '');
      return { json: q.includes(gh) ? [byUrl] : [] };
    });
    const api = new ZenodoApi(transport, true, 't');
    const found = await api.findDeposit({ paperId: id, githubUrl: gh });
    expect(found?.id).toBe(9);
  });

  it('does a full scan only when both targeted queries are empty', async () => {
    const buried = dep({ id: 11, metadata: { related_identifiers: [{ identifier: gh }] } });
    let unfilteredCalls = 0;
    const { transport } = fakeTransport(({ opts }) => {
      if (opts.params?.q === undefined) {
        unfilteredCalls++;
        return { json: [buried] };
      }
      return { json: [] }; // targeted queries find nothing (e.g. the search index lags)
    });
    const api = new ZenodoApi(transport, true, 't');
    const found = await api.findDeposit({ paperId: id, githubUrl: gh });
    expect(found?.id).toBe(11);
    expect(unfilteredCalls).toBe(1);
  });
});

/* --------------------------------------------------------------------------
 * Metadata: tenant bytes from journal.yml ([R19]) + id anchor ([R7])
 * ------------------------------------------------------------------------ */

describe('buildMetadata', () => {
  const project = {
    id: 'fixture-2026-sample-paper',
    title: 'A Paper',
    license: 'CC-BY-4.0',
    keywords: ['a', 'b'],
    authors: [
      { name: 'Ada', affiliations: ['Inst'], orcid: '0000-0002-1825-0097' },
      { name: 'Placeholder', orcid: '0000-0000-0000-0000' },
    ],
  };

  it('omits community + blurb for a fresh tenant, and keeps the github + id related ids', () => {
    const md = buildMetadata({
      project,
      paperId: project.id,
      githubUrl: 'https://github.com/o/r',
      zenodo: {},
    });
    expect(md.communities).toBeUndefined();
    // no tenant blurb → the description is just the repo/site lines, no ISP-style sentence
    expect(md.description).not.toContain('Program');
    const related = md.related_identifiers as Array<Record<string, string>>;
    expect(related.map((r) => r.identifier)).toContain(paperUrn(project.id));
    expect(related.map((r) => r.identifier)).toContain('https://github.com/o/r');
  });

  it('injects the tenant blurb + community when journal.yml supplies them', () => {
    const md = buildMetadata({
      project,
      paperId: project.id,
      githubUrl: 'https://github.com/o/r',
      zenodo: { community: 'neuromatch', description_blurb: 'Made by the Fixture Journal.' },
    });
    expect(md.communities).toEqual([{ identifier: 'neuromatch' }]);
    expect(md.description).toContain('Made by the Fixture Journal.');
  });

  it('drops placeholder/invalid ORCIDs but keeps valid ones', () => {
    const md = buildMetadata({ project, githubUrl: 'https://github.com/o/r', zenodo: {} });
    const creators = md.creators as Array<Record<string, string>>;
    expect(creators[0]!.orcid).toBe('0000-0002-1825-0097');
    expect(creators[1]!.orcid).toBeUndefined();
  });
});

/* --------------------------------------------------------------------------
 * Bundle: deposit/ folder + collision guard ([R28])
 * ------------------------------------------------------------------------ */

describe('buildBundle', () => {
  function paperWithDeposit(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'oak-bundle-'));
    writeFileSync(join(root, 'myst.yml'), 'project: {}');
    writeFileSync(join(root, 'paper.pdf'), '%PDF-fake');
    const dd = join(root, 'deposit');
    mkdirSync(dd);
    for (const [n, c] of Object.entries(files)) writeFileSync(join(dd, n), c);
    return root;
  }
  const prov = {
    repo: 'o/r',
    commit_sha: 'x',
    tag: 'v1.0.0',
    site_url: undefined,
    concept_doi: 'd',
    version_doi: 'v',
    review_pr: '42',
    built_at: 'now',
    platform: 'linux-x86_64',
    typst_version: '0.14.2',
  };

  it('adds the five fixed files (incl. engine.zip) plus deposit/ files verbatim', async () => {
    const root = paperWithDeposit({ 'data.csv': '1,2,3', 'extra.txt': 'hi' });
    const out = join(root, '_bundle');
    const files = (await buildBundle(out, join(root, 'paper.pdf'), root, root, prov, fakeGit)).map(
      (p) => p.split('/').pop(),
    );
    expect(files).toEqual(
      [
        'data.csv',
        'engine.zip',
        'extra.txt',
        'myst.yml',
        'paper.pdf',
        'publication-provenance.json',
        'source.zip',
      ].sort(),
    );
    const written = JSON.parse(readFileSync(join(out, 'publication-provenance.json'), 'utf8'));
    expect(written.review_pr).toBe('42');
  });

  it('rejects a deposit/ file that collides with an engine-reserved name', async () => {
    const root = paperWithDeposit({ 'paper.pdf': 'oops' });
    await expect(
      buildBundle(join(root, '_bundle'), join(root, 'paper.pdf'), root, root, prov, fakeGit),
    ).rejects.toBeInstanceOf(BundleCollisionError);
  });

  it('reserves template.zip against deposit/ collisions too', async () => {
    const root = paperWithDeposit({ 'template.zip': 'oops' });
    await expect(
      buildBundle(join(root, '_bundle'), join(root, 'paper.pdf'), root, root, prov, fakeGit),
    ).rejects.toBeInstanceOf(BundleCollisionError);
  });

  /* ---- the resolved template's bytes ([R76]/[R66]) ---------------------- */

  /** A paper root beside a SEPARATE engine checkout, so "is this template already inside
   *  engine.zip?" is a real question rather than an artifact of the test layout. */
  function paperAndEngine(): { paper: string; engine: string; tmp: string } {
    const tmp = mkdtempSync(join(tmpdir(), 'oak-tmpl-'));
    const paper = join(tmp, 'paper');
    const engine = join(tmp, 'engine');
    mkdirSync(paper);
    mkdirSync(join(engine, 'templates', 'typst'), { recursive: true });
    writeFileSync(join(engine, 'templates', 'typst', 'template.yml'), 'kind: typst');
    writeFileSync(join(paper, 'paper.pdf'), '%PDF-fake');
    writeFileSync(join(paper, 'myst.yml'), 'project: {}');
    return { paper, engine, tmp };
  }
  /** What `oak build` leaves behind: the derived config carrying compose's resolved value. */
  function stamp(paper: string, template: string): void {
    writeFileSync(
      join(paper, 'myst.oak.yml'),
      `project:\n  exports:\n  - id: typst-pdf\n    format: typst\n    template: ${template}\n`,
    );
  }
  const namesIn = (files: string[]) => files.map((p) => p.split('/').pop());

  it('adds no template.zip when the rendered template lives in the engine checkout', async () => {
    const { paper, engine } = paperAndEngine();
    stamp(paper, join(engine, 'templates', 'typst'));

    const files = await buildBundle(
      join(paper, '_bundle'),
      join(paper, 'paper.pdf'),
      paper,
      engine,
      prov,
      fakeGit,
    );
    expect(namesIn(files)).not.toContain('template.zip');
    expect(namesIn(files)).toEqual(RESERVED_BUNDLE_NAMES.slice().sort());
  });

  it('archives a TENANT/AUTHOR local template’s bytes as template.zip', async () => {
    const { paper, engine, tmp } = paperAndEngine();
    const tenant = join(tmp, 'instance', 'typst-template');
    mkdirSync(tenant, { recursive: true });
    writeFileSync(join(tenant, 'template.yml'), 'kind: typst');
    writeFileSync(join(tenant, 'template.typ'), '#let x = 1');
    stamp(paper, tenant);

    const out = join(paper, '_bundle');
    const files = await buildBundle(out, join(paper, 'paper.pdf'), paper, engine, prov, fakeGit);
    expect(namesIn(files)).toContain('template.zip');
    const entries = new AdmZip(join(out, 'template.zip')).getEntries().map((e) => e.entryName);
    expect(entries).toEqual(expect.arrayContaining(['template.yml', 'template.typ']));
  });

  it("archives an author's RELATIVE template, resolved against the paper root", async () => {
    // Caught by a real end-to-end run, not by construction: myst resolves an author's
    // `./my-template` against the build cwd (the paper root), but the deposit runs from
    // wherever `oak` was invoked: probing cwd here refused a perfectly valid deposit.
    const { paper, engine } = paperAndEngine();
    mkdirSync(join(paper, 'my-template'));
    writeFileSync(join(paper, 'my-template', 'template.yml'), 'kind: typst');
    stamp(paper, './my-template');

    const out = join(paper, '_bundle');
    const files = await buildBundle(out, join(paper, 'paper.pdf'), paper, engine, prov, fakeGit);
    expect(namesIn(files)).toContain('template.zip');
    expect(new AdmZip(join(out, 'template.zip')).getEntries().map((e) => e.entryName)).toContain(
      'template.yml',
    );
  });

  it('archives a REMOTE template from where myst materialized it', async () => {
    const { paper, engine } = paperAndEngine();
    const url = 'https://github.com/o/r/releases/download/v1.2.3/typst-template.zip';
    const materialized = join(
      paper,
      '_build',
      'templates',
      'typst',
      createHash('sha256').update(url).digest('hex'),
    );
    mkdirSync(materialized, { recursive: true });
    writeFileSync(join(materialized, 'template.yml'), 'kind: typst');
    stamp(paper, url);

    const out = join(paper, '_bundle');
    const files = await buildBundle(out, join(paper, 'paper.pdf'), paper, engine, prov, fakeGit);
    expect(namesIn(files)).toContain('template.zip');
    expect(new AdmZip(join(out, 'template.zip')).getEntries().map((e) => e.entryName)).toContain(
      'template.yml',
    );
  });

  it('REFUSES to deposit when a non-engine template’s bytes cannot be found', async () => {
    const { paper, engine } = paperAndEngine();
    stamp(paper, 'https://example.org/t.zip'); // never materialized; nothing was built here

    // A DOI'd PDF nobody can re-render is worse than a failed deposit.
    await expect(
      buildBundle(join(paper, '_bundle'), join(paper, 'paper.pdf'), paper, engine, prov, fakeGit),
    ).rejects.toBeInstanceOf(TemplateArchiveError);
  });
});

describe('readStampedTemplate / resolveTemplateDir ([R76])', () => {
  it('reads what the build actually rendered with (the derived config), not the author input', () => {
    const root = mkdtempSync(join(tmpdir(), 'oak-stamp-'));
    writeFileSync(
      join(root, 'myst.yml'),
      'project:\n  exports:\n  - id: typst-pdf\n    format: typst\n    template: ./author\n',
    );
    writeFileSync(
      join(root, 'myst.oak.yml'),
      'project:\n  exports:\n  - id: typst-pdf\n    format: typst\n    template: /resolved/by/compose\n',
    );
    expect(readStampedTemplate(root)).toBe('/resolved/by/compose');
  });

  it('falls back to the author config when nothing was built here', () => {
    const root = mkdtempSync(join(tmpdir(), 'oak-stamp-'));
    writeFileSync(
      join(root, 'myst.yml'),
      'project:\n  exports:\n  - id: typst-pdf\n    format: typst\n    template: ./author\n',
    );
    expect(readStampedTemplate(root)).toBe('./author');
  });

  it('is null when no typst export declares a template', () => {
    const root = mkdtempSync(join(tmpdir(), 'oak-stamp-'));
    writeFileSync(
      join(root, 'myst.yml'),
      'project:\n  exports:\n  - id: typst-pdf\n    format: typst\n',
    );
    expect(readStampedTemplate(root)).toBeNull();
  });

  describe('resolveTemplateDir mirrors myst-templates resolveInputs', () => {
    const paper = '/paper';
    it('uses a local directory in place', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oak-dir-'));
      writeFileSync(join(dir, 'template.yml'), 'kind: typst');
      expect(resolveTemplateDir(dir, paper)).toBe(dir);
    });

    it('is not shadowed by a same-named directory carrying no template.yml ([R107])', () => {
      // myst resolves `lapreprint-typst` from the registry when the local path is not a
      // template, so archiving the local bytes would archive what did NOT render the PDF.
      const root = mkdtempSync(join(tmpdir(), 'oak-shadow-'));
      mkdirSync(join(root, 'lapreprint-typst'));
      expect(resolveTemplateDir('lapreprint-typst', root)).toBe(
        join(root, '_build/templates/typst/myst/lapreprint-typst'),
      );
    });
    it('climbs to the directory when pointed at the template.yml', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oak-dir-'));
      writeFileSync(join(dir, 'template.yml'), 'kind: typst');
      expect(resolveTemplateDir(join(dir, 'template.yml'), paper)).toBe(dir);
    });
    it('hashes a URL into _build/templates/typst/<sha256>', () => {
      const url = 'https://example.org/t.zip';
      expect(resolveTemplateDir(url, paper)).toBe(
        join(paper, '_build', 'templates', 'typst', createHash('sha256').update(url).digest('hex')),
      );
    });
    it('expands the three name shapes', () => {
      const t = (n: string) => resolveTemplateDir(n, paper);
      expect(t('lapreprint-typst')).toBe(
        join(paper, '_build/templates/typst/myst/lapreprint-typst'),
      );
      expect(t('acme/mine')).toBe(join(paper, '_build/templates/typst/acme/mine'));
      expect(t('typst/acme/mine')).toBe(join(paper, '_build/templates/typst/acme/mine'));
    });
  });
});

/* --------------------------------------------------------------------------
 * prepare / publish: envelope, working-tree write, [R29]
 * ------------------------------------------------------------------------ */

function paperRepo(mystBody: string): string {
  const root = mkdtempSync(join(tmpdir(), 'oak-prep-'));
  writeFileSync(join(root, 'myst.yml'), mystBody);
  return join(root, 'myst.yml');
}

/** The myst HTML build's output, which is where the deposit description's abstract comes from. */
function withBuild(mystPath: string, abstract = 'The abstract.'): void {
  const dir = join(mystPath.replace('myst.yml', ''), '_build', 'site', 'content');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      frontmatter: {
        parts: { abstract: { mdast: { children: [{ type: 'text', value: abstract }] } } },
      },
    }),
  );
}

const BARE_MYST = `project:
  id: fixture-2026-sample-paper
  title: A Paper
  authors:
  - name: Ada
`;

describe('cmdPrepare', () => {
  it('creates a draft and stamps doi/github/date into the working-tree myst.yml ([R22])', async () => {
    const mystPath = paperRepo(BARE_MYST);
    const { transport, calls } = fakeTransport(({ method }) => {
      if (method === 'POST') return { json: dep({ id: 5, conceptrecid: 5 }) };
      return { json: [] }; // no existing deposit
    });
    const api = new ZenodoApi(transport, true, 't');
    const out = await cmdPrepare({ mystPath, repo: 'o/r', api, instanceRoot: null });
    expect(out.exitCode).toBe(0);
    expect(out.result.status).toBe('ok');
    expect(out.result.concept_doi).toBe('10.5072/zenodo.5');

    const doc = parseDocument(readFileSync(mystPath, 'utf8'));
    expect(doc.getIn(['project', 'doi'])).toBe('10.5072/zenodo.5');
    expect(doc.getIn(['project', 'github'])).toBe('https://github.com/o/r');
    expect(doc.getIn(['project', 'date'])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // POST carried prereserve + the id URN
    const post = calls.find((c) => c.method === 'POST')!;
    const md = (post.opts.json as any).metadata;
    expect(md.prereserve_doi).toBe(true);
    expect(md.related_identifiers.map((r: any) => r.identifier)).toContain(
      paperUrn('fixture-2026-sample-paper'),
    );
  });

  it('refuses a same-env re-prepare but allows sandbox→prod replacement ([R29])', async () => {
    const withSandboxDoi = paperRepo(BARE_MYST + '  doi: 10.5072/zenodo.5\n');
    const noop = new ZenodoApi(fakeTransport(() => ({ json: [] })).transport, true, 't');

    // sandbox prepare over a committed sandbox DOI → refuse (same env)
    const same = await cmdPrepare({
      mystPath: withSandboxDoi,
      repo: 'o/r',
      api: noop,
      instanceRoot: null,
    });
    expect(same.exitCode).toBe(2);

    // prod prepare over a committed sandbox DOI → allowed (mints a fresh prod concept)
    const prodPath = paperRepo(BARE_MYST + '  doi: 10.5072/zenodo.5\n');
    const { transport } = fakeTransport(({ method }) =>
      method === 'POST' ? { json: dep({ id: 8, conceptrecid: 8 }) } : { json: [] },
    );
    const prodApi = new ZenodoApi(transport, false, 't');
    const up = await cmdPrepare({
      mystPath: prodPath,
      repo: 'o/r',
      api: prodApi,
      instanceRoot: null,
    });
    expect(up.exitCode).toBe(0);
    expect(up.result.concept_doi).toBe('10.5281/zenodo.8');
  });

  it('forbids prod→sandbox downgrade ([R29])', async () => {
    const prodDoi = paperRepo(BARE_MYST + '  doi: 10.5281/zenodo.5\n');
    const noop = new ZenodoApi(fakeTransport(() => ({ json: [] })).transport, true, 't');
    const out = await cmdPrepare({
      mystPath: prodDoi,
      repo: 'o/r',
      api: noop,
      instanceRoot: null,
    });
    expect(out.exitCode).toBe(2);
    expect(String(out.result.message)).toContain('downgrade');
  });
});

describe('cmdPublish', () => {
  it('populates the reserved draft: metadata overwrite + all bundle files uploaded', async () => {
    const mystPath = paperRepo(
      BARE_MYST + '  doi: 10.5072/zenodo.5\n  github: https://github.com/o/r\n',
    );
    writeFileSync(mystPath.replace('myst.yml', 'paper.pdf'), '%PDF');
    withBuild(mystPath);
    const uploaded: string[] = [];
    const { transport } = fakeTransport((r) => {
      if (r.method === 'GET' && r.url.includes('/deposit/depositions/')) {
        return { json: dep({ id: 5, conceptrecid: 5, submitted: false }) };
      }
      if (r.method === 'GET')
        return { json: [dep({ id: 5, conceptrecid: 5, created: '2026-01-01' })] }; // list
      if (r.method === 'PUT' && r.url.includes('/bucket/')) {
        uploaded.push(r.url.split('/').pop()!);
        return { json: {} };
      }
      if (r.method === 'PUT') return { json: dep({ id: 5, conceptrecid: 5 }) }; // update metadata
      return { json: {} };
    });
    const api = new ZenodoApi(transport, true, 't');
    const out = await cmdPublish({
      mystPath,
      pdf: mystPath.replace('myst.yml', 'paper.pdf'),
      tag: 'v1.0.0',
      bundleOut: mystPath.replace('myst.yml', '_bundle'),
      api,
      git: fakeGit,
      instanceRoot: null,
      engineRoot: mystPath.replace('myst.yml', ''),
    });
    expect(out.exitCode).toBe(0);
    expect(out.result.version_doi).toBe('10.5072/zenodo.5');
    expect(uploaded.sort()).toEqual([
      'engine.zip',
      'myst.yml',
      'paper.pdf',
      'publication-provenance.json',
      'source.zip',
    ]);
  });

  it('errors when --sandbox disagrees with the committed DOI prefix', async () => {
    const mystPath = paperRepo(
      BARE_MYST + '  doi: 10.5072/zenodo.5\n  github: https://github.com/o/r\n',
    );
    writeFileSync(mystPath.replace('myst.yml', 'paper.pdf'), '%PDF');
    const noop = new ZenodoApi(fakeTransport(() => ({ json: {} })).transport, false, 't');
    const out = await cmdPublish({
      mystPath,
      pdf: mystPath.replace('myst.yml', 'paper.pdf'),
      tag: 'v1.0.0',
      bundleOut: '/tmp/x',
      api: noop,
      git: fakeGit,
      instanceRoot: null,
      engineRoot: mystPath.replace('myst.yml', ''),
    });
    expect(out.exitCode).toBe(2);
  });
});

const PROVENANCE = {
  repo: 'o/r',
  commit_sha: 'x',
  tag: 'v1.0.0',
  site_url: undefined,
  concept_doi: 'd',
  version_doi: 'v',
  review_pr: null,
  built_at: 'now',
  platform: 'linux-x86_64',
  typst_version: '0.14.2',
};

describe('deposit integrity ([R107])', () => {
  it('sends the whole metadata object to the draft at publish ([R22])', async () => {
    const mystPath = paperRepo(
      BARE_MYST + '  doi: 10.5072/zenodo.5\n  github: https://github.com/o/r\n',
    );
    writeFileSync(mystPath.replace('myst.yml', 'paper.pdf'), '%PDF');
    withBuild(mystPath, 'The abstract.');
    const metaPuts: Array<Record<string, unknown>> = [];
    const { transport } = fakeTransport((r) => {
      if (r.method === 'GET' && r.url.includes('/deposit/depositions/')) {
        return { json: dep({ id: 5, conceptrecid: 5, submitted: false }) };
      }
      if (r.method === 'GET') return { json: [dep({ id: 5, conceptrecid: 5 })] };
      if (r.method === 'PUT' && r.url.includes('/bucket/')) return { json: {} };
      if (r.method === 'PUT') {
        metaPuts.push((r.opts.json as { metadata: Record<string, unknown> }).metadata);
        return { json: dep({ id: 5, conceptrecid: 5 }) };
      }
      return { json: {} };
    });
    const out = await cmdPublish({
      mystPath,
      pdf: mystPath.replace('myst.yml', 'paper.pdf'),
      tag: 'v1.2.3',
      bundleOut: mystPath.replace('myst.yml', '_bundle'),
      api: new ZenodoApi(transport, true, 't'),
      git: fakeGit,
      instanceRoot: null,
      engineRoot: mystPath.replace('myst.yml', ''),
    });
    expect(out.exitCode).toBe(0);
    expect(metaPuts).toHaveLength(1);
    expect(metaPuts[0]!.title).toBe('A Paper');
    expect(metaPuts[0]!.version).toBe('1.2.3');
    expect(metaPuts[0]!.publication_date).toBeTruthy();
    expect(String(metaPuts[0]!.description)).toContain('The abstract.');
  });

  it('refuses to publish from a tree the build never ran in', async () => {
    const mystPath = paperRepo(
      BARE_MYST + '  doi: 10.5072/zenodo.5\n  github: https://github.com/o/r\n',
    );
    writeFileSync(mystPath.replace('myst.yml', 'paper.pdf'), '%PDF');
    const { transport, calls } = fakeTransport(() => ({ json: [] }));
    const out = await cmdPublish({
      mystPath,
      pdf: mystPath.replace('myst.yml', 'paper.pdf'),
      tag: 'v1.0.0',
      bundleOut: mystPath.replace('myst.yml', '_bundle'),
      api: new ZenodoApi(transport, true, 't'),
      git: fakeGit,
      instanceRoot: null,
      engineRoot: mystPath.replace('myst.yml', ''),
    });
    expect(out.exitCode).toBe(2);
    expect(String(out.result.message)).toContain('_build/site/content');
    expect(calls.length, 'the description downgrade is caught before any Zenodo write').toBe(0);
  });

  it('refuses an engine.zip that carries no engine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oak-hollow-'));
    writeFileSync(join(root, 'paper.pdf'), '%PDF');
    const hollow: GitContext = {
      ...fakeGit,
      async gitArchive(_r, outZip) {
        new AdmZip().writeZip(outZip); // what `git archive` produces off a non-release ref
      },
    };
    await expect(
      buildBundle(join(root, '_bundle'), join(root, 'paper.pdf'), root, root, PROVENANCE, hollow),
    ).rejects.toThrow(EngineArchiveError);
  });

  it('encodes an author-controlled filename into the upload path', async () => {
    const seen: string[] = [];
    const { transport } = fakeTransport((r) => {
      seen.push(r.url);
      return { json: {} };
    });
    const api = new ZenodoApi(transport, true, 't');
    await api.uploadFile('https://sandbox.zenodo.org/bucket/1', 'data?v2.csv', new Uint8Array());
    const url = new URL(seen[0]!);
    expect(url.pathname).toBe('/bucket/1/data%3Fv2.csv');
    expect(url.searchParams.size, 'nothing may ride into the token-bearing query string').toBe(0);
  });

  it('derives the API host from sandbox, so the two cannot disagree', () => {
    const t = fakeTransport(() => ({ json: {} })).transport;
    expect(new ZenodoApi(t, true, 'x').api).toBe(ZENODO_SANDBOX);
    expect(new ZenodoApi(t, false, 'x').api).toBe(ZENODO_PROD);
  });
});

describe('lookup and precondition regressions ([R100], [R101])', () => {
  const id = 'foo-bar';
  const gh = 'https://github.com/o/r';

  it('scans when a targeted query returns rows that do not MATCH', async () => {
    // A phrase match returns a LONGER urn for a query about a shorter one ([R100]).
    const nearMiss = dep({
      id: 1,
      metadata: { related_identifiers: [{ identifier: paperUrn('foo-bar-baz') }] },
    });
    const real = dep({ id: 2, metadata: { related_identifiers: [{ identifier: paperUrn(id) }] } });
    let unfiltered = 0;
    const { transport } = fakeTransport(({ opts }) => {
      const q = opts.params?.q;
      if (q === undefined) {
        unfiltered++;
        return { json: [nearMiss, real] };
      }
      // urn query phrase-matches the near miss; the github query misses (renamed repo, [R7]).
      return { json: String(q).includes(id) ? [nearMiss] : [] };
    });
    const api = new ZenodoApi(transport, true, 't');
    const found = await api.findDeposit({ paperId: id, githubUrl: gh });
    expect(found?.id, 'a near miss must not suppress the scan').toBe(2);
    expect(unfiltered).toBe(1);
  });

  it('judges the working tree before any Zenodo write', () => {
    const root = mkdtempSync(join(tmpdir(), 'oak-precond-'));
    mkdirSync(join(root, 'deposit'), { recursive: true });
    writeFileSync(join(root, 'deposit', 'paper.pdf'), 'x');
    expect(() => assertBundlePreconditions(root, root)).toThrow(BundleCollisionError);
  });

  it('reports a collision through the envelope, having sent nothing to Zenodo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oak-envelope-'));
    mkdirSync(join(root, 'deposit'), { recursive: true });
    writeFileSync(join(root, 'deposit', 'source.zip'), 'x');
    writeFileSync(join(root, 'paper.pdf'), 'x');
    writeFileSync(
      join(root, 'myst.yml'),
      'version: 1\nproject:\n  id: p\n  doi: 10.5072/zenodo.5\n  github: https://github.com/o/r\n',
    );
    const { transport, calls } = fakeTransport(() => ({ json: [] }));
    const out = await cmdPublish({
      mystPath: join(root, 'myst.yml'),
      pdf: join(root, 'paper.pdf'),
      tag: 'v1.0.0',
      siteUrl: 'https://s',
      bundleOut: join(root, '_bundle'),
      api: new ZenodoApi(transport, true, 't'),
      git: fakeGit,
      instanceRoot: null,
      engineRoot: root,
    });
    expect(out.result.status).toBe('error');
    expect(out.exitCode).toBe(2);
    expect(JSON.stringify(out.result)).toContain('source.zip');
    expect(calls.length, 'nothing may reach Zenodo before the tree is judged').toBe(0);
  });
});
