import { describe, it, expect } from 'vitest';
import { mkdtempSync, copyFileSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { runBuild, runStart, type MystEdge } from '../src/build.js';
import { UserError } from '../src/messages.js';
import { DERIVED_CONFIG_FILE } from '../src/yaml-io.js';
import type { ResolvedProject } from '../src/compose.js';
import { typstTemplateUrl, themeZipUrl } from '../src/assets.js';
import { TYPST_OUTPUT } from '../src/compose.js';

const fixturePaper = fileURLToPath(new URL('./fixture-paper/myst.yml', import.meta.url));

/** A copy of the fixture paper in a temp dir so the two-pass writes don't mutate it. */
function tmpPaper(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oak-build-'));
  copyFileSync(fixturePaper, join(dir, 'myst.yml'));
  writeFileSync(join(dir, 'index.md'), '# Fixture\n');
  return dir;
}

/** Fake edge: loadProject returns what loadConfig WOULD return post-extends (typst export
 *  with articles from the edition, youtube sibling), and records the build call. */
function fakeEdge(): { edge: MystEdge; calls: string[] } {
  const calls: string[] = [];
  const resolved: ResolvedProject = {
    id: 'fixture-2026-sample-paper',
    title: 'A Fixture Paper',
    options: {
      youtube: 'https://youtu.be/x',
      'oaktree-sapling': { version: 'v0.3.0', edition: 'fixture-edition' },
    },
    exports: [
      { id: 'typst-pdf', format: 'typst', articles: [{ file: 'index.md', level: 0 }] },
    ],
  };
  return {
    calls,
    edge: {
      async loadProject(_dir, configFile) {
        calls.push(`load:${configFile}`);
        return resolved;
      },
      async build(_dir, opts, configFile) {
        calls.push(`build:${opts.all}:${opts.html}:${configFile}`);
      },
      async start(dir, opts, configFile) {
        calls.push(`start:${dir}:${JSON.stringify(opts)}:${configFile}`);
      },
    },
  };
}

describe('runBuild: the two-pass orchestrator ([R52])', () => {
  it('injects extends, then writes the engine override to the OWN config, then builds', async () => {
    const paperRoot = tmpPaper();
    const { edge, calls } = fakeEdge();

    const res = await runBuild({
      paperRoot,
      engineRoot: '.engine',
      instanceRoot: '.instance',
      engineRepo: 'open-scholar-nexus/oaktree-sapling',
      baseUrl: '/fixture-sample-paper',
      edge,
    });

    // order: resolve (pass 1) BEFORE build (pass 2)
    // both passes are pointed at the DERIVED config, never the author's ([R71])
    expect(calls).toEqual([
      `load:${DERIVED_CONFIG_FILE}`,
      `build:true:true:${DERIVED_CONFIG_FILE}`,
    ]);

    const doc = parseDocument(readFileSync(join(paperRoot, DERIVED_CONFIG_FILE), 'utf8'));
    // extends chain written in pass 1
    expect(doc.getIn(['extends', 0])).toBe('.engine/paper-base.yml');
    expect(doc.getIn(['extends', 1])).toBe('.instance/editions/fixture-edition.yml');
    expect(doc.getIn(['extends', 2])).toBe('.instance/brand/brand.yml');
    // complete typst entry on own config (release URL, articles carried)
    expect(doc.getIn(['project', 'exports', 0, 'template'])).toBe(
      typstTemplateUrl('open-scholar-nexus/oaktree-sapling', 'v0.3.0'),
    );
    expect(doc.getIn(['project', 'exports', 0, 'articles', 0, 'file'])).toBe('index.md');
    // engine also owns `output`: pinned so the artifact path never depends on the derived
    // config's filename (myst would otherwise derive it from the declaring file)
    expect(doc.getIn(['project', 'exports', 0, 'output'])).toBe(TYPST_OUTPUT);
    // theme override + sibling option preserved. NB the author's ORIGINAL youtube
    // survives: the override pass never touches options, and loadConfig's resolved
    // value ('…/x') is never written back to the working tree (finding 3).
    expect(doc.getIn(['site', 'template'])).toBe(themeZipUrl());
    expect(doc.getIn(['project', 'options', 'youtube'])).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );

    expect(res.resolvedProject.id).toBe('fixture-2026-sample-paper');
  });

  it('honors assetOverrides (local typst template, omitted site template)', async () => {
    const paperRoot = tmpPaper();
    const { edge } = fakeEdge();
    await runBuild({
      paperRoot,
      engineRoot: '.engine',
      instanceRoot: '.instance',
      engineRepo: 'x/y',
      baseUrl: '',
      assetOverrides: { typstTemplate: '/local/typst', siteTemplate: null },
      edge,
    });
    const doc = parseDocument(readFileSync(join(paperRoot, DERIVED_CONFIG_FILE), 'utf8'));
    expect(doc.getIn(['project', 'exports', 0, 'template'])).toBe('/local/typst');
    expect(doc.getIn(['site', 'template'])).toBeUndefined(); // omitted → myst default theme
  });

  it("picks up the journal's typst_template and absolutizes it ([R76])", async () => {
    const paperRoot = tmpPaper();
    const instanceRoot = mkdtempSync(join(tmpdir(), 'oak-instance-'));
    writeFileSync(join(instanceRoot, 'journal.yml'), 'name: J\ntypst_template: ./typst-template\n');

    const { edge } = fakeEdge();
    const res = await runBuild({
      paperRoot,
      engineRoot: '.engine',
      instanceRoot,
      engineRepo: 'x/y',
      baseUrl: '',
      // the engine's checkout template is present, and must LOSE to the journal's
      assetOverrides: { engineTypstTemplate: '/engine/templates/typst' },
      edge,
    });

    const doc = parseDocument(readFileSync(join(paperRoot, DERIVED_CONFIG_FILE), 'utf8'));
    expect(doc.getIn(['project', 'exports', 0, 'template'])).toBe(
      join(instanceRoot, 'typst-template'),
    );
    // nothing was overridden, so no override warning
    expect(res.warnings.join(' ')).not.toMatch(/overrides the journal/);
  });

  it('NEVER writes the author myst.yml: it is byte-identical after a build ([R71])', async () => {
    const paperRoot = tmpPaper();
    const authorPath = join(paperRoot, 'myst.yml');
    const before = readFileSync(authorPath); // raw bytes, not a yaml round-trip

    const { edge } = fakeEdge();
    await runBuild({
      paperRoot,
      engineRoot: '.engine',
      instanceRoot: '.instance',
      engineRepo: 'x/y',
      baseUrl: '/p',
      edge,
    });

    expect(readFileSync(authorPath).equals(before)).toBe(true);
    // and the engine's work landed next to it instead
    expect(existsSync(join(paperRoot, DERIVED_CONFIG_FILE))).toBe(true);
  });

  it('derived config is regenerated from the author config, not accumulated ([R71])', async () => {
    const paperRoot = tmpPaper();
    const run = () =>
      runBuild({
        paperRoot,
        engineRoot: '.engine',
        instanceRoot: '.instance',
        engineRepo: 'x/y',
        baseUrl: '/p',
        edge: fakeEdge().edge,
      });

    await run();
    const first = readFileSync(join(paperRoot, DERIVED_CONFIG_FILE), 'utf8');
    await run();
    const second = readFileSync(join(paperRoot, DERIVED_CONFIG_FILE), 'utf8');

    // Idempotent: pass 1 always re-reads the pristine author config, so a second build
    // cannot compound injections (the old model re-read its own output).
    expect(second).toBe(first);
    expect(first).toContain('GENERATED by `oak build`');
  });
});

