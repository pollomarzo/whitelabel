/**
 * upgrade.ts — `oak upgrade` (slice 5). Render-and-compare lifecycle: pick a repo, render the
 * frozen `.github/` at a target engine tag from the repo's own answers, 2-way diff against the
 * files on disk, and offer {bump the logic ref only / resync the drifted frozen files / both}
 * as a PR. No stored `template_version` marker and no 3-way merge: the frozen files are fully
 * reconstructable from `pins.yml` + `CODEOWNERS`, and they are policy-never-edited, so any
 * divergence is reset to the template render (a deliberate hand-edit still shows in the PR).
 *
 *  - **version-only** bumps `project.options.oaktree-sapling.version` → target in `myst.yml`
 *    (YAML round-trip, never sed). Data — not CODEOWNERS-gated.
 *  - **files-only** overwrites the drifted frozen files with the target render. Touched paths
 *    are all under `/.github/` (+ `/CODEOWNERS`), so the PR lands on the CODEOWNERS gate.
 *  - **both** does both.
 *
 * Output is always a PR (reusing openDoiPr's branch→commit-as-bot→push→gh-pr-create shape),
 * never a silent push; a clean repo with no requested bump opens nothing. SEAMS (target
 * resolution, template materialization, the PR) are injected — faked in tests. No myst-cli.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { readDoc, writeDoc } from './yaml-io.js';
import { renderPins, renderCodeowners, type TemplateAnswers } from './bootstrap.js';

const PINS_REL = posix.join('.github', 'actions', 'engine', 'pins.yml');
const CODEOWNERS_REL = 'CODEOWNERS';

/* --------------------------------------------------------------------------
 * Answers read back from the repo (pins.yml + CODEOWNERS + myst.yml)
 * ------------------------------------------------------------------------ */

/** The CODEOWNERS owner token (last field of the first gated line), or a safe default. */
export function ownerFromCodeowners(src: string): string {
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    if (parts.length >= 2) return parts[parts.length - 1]!;
  }
  return '@owner';
}

export function readAnswers(repoRoot: string): TemplateAnswers {
  const pins = readDoc(join(repoRoot, PINS_REL));
  const engineRepo = String(pins.get('engine_repo') ?? '');
  const instanceRepo = String(pins.get('instance_repo') ?? '.');
  const coPath = join(repoRoot, CODEOWNERS_REL);
  const owner = existsSync(coPath) ? ownerFromCodeowners(readFileSync(coPath, 'utf8')) : '@owner';
  const myst = join(repoRoot, 'myst.yml');
  let version = '';
  let edition = '';
  if (existsSync(myst)) {
    const doc = readDoc(myst);
    version = String(doc.getIn(['project', 'options', 'oaktree-sapling', 'version']) ?? '');
    edition = String(doc.getIn(['project', 'options', 'oaktree-sapling', 'edition']) ?? '');
  }
  return { engineRepo, instanceRepo, owner, version, edition };
}

/* --------------------------------------------------------------------------
 * Drift (pure) — render each frozen file at target, 2-way diff vs disk
 * ------------------------------------------------------------------------ */

/** The frozen files scanned for drift: everything under `.github/` plus `CODEOWNERS`. The
 *  author content (myst.yml/index.md/bib.bib) is NOT frozen and never resynced. */
function frozenFiles(templateAtTarget: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix ? posix.join(prefix, name) : name;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else if (rel === CODEOWNERS_REL || rel.startsWith('.github/')) out.push(rel);
    }
  };
  walk(templateAtTarget, '');
  return out.sort();
}

/** Render a single frozen file at the target with the repo's answers. */
export function renderFrozenFile(templateAtTarget: string, rel: string, answers: TemplateAnswers): string {
  if (rel === PINS_REL) return renderPins(templateAtTarget, answers);
  if (rel === CODEOWNERS_REL)
    return renderCodeowners(readFileSync(join(templateAtTarget, rel), 'utf8'), answers.owner);
  return readFileSync(join(templateAtTarget, rel), 'utf8');
}

/**
 * Drift = frozen files whose target render differs from the on-disk file (or that are absent
 * on disk). 2-way, reset-to-template semantics. Returns the changed relative paths, sorted.
 */
export function computeDrift(repoRoot: string, templateAtTarget: string, answers: TemplateAnswers): string[] {
  const changed: string[] = [];
  for (const rel of frozenFiles(templateAtTarget)) {
    const rendered = renderFrozenFile(templateAtTarget, rel, answers);
    const onDisk = join(repoRoot, rel);
    if (!existsSync(onDisk) || readFileSync(onDisk, 'utf8') !== rendered) changed.push(rel);
  }
  return changed;
}

/* --------------------------------------------------------------------------
 * Seams
 * ------------------------------------------------------------------------ */

