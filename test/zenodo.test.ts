/**
 * zenodo.test.ts — the deposit port's logic, exercised through a FAKE transport (no
 * network) and a FAKE git context (no git/gh). Proves the slice-3 corrections:
 * pagination past 100 ([R20]/[R35.1]), id-first identity ([R7]), tenant bytes from
 * journal.yml ([R19]), the `deposit/` folder + collision guard ([R28]), and the
 * prepare/publish envelope + [R29] env transition.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  ZenodoApi,
  buildMetadata,
  buildBundle,
  paperUrn,
  cmdPrepare,
  cmdPublish,
  BundleCollisionError,
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
    writeFileSync(outZip, 'PK-fake-zip');
  },
  async reviewPr() {
    return '42';
  },
};

const dep = (over: Partial<Deposition> = {}): Deposition => ({
  id: 1,
  conceptrecid: 1,
  submitted: false,
  links: { html: 'https://sandbox.zenodo.org/deposit/1', bucket: 'https://sandbox.zenodo.org/bucket/1' },
  metadata: {},
  ...over,
});

/* --------------------------------------------------------------------------
 * Pagination — [R20]/[R35.1]
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
    const api = new ZenodoApi(transport, 'https://sandbox.zenodo.org/api', 't');
    const got = await api.listMyDepositions();
    expect(got.length).toBe(250);
    expect(calls.length).toBe(3);
    expect(calls[0]!.opts.params).toMatchObject({ size: 100, page: 1 });
  });
});

/* --------------------------------------------------------------------------
 * Identity — id-first, github fallback ([R7])
 * ------------------------------------------------------------------------ */

describe('findDeposit', () => {
  const id = 'fixture-2026-sample-paper';
  const gh = 'https://github.com/o/r';
  const match = dep({
    id: 7,
    metadata: { related_identifiers: [{ identifier: paperUrn(id), relation: 'isVersionOf', scheme: 'urn' }] },
  });

  it('matches by id URN first (query keyed on the urn)', async () => {
    const { transport, calls } = fakeTransport(({ opts }) => {
      const q = String(opts.params?.q ?? '');
      return { json: q.includes(paperUrn(id)) ? [match] : [] };
    });
    const api = new ZenodoApi(transport, 'x', 't');
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
    const api = new ZenodoApi(transport, 'x', 't');
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
    const api = new ZenodoApi(transport, 'x', 't');
    const found = await api.findDeposit({ paperId: id, githubUrl: gh });
    expect(found?.id).toBe(11);
    expect(unfilteredCalls).toBe(1);
  });
});

/* --------------------------------------------------------------------------
 * Metadata — tenant bytes from journal.yml ([R19]) + id anchor ([R7])
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
    const md = buildMetadata({ project, paperId: project.id, githubUrl: 'https://github.com/o/r', zenodo: {} });
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
 * Bundle — deposit/ folder + collision guard ([R28])
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
    repo: 'o/r', commit_sha: 'x', tag: 'v1.0.0', site_url: undefined,
    concept_doi: 'd', version_doi: 'v', review_pr: '42', built_at: 'now',
  };

  it('adds the four fixed files plus deposit/ files verbatim', async () => {
    const root = paperWithDeposit({ 'data.csv': '1,2,3', 'extra.txt': 'hi' });
    const out = join(root, '_bundle');
    const files = (await buildBundle(out, join(root, 'paper.pdf'), root, prov, fakeGit)).map((p) => p.split('/').pop());
    expect(files).toEqual(
      ['data.csv', 'extra.txt', 'myst.yml', 'paper.pdf', 'publication-provenance.json', 'source.zip'].sort(),
    );
    const written = JSON.parse(readFileSync(join(out, 'publication-provenance.json'), 'utf8'));
    expect(written.review_pr).toBe('42');
  });

  it('rejects a deposit/ file that collides with an engine-reserved name', async () => {
    const root = paperWithDeposit({ 'paper.pdf': 'oops' });
    await expect(buildBundle(join(root, '_bundle'), join(root, 'paper.pdf'), root, prov, fakeGit)).rejects.toBeInstanceOf(
      BundleCollisionError,
    );
  });
});

/* --------------------------------------------------------------------------
 * prepare / publish — envelope, working-tree write, [R29]
 * ------------------------------------------------------------------------ */