describe('a missing engine coordinate is a SENTENCE, not a stack', () => {
  it('names the file and the line to put back, as a UserError', async () => {
    // The UX-test crash: the coordinate read threw a bare Error, which reached the top-level
    // handler and printed five bundle frames at a tenant.
    const paperRoot = tmpPaper();
    const authorPath = join(paperRoot, 'myst.yml');
    writeFileSync(
      authorPath,
      readFileSync(authorPath, 'utf8').replace(/\n\s*version: .*/, ''),
    );

    const err = await runBuild({
      paperRoot,
      engineRoot: '.engine',
      instanceRoot: '.instance',
      engineRepo: 'x/y',
      baseUrl: '',
      edge: fakeEdge().edge,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toContain(authorPath); // the file to edit
    expect(err.message).toContain('project.options.oaktree-sapling'); // where in it
    expect(err.message).toContain('oak upgrade'); // and what changes it for you
  });
});

describe('runStart: compose, then hand off to myst', () => {
  it('composes the SAME derived config as a build and points the server at it', async () => {
    const paperRoot = tmpPaper();
    const { edge, calls } = fakeEdge();

    await runStart({
      paperRoot,
      engineRoot: '.engine',
      instanceRoot: '.instance',
      engineRepo: 'x/y',
      baseUrl: '',
      startOpts: { port: 3210 },
      edge,
    });

    // Pass 1 loaded the derived config, and the handoff named it too: what the author previews
    // is what CI builds, which is the whole reason `oak start` exists rather than `myst start`.
    expect(calls).toEqual([
      `load:${DERIVED_CONFIG_FILE}`,
      `start:${paperRoot}:{"port":3210}:${DERIVED_CONFIG_FILE}`,
    ]);
    // No build ran: the server does its own.
    expect(calls.some((c) => c.startsWith('build:'))).toBe(false);

    const doc = parseDocument(readFileSync(join(paperRoot, DERIVED_CONFIG_FILE), 'utf8'));
    expect(doc.getIn(['extends', 0])).toBe('.engine/paper-base.yml');
    expect(doc.getIn(['project', 'exports', 0, 'output'])).toBe(TYPST_OUTPUT);
  });

  it('does NOT gate a preview on Layer-A findings the way a build does', async () => {
    // A placeholder id is exactly what a fresh repo has, and it must not stand between an
    // author and looking at their draft. (index.md is absent here; the structural class that
    // DOES block `oak build`.)
    const paperRoot = mkdtempSync(join(tmpdir(), 'oak-start-'));
    copyFileSync(fixturePaper, join(paperRoot, 'myst.yml'));
    const { edge, calls } = fakeEdge();

    await runStart({
      paperRoot,
      engineRoot: '.engine',
      instanceRoot: '.instance',
      engineRepo: 'x/y',
      baseUrl: '',
      edge,
    });

    expect(calls.some((c) => c.startsWith('start:'))).toBe(true);
  });
});
