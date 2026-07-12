#!/usr/bin/env node
/**
 * cli.ts — the `oak` entry point (bundled to dist/cli.cjs per tag; CI calls it directly
 * via ci/run.sh). Verb surface maps the 7 current isp-actions-config workflows (impl §2).
 *
 * Implemented: `build` (slice 2). The rest are stubbed with their slice number. The myst
 * edge is imported lazily inside `build` so `oak` with no/other args stays light and the
 * dep only loads when actually building.
 */
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

// dist/cli.cjs is an esbuild CJS bundle ([R51]), so `__dirname` is the bundle's dir
// (engine/dist). `oak` is only ever run bundled — CI (ci/run.sh) and local both invoke
// dist/cli.cjs — so we don't need the ESM import.meta.url dance. @types/node declares
// __dirname globally, keeping tsc happy under NodeNext.
declare const __dirname: string;

type Verb =
  | 'build'
  | 'validate'
  | 'deploy-preview'
  | 'deposit'
  | 'release'
  | 'notify'
  | 'bootstrap'
  | 'upgrade';

const STUB_SLICE: Partial<Record<Verb, string>> = {
  validate: 'slice 4',
  'deploy-preview': 'slice 2 (shim)',
  deposit: 'slice 3',
  release: 'slice 3',
  notify: 'slice 2 (shim)',
  bootstrap: 'slice 5',
  upgrade: 'slice 5',
};

/** engineRoot = the dir holding paper-base.yml. When run as dist/cli.cjs it is one level
 *  up from the bundle; in dev (tsx/src) it is two up from src/. Detect by probing. */
function engineRoot(): string {
  for (const up of ['..', '.']) {
    const cand = resolve(__dirname, up);
    if (existsSync(join(cand, 'paper-base.yml'))) return cand;
  }
  return resolve(__dirname, '..');
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** engine_repo pin, for asset URLs; falls back to the interim home ([R56]; canonical
 *  open-scholar-nexus/oaktree-sapling later). Real repos carry pins.yml, so this is only
 *  a last resort. */
function readEngineRepo(paperRoot: string): string {
  const pins = join(paperRoot, '.github', 'actions', 'engine', 'pins.yml');
  if (existsSync(pins)) {
    const v = parseDocument(readFileSync(pins, 'utf8')).get('engine_repo');
    if (typeof v === 'string') return v;
  }
  return 'pollomarzo/whitelabel';
}

async function cmdBuild(argv: string[]): Promise<number> {
  const paperRoot = resolve(flag(argv, 'paper') ?? '.');
  const instanceRoot = has(argv, 'no-instance')
    ? null
    : resolve(flag(argv, 'instance') ?? mustInstance());
  const baseUrl = flag(argv, 'base-url') ?? '';
  const engineRepo = flag(argv, 'engine-repo') ?? readEngineRepo(paperRoot);

  // Dev/CI-from-checkout asset resolution: a local typst template in the engine checkout
  // beats the (not-yet-existent) release zip; `--no-site-template` uses myst's default
  // theme until the fork release exists (compose siteTemplate: null).
  const localTypst = join(engineRoot(), 'templates', 'typst');
  const assetOverrides = {
    ...(flag(argv, 'typst-template')
      ? { typstTemplate: resolve(flag(argv, 'typst-template')!) }
      : existsSync(localTypst)
        ? { typstTemplate: localTypst }
        : {}),
    ...(has(argv, 'no-site-template') ? { siteTemplate: null as string | null } : {}),
  };

  const { runBuild } = await import('./build.js');
  const { createMystEdge } = await import('./myst.js');
  const res = await runBuild({
    paperRoot,
    engineRoot: engineRoot(),
    instanceRoot,
    engineRepo,
    baseUrl,
    assetOverrides,
    // --exports-only builds just the typst PDF (offline canary; no network theme).
    // --no-exports builds HTML only (until the typst-template release zip exists).
    buildOpts: has(argv, 'exports-only')
      ? { exportsOnly: true }
      : has(argv, 'no-exports')
        ? { all: false, html: true }
        : { all: true, html: true },
    edge: createMystEdge(),
  });
  for (const w of res.warnings) process.stderr.write(`::warning::${w}\n`);
  process.stderr.write(`oak build: done (id=${res.resolvedProject.id ?? '?'})\n`);
  return 0;

  function mustInstance(): string {
    process.stderr.write(
      'oak build: pass --instance <path> (or --no-instance for an unbranded build). ' +
        'Local pins-based instance cloning is a CI concern for now.\n',
    );
    process.exit(2);
  }
}

async function main(argv: string[]): Promise<number> {
  const verb = argv[0] as Verb | undefined;
  if (verb === 'build') return cmdBuild(argv.slice(1));
  if (verb && verb in STUB_SLICE) {
    process.stderr.write(`oak ${verb}: not implemented yet (${STUB_SLICE[verb]}).\n`);
    return 1;
  }
  process.stderr.write(
    `oak: usage: oak build [--paper <dir>] [--instance <dir> | --no-instance] ` +
      `[--base-url <url>] [--no-site-template]\n`,
  );
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`::error::${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