export interface UpgradePr {
  /** branch → add `paths` → commit as bot → push → `gh pr create`; returns the PR URL. */
  open(repoRoot: string, opts: { branch: string; title: string; body: string; paths: string[] }): string;
}

export interface UpgradeDeps {
  /** Latest engine release tag for `engineRepo` (used when --to is absent). */
  resolveTarget(engineRepo: string): string;
  /** Materialize `templates/paper/` of `engineRepo` at `tag`; returns its path. */
  materializeTemplate(engineRepo: string, tag: string): string;
  pr: UpgradePr;
  log(msg: string): void;
  confirm(plan: string[]): Promise<boolean>;
}

export type UpgradeMode = 'version-only' | 'files-only' | 'both';

export interface UpgradeInput {
  repoRoot: string;
  to?: string; // target tag; else latest release
  mode: UpgradeMode;
}

export interface Outcome {
  exitCode: number;
  result: Record<string, unknown>;
}

/** Write the target version into myst.yml's engine coordinate (YAML round-trip). */
function bumpVersion(repoRoot: string, target: string): void {
  const myst = join(repoRoot, 'myst.yml');
  const doc = readDoc(myst);
  doc.setIn(['project', 'options', 'oaktree-sapling', 'version'], target);
  writeDoc(myst, doc);
}

/** Overwrite the drifted frozen files on disk with their target render. */
function resyncFiles(repoRoot: string, templateAtTarget: string, answers: TemplateAnswers, drift: string[]): void {
  for (const rel of drift) {
    const dest = join(repoRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, renderFrozenFile(templateAtTarget, rel, answers));
  }
}

export async function cmdUpgrade(input: UpgradeInput, deps: UpgradeDeps): Promise<Outcome> {
  const { repoRoot, mode } = input;
  const answers = readAnswers(repoRoot);
  if (!answers.engineRepo) {
    return { exitCode: 2, result: { status: 'error', message: `no engine_repo in ${PINS_REL} — is this a paper repo?` } };
  }
  const target = input.to ?? deps.resolveTarget(answers.engineRepo);
  const wantVersion = mode === 'version-only' || mode === 'both';
  const wantFiles = mode === 'files-only' || mode === 'both';

  const versionChanged = wantVersion && answers.version !== target;

  // Only materialize + diff the template when a files resync is requested (the frequent
  // version-only bump needs no clone).
  let drift: string[] = [];
  let templateAtTarget: string | null = null;
  if (wantFiles) {
    templateAtTarget = deps.materializeTemplate(answers.engineRepo, target);
    drift = computeDrift(repoRoot, templateAtTarget, answers);
  }
  const filesChanged = wantFiles && drift.length > 0;

  if (!versionChanged && !filesChanged) {
    deps.log(`up to date at ${target} — no PR.`);
    return { exitCode: 0, result: { status: 'ok', target, drift: [], pr: null, up_to_date: true } };
  }

  const plan = [
    `upgrade ${repoRoot} → ${target}`,
    ...(versionChanged ? [`  ○ bump options.oaktree-sapling.version: ${answers.version || '(unset)'} → ${target}`] : []),
    ...(filesChanged ? [`  ○ resync ${drift.length} drifted frozen file(s): ${drift.join(', ')}`] : []),
    ...(wantFiles && !filesChanged ? ['  ✓ frozen files already up to date'] : []),
  ];
  if (!(await deps.confirm(plan))) return { exitCode: 0, result: { status: 'aborted', target } };

  const paths: string[] = [];
  if (versionChanged) {
    bumpVersion(repoRoot, target);
    paths.push('myst.yml');
  }
  if (filesChanged) {
    resyncFiles(repoRoot, templateAtTarget!, answers, drift);
    paths.push(...drift);
  }

  const url = deps.pr.open(repoRoot, {
    branch: `oak/upgrade-${target}`,
    title: `Upgrade engine to ${target}`,
    body: upgradeBody(target, versionChanged, drift),
    paths,
  });
  deps.log(`opened upgrade PR ${url}`);
  return {
    exitCode: 0,
    result: { status: 'ok', target, drift, version_bumped: versionChanged, pr: url, paths },
  };
}

function upgradeBody(target: string, versionChanged: boolean, drift: string[]): string {
  const lines = [`Upgrades the engine coordinate to \`${target}\`.`, ''];
  if (versionChanged) lines.push(`- bumps \`project.options.oaktree-sapling.version\` → \`${target}\` (data, not gated)`);
  if (drift.length) {
    lines.push(`- resyncs the frozen shim to the ${target} template (CODEOWNERS-gated \`.github/\`):`);
    for (const d of drift) lines.push(`  - \`${d}\``);
  }
  lines.push('', '_Opened by `oak upgrade`. Review the preview build before merging._');
  return lines.join('\n');
}