function paperRepo(mystBody: string): string {
  const root = mkdtempSync(join(tmpdir(), 'oak-prep-'));
  writeFileSync(join(root, 'myst.yml'), mystBody);
  return join(root, 'myst.yml');
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
    const api = new ZenodoApi(transport, 'https://sandbox.zenodo.org/api', 't');
    const out = await cmdPrepare({ mystPath, repo: 'o/r', sandbox: true, api, instanceRoot: null });
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
    expect(md.related_identifiers.map((r: any) => r.identifier)).toContain(paperUrn('fixture-2026-sample-paper'));
  });

  it('refuses a same-env re-prepare but allows sandbox→prod replacement ([R29])', async () => {
    const withSandboxDoi = paperRepo(BARE_MYST + '  doi: 10.5072/zenodo.5\n');
    const noop = new ZenodoApi(fakeTransport(() => ({ json: [] })).transport, 'x', 't');

    // sandbox prepare over a committed sandbox DOI → refuse (same env)
    const same = await cmdPrepare({ mystPath: withSandboxDoi, repo: 'o/r', sandbox: true, api: noop, instanceRoot: null });
    expect(same.exitCode).toBe(2);

    // prod prepare over a committed sandbox DOI → allowed (mints a fresh prod concept)
    const prodPath = paperRepo(BARE_MYST + '  doi: 10.5072/zenodo.5\n');
    const { transport } = fakeTransport(({ method }) => (method === 'POST' ? { json: dep({ id: 8, conceptrecid: 8 }) } : { json: [] }));
    const prodApi = new ZenodoApi(transport, 'https://zenodo.org/api', 't');
    const up = await cmdPrepare({ mystPath: prodPath, repo: 'o/r', sandbox: false, api: prodApi, instanceRoot: null });
    expect(up.exitCode).toBe(0);
    expect(up.result.concept_doi).toBe('10.5281/zenodo.8');
  });

  it('forbids prod→sandbox downgrade ([R29])', async () => {
    const prodDoi = paperRepo(BARE_MYST + '  doi: 10.5281/zenodo.5\n');
    const noop = new ZenodoApi(fakeTransport(() => ({ json: [] })).transport, 'x', 't');
    const out = await cmdPrepare({ mystPath: prodDoi, repo: 'o/r', sandbox: true, api: noop, instanceRoot: null });
    expect(out.exitCode).toBe(2);
    expect(String(out.result.message)).toContain('downgrade');
  });
});

describe('cmdPublish', () => {
  it('populates the reserved draft: metadata overwrite + all bundle files uploaded', async () => {
    const mystPath = paperRepo(BARE_MYST + '  doi: 10.5072/zenodo.5\n  github: https://github.com/o/r\n');
    writeFileSync(mystPath.replace('myst.yml', 'paper.pdf'), '%PDF');
    const uploaded: string[] = [];
    const { transport } = fakeTransport((r) => {
      if (r.method === 'GET' && r.url.includes('/deposit/depositions/')) {
        return { json: dep({ id: 5, conceptrecid: 5, submitted: false }) };
      }
      if (r.method === 'GET') return { json: [dep({ id: 5, conceptrecid: 5, created: '2026-01-01' })] }; // list
      if (r.method === 'PUT' && r.url.includes('/bucket/')) {
        uploaded.push(r.url.split('/').pop()!);
        return { json: {} };
      }
      if (r.method === 'PUT') return { json: dep({ id: 5, conceptrecid: 5 }) }; // update metadata
      return { json: {} };
    });
    const api = new ZenodoApi(transport, 'https://sandbox.zenodo.org/api', 't');
    const out = await cmdPublish({
      mystPath,
      pdf: mystPath.replace('myst.yml', 'paper.pdf'),
      tag: 'v1.0.0',
      sandbox: true,
      bundleOut: mystPath.replace('myst.yml', '_bundle'),
      api,
      git: fakeGit,
      instanceRoot: null,
    });
    expect(out.exitCode).toBe(0);
    expect(out.result.version_doi).toBe('10.5072/zenodo.5');
    expect(uploaded.sort()).toEqual(['myst.yml', 'paper.pdf', 'publication-provenance.json', 'source.zip']);
  });

  it('errors when --sandbox disagrees with the committed DOI prefix', async () => {
    const mystPath = paperRepo(BARE_MYST + '  doi: 10.5072/zenodo.5\n  github: https://github.com/o/r\n');
    writeFileSync(mystPath.replace('myst.yml', 'paper.pdf'), '%PDF');
    const noop = new ZenodoApi(fakeTransport(() => ({ json: {} })).transport, 'x', 't');
    const out = await cmdPublish({
      mystPath, pdf: mystPath.replace('myst.yml', 'paper.pdf'), tag: 'v1.0.0',
      sandbox: false, bundleOut: '/tmp/x', api: noop, git: fakeGit, instanceRoot: null,
    });
    expect(out.exitCode).toBe(2);
  });
});
