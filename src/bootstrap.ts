/**
 * bootstrap.ts — `oak bootstrap paper` + `oak bootstrap journal` (slice 5). Stands up a
 * paper repo (bare or ingest) or a journal/tenant (external instance-config, or co-located
 * flagship) from the frozen `templates/paper/` + `templates/instance/`. Ports the ISP
 * `create-submission-target.sh`
 * provisioning (idempotent repo create → seed → ingest → rulesets → Pages → env → labels),
 * with the new-model corrections baked in:
 *
 *  - **The paper template is the frozen shim + a starter myst.yml/index.md/bib.bib.** Only
 *    `pins.yml` (engine_repo/instance_repo) and `CODEOWNERS` (owner) are RENDERED; every
 *    other frozen file is byte-copied. The starter `myst.yml` gets the engine coordinate.
 *  - **Ingest restores the ENTIRE `.github/` from `main`** — including
 *    `.github/actions/engine/pins.yml`, not just workflows + CODEOWNERS as the script did.
 *    In the new model `pins.yml` carries the trust-boundary `engine_repo` pin, so author-side
 *    `FETCH_HEAD` content must never supply it (see `buildReviewTree`).
 *  - **Idempotent, GET-then-act**: every step reads state first, so a re-run repairs a partial
 *    bootstrap. Every mutation is a provisioning call or a PR — never a silent content push
 *    past the CODEOWNERS gate.
 *  - **Secrets are set-if-provided only** ([R25] floor). Absent ones are skipped and the exact
 *    remaining runbook is printed (which secret, where) — never a value in a log.
 *
 * SEAMS: all GitHub/git effects go through the injected `Provisioner` (real impl in gh.ts,
 * faked in tests); rendering is pure fs. This module does NOT import myst-cli.
 */
import * as msg from './messages.js';
import {
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { readDoc, writeDoc } from './yaml-io.js';
import { themeZipUrl } from './assets.js';

/* --------------------------------------------------------------------------
 * Answers + template rendering (pure)
 * ------------------------------------------------------------------------ */

export interface TemplateAnswers {
  /** owner/repo the engine is checked out from (pins.yml engine_repo). */
  engineRepo: string;
  /** owner/repo of instance-config, or '.' when co-located (pins.yml instance_repo). */
  instanceRepo: string;
  /** CODEOWNERS owner token: `@user` or `@org/team`. */
  owner: string;
  /** engine ref (a released tag) written into the starter myst.yml coordinate. */
  version: string;
  /** edition id written into the starter myst.yml coordinate + the edition filename. */
  edition: string;
  /** journal.yml `name` for the instance-config skeleton. */
  journalName?: string;
}

const RENDER_PINS = posix.join('.github', 'actions', 'engine', 'pins.yml');
const RENDER_CODEOWNERS = 'CODEOWNERS';
const RENDER_MYST = 'myst.yml';
const RENDER_SITE_INDEX = posix.join('pages', 'index.md');
const RENDER_SITE_PKG = 'package.json';
/** Top-level template entries that are engine-side docs, never stamped into a tenant repo.
 *  Applies to both templates (each ships its own README). Not a role-partition list — the
 *  paper/instance split is now structural (separate source trees), so this is only the
 *  README carve-out, guarded by the disjointness invariant (test/template.test.ts). */
const EXCLUDE_FROM_STAMP = new Set(['README.md']);

/** The three template source roots under the engine checkout. Named + one-liners so
 *  resolution is testable rather than inlined at call sites. */
export function paperTemplateRoot(engineRoot: string): string {
  return join(engineRoot, 'templates', 'paper');
}
export function instanceTemplateRoot(engineRoot: string): string {
  return join(engineRoot, 'templates', 'instance');
}
export function siteTemplateRoot(engineRoot: string): string {
  return join(engineRoot, 'templates', 'site');
}

/**
 * The engine's own `myst-cli` range, copied VERBATIM into the site scaffold's
 * `package.json` as its `mystmd` dependency ([R80]). No parsing, no normalizing: the site should render with
 * roughly the myst the engine bundles, so the gallery plugin and the theme behave the same
 * in both builds. This is hygiene, not correctness — the site is not the reproducibility
 * anchor (the Zenodo deposit is, design §7), so a caret range is enough and a
 * resolved-version pin would be false precision.
 */
export function engineMystRange(engineRoot: string): string {
  const pkg = JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const range = pkg.dependencies?.['myst-cli'];
  if (!range) throw new Error('bootstrap: engine package.json declares no myst-cli dependency');
  return range;
}

/** Every path under `dir`, recursive + relative (posix separators), files only. */
export function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix ? posix.join(prefix, name) : name;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Basenames a template file ships under → the basename it is stamped as.
 *
 * `.gitignore` is the whole list, and npm is the reason: a leading-dot `.gitignore` is
 * stripped from EVERY npm tarball, unconditionally and with no opt-out. Shipping it as-is
 * means an engine installed from npm seeds repos with no `.gitignore` at all — so a tenant
 * commits `_build/` and `node_modules/` — while a git checkout of the engine seeds it fine.
 * The templates therefore hold `gitignore`, and the stamp puts the dot back.
 *
 * The VALUES are therefore exactly the basenames npm would strip, which is what the
 * `templates survive npm packaging` test asserts against — one list, not two that must
 * agree. Keyed on the basename, not the whole rel path, so a template file added in a
 * SUBDIRECTORY is covered too: npm strips it at any depth.
 */
export const STAMP_RENAME: Record<string, string> = { gitignore: '.gitignore' };

/** A template-source rel path → the rel path it is written to in the tenant's repo. */
export function stampRel(rel: string): string {
  const parts = rel.split('/');
  const renamed = STAMP_RENAME[parts[parts.length - 1]!];
  if (!renamed) return rel;
  parts[parts.length - 1] = renamed;
  return parts.join('/');
}

/** The relative paths a render would actually stamp from `root` (all files minus the engine
 *  README), under their STAMPED names. Shared by the disjointness invariant test so it checks
 *  real stamped output, not raw source files. Subpaths are preserved (no basename flatten). */
export function stampedFiles(root: string): string[] {
  return listFiles(root)
    .filter((rel) => !EXCLUDE_FROM_STAMP.has(rel.split('/')[0]!))
    .map(stampRel);
}

function writeRel(destRoot: string, rel: string, contents: string | Buffer): void {
  const abs = join(destRoot, stampRel(rel));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/** pins.yml with engine_repo/instance_repo set via the YAML Document API (comments kept). */
export function renderPins(templateRoot: string, answers: TemplateAnswers): string {
  const doc = readDoc(join(templateRoot, RENDER_PINS));
  doc.set('engine_repo', answers.engineRepo);
  doc.set('instance_repo', answers.instanceRepo);
  return doc.toString();
}

/** CODEOWNERS with the owner column on each gated line swapped to `owner`. Not a structured
 *  config (no YAML), so a line-wise rewrite that keeps the path + spacing is the safe edit. */
export function renderCodeowners(src: string, owner: string): string {
  return src
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const m = /^(\s*\S+\s+)\S.*$/.exec(line);
      return m ? m[1] + owner : line;
    })
    .join('\n');
}

/** starter myst.yml with the engine coordinate (version/edition) set via the Document API. */
export function renderMyst(templateRoot: string, answers: TemplateAnswers): string {
  const doc = readDoc(join(templateRoot, RENDER_MYST));
  doc.setIn(['project', 'options', 'oaktree-sapling', 'version'], answers.version);
  doc.setIn(['project', 'options', 'oaktree-sapling', 'edition'], answers.edition);
  return doc.toString();
}

/**
 * Render the paper-repo template (frozen shim + starter content) from its own root into
 * `destRoot`. `pins.yml`, `CODEOWNERS`, and `myst.yml` are rendered from answers; every other
 * file is byte-copied. Returns the written relative paths (posix). Excludes the engine README.
 */
export function renderPaperTemplate(paperRoot: string, destRoot: string, answers: TemplateAnswers): string[] {
  const written: string[] = [];
  for (const rel of listFiles(paperRoot)) {
    if (EXCLUDE_FROM_STAMP.has(rel.split('/')[0]!)) continue;
    if (rel === RENDER_PINS) writeRel(destRoot, rel, renderPins(paperRoot, answers));
    else if (rel === RENDER_CODEOWNERS)
      writeRel(destRoot, rel, renderCodeowners(readFileSync(join(paperRoot, rel), 'utf8'), answers.owner));
    else if (rel === RENDER_MYST) writeRel(destRoot, rel, renderMyst(paperRoot, answers));
    else copyRel(paperRoot, destRoot, rel);
    written.push(stampRel(rel));
  }
  return written.sort();
}

/**
 * Render the instance-config skeleton (journal.yml / editions/<edition>.yml / brand/ /
 * registry) from its own root into `destRoot`. `journal.yml` `name` is set from answers; the
 * edition file is renamed to `editions/<edition>.yml`; the rest is byte-copied. Excludes the
 * engine README. Returns written rel paths.
 */
export function renderInstanceTemplate(instanceRoot: string, destRoot: string, answers: TemplateAnswers): string[] {
  const written: string[] = [];
  for (const rel of listFiles(instanceRoot)) {
    if (EXCLUDE_FROM_STAMP.has(rel.split('/')[0]!)) continue;
    if (rel === 'journal.yml') {
      const doc = readDoc(join(instanceRoot, rel));
      if (answers.journalName) doc.set('name', answers.journalName);
      writeRel(destRoot, rel, doc.toString());
    } else if (rel === posix.join('editions', 'edition.yml')) {
      const dest = posix.join('editions', `${answers.edition}.yml`);
      copyFileBytes(join(instanceRoot, rel), join(destRoot, dest));
      written.push(dest);
      continue;
    } else {
      copyFileBytes(join(instanceRoot, rel), join(destRoot, rel));
    }
    written.push(stampRel(rel));
  }
  return written.sort();
}

/** The engine tag's raw URL for the gallery plugin. It must be REMOTE because it is code —
 *  a `.mjs` body cannot be stamped into YAML, and vendoring a copy is the copy-rot the
 *  engine exists to kill. Pinned to the tag, so the site takes engine updates only when the
 *  tenant bumps it. */
export function galleryPluginUrl(engineRepo: string, engineVersion: string): string {
  return `https://raw.githubusercontent.com/${engineRepo}/${engineVersion}/plugins/gallery.mjs`;
}

/** The journal site's Pages URL for `owner/repo` — a PROJECT site, hence the subpath ([S8]). */
export function siteUrlFor(repo: string): string {
  const [owner, name] = repo.split('/');
  return `https://${owner}.github.io/${name}/`;
}

/**
 * Render the journal-site scaffold (`templates/site/`) into `destRoot`. Unioned with the
 * instance-config scaffold for `--external`: [S8]'s variant A′ makes the site and the
 * instance-config ONE repo, so the registry PR that adds a paper is also the deploy trigger.
 *
 * ONE-SHOT — the tenant owns every byte of this outright ([S3]). It is not frozen, not
 * covered by `oak upgrade`, and the engine re-reads none of it. Exactly FOUR values are
 * rendered; everything else is byte-copied:
 *
 *   1. the gallery plugin URL (engine repo + tag),
 *   2. `site.template` from `themeZipUrl()` — rendered FROM the constant, not duplicated,
 *      so there is nothing for a drift test to catch,
 *   3. the journal name (myst.yml `project.title` + the `pages/index.md` heading),
 *   4. the `myst-cli` range, into the scaffold's `package.json` — where `js-yaml` is pinned
 *      too, so the site has ONE dependency list. The workflow just runs `npm install` +
 *      `npx myst`, and is byte-copied. (An earlier shape pinned MyST via `npx -y mystmd@…`
 *      in the workflow, which meant two pinning mechanisms and two installs for one site;
 *      `npx -y` was already fetching MyST on every run, so consolidating removed an install
 *      rather than adding one.)
 *
 * No `project.id` (myst doesn't require one, and the engine's id machinery is paper-only),
 * no edition rename, no file-path rewriting.
 */
export function renderSiteTemplate(
  siteRoot: string,
  destRoot: string,
  answers: TemplateAnswers,
  mystRange: string,
): string[] {
  const journalName = answers.journalName ?? 'CHANGE-ME Journal';
  const written: string[] = [];
  for (const rel of listFiles(siteRoot)) {
    if (EXCLUDE_FROM_STAMP.has(rel.split('/')[0]!)) continue;
    if (rel === RENDER_MYST) {
      const doc = readDoc(join(siteRoot, rel));
      doc.setIn(['project', 'title'], journalName);
      doc.setIn(
        ['project', 'plugins', 0],
        galleryPluginUrl(answers.engineRepo, answers.version),
      );
      doc.setIn(['site', 'template'], themeZipUrl());
      writeRel(destRoot, rel, doc.toString());
    } else if (rel === RENDER_SITE_INDEX || rel === RENDER_SITE_PKG) {
      // Markdown and package.json: substituted textually, because reformatting either
      // through a structured writer would be a worse trade than a literal token swap.
      const src = readFileSync(join(siteRoot, rel), 'utf8');
      writeRel(
        destRoot,
        rel,
        src.replaceAll('{{journal_name}}', journalName).replaceAll('{{myst_version}}', mystRange),
      );
    } else {
      copyRel(siteRoot, destRoot, rel);
    }
    written.push(stampRel(rel));
  }
  return written.sort();
}

function copyRel(srcRoot: string, destRoot: string, rel: string): void {
  copyFileBytes(join(srcRoot, rel), join(destRoot, stampRel(rel)));
}
function copyFileBytes(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

/* --------------------------------------------------------------------------
 * Ingest tree (pure) — new-model: restore the ENTIRE .github/ from main
 * ------------------------------------------------------------------------ */

/**
 * The review tree = author content with the whole editor-side trust boundary restored from
 * `main`: the entire `.github/` (including `.github/actions/engine/pins.yml`, the engine pin)
 * plus the root `CODEOWNERS`. Author files under those paths are DROPPED and replaced by
 * main's. The script restored only workflows + CODEOWNERS; the new model must restore the
 * whole engine action too, so author `FETCH_HEAD` content can never supply `pins.yml`. Pure,
 * so the "pins.yml is editor-side, not author-side" invariant is unit-testable.
 */
export function buildReviewTree(
  authorFiles: Record<string, string>,
  mainFiles: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(authorFiles)) {
    if (isEditorControlled(path)) continue; // author-side trust boundary never survives
    out[path] = content;
  }
  for (const [path, content] of Object.entries(mainFiles)) {
    if (isEditorControlled(path)) out[path] = content; // editor-side wins
  }
  return out;
}

/** The paths the editor's `main` owns through the ingest: the `.github/` subtree + CODEOWNERS. */
function isEditorControlled(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return p === '.github' || p.startsWith('.github/') || p === 'CODEOWNERS';
}

/* --------------------------------------------------------------------------
 * Provisioner seam (real impl in gh.ts; faked in tests)
 * ------------------------------------------------------------------------ */

export interface Provisioner {
  /** 'Organization' | 'User' for an owner login — decides team-grant vs repo-admin bypass. */
  ownerType(owner: string): 'Organization' | 'User';
  repoExists(repo: string): boolean;
  createRepo(repo: string, opts: { private: boolean; description: string }): void;
  branchExists(repo: string, branch: string): boolean;
  /** Seed `branch` of `repo` as an orphan commit from a prepared local directory, then push. */
  seedBranch(repo: string, branch: string, sourceDir: string, message: string): void;
  /**
   * Build a `review` branch = author content (from `sourceUrl`@`sourceRef`) with the entire
   * frozen `.github/` restored from `origin/main`, then push. Requires `main` to be seeded.
   */
  ingestReviewBranch(repo: string, opts: { sourceUrl: string; sourceRef: string; message: string }): void;
  prExists(repo: string, head: string): boolean;
  openPr(repo: string, opts: { head: string; base: string; title: string; body: string }): string;
  /** Grant `org/team` write on `repo` (org-owned repos only). */
  grantTeamWrite(repo: string, team: string): void;
  /** Numeric team id for the `v*` tag-ruleset bypass actor (org path). */
  teamId(team: string): number;
  rulesetExists(repo: string, name: string): boolean;
  createRuleset(repo: string, body: unknown): void;
  pagesEnabled(repo: string): boolean;
  enablePages(repo: string): void;
  environmentExists(repo: string, name: string): boolean;
  upsertEnvironment(repo: string, name: string): void;
  branchPolicyExists(repo: string, env: string, name: string): boolean;
  createBranchPolicy(repo: string, env: string, name: string, type: string): void;
  createLabel(repo: string, name: string, opts: { color?: string; description?: string }): void;
  setSecret(repo: string, name: string, value: string): void;
  /** `owner/repo` visibility (public/private) — used to enforce public instance-config. */
  repoVisibility(repo: string): 'public' | 'private';
  setRepoPublic(repo: string): void;
}

/* --------------------------------------------------------------------------
 * Ruleset bodies (ported from apply_rulesets_to_repo)
 * ------------------------------------------------------------------------ */

export const RULESET_PROTECT_MAIN = 'protect-main';
export const RULESET_V_TAGS = 'editors-only-v-tags';

function protectMainBody(requireChecks: boolean): unknown {
  const rules: unknown[] = [
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        require_code_owner_review: true,
        dismiss_stale_reviews_on_push: true,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
  ];
  // Require the Journal-checks Check Run to pass before merge. This is the gate the id relies
  // on now that id-shape no longer blocks the build (id-gate-relocation) — without it, an
  // invalid id could merge to main. Default-on; `--no-require-checks` opts out. NB a solo repo
  // admin can still bypass required checks on a personal account (PROVISIONING §3.3).
  if (requireChecks) {
    rules.push({
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [{ context: 'Journal checks' }],
        strict_required_status_checks_policy: false,
      },
    });
  }
  return {
    name: RULESET_PROTECT_MAIN,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules,
  };
}

function vTagsBody(bypass: unknown[]): unknown {
  return {
    name: RULESET_V_TAGS,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
    bypass_actors: bypass,
  };
}

/* --------------------------------------------------------------------------
 * Labels + secrets
 * ------------------------------------------------------------------------ */

const LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: 'editor-action-needed', color: 'b60205', description: msg.bootstrap.labelEditorAction },
  { name: 'zenodo-publish-failed', color: 'b60205', description: msg.bootstrap.labelZenodoFailed },
];

export interface SecretInputs {
  zenodoToken?: string;
  zenodoTokenSandbox?: string;
  cfToken?: string;
  cfAccount?: string;
}

const SECRET_MAP: Array<{ key: keyof SecretInputs; name: string }> = [
  { key: 'zenodoToken', name: 'ZENODO_TOKEN' },
  { key: 'zenodoTokenSandbox', name: 'ZENODO_TOKEN_SANDBOX' },
  { key: 'cfToken', name: 'CLOUDFLARE_API_TOKEN' },
  { key: 'cfAccount', name: 'CLOUDFLARE_ACCOUNT_ID' },
];

/* --------------------------------------------------------------------------
 * Orchestration
 * ------------------------------------------------------------------------ */

export interface BootstrapDeps {
  prov: Provisioner;
  /** `templates/paper/` of the engine checkout — the frozen shim + starter content. */
  paperTemplateRoot: string;
  /** `templates/instance/` of the engine checkout — the instance-config scaffold. */
  instanceTemplateRoot: string;
  /** `templates/site/` of the engine checkout — the journal-site scaffold ([R80]). */
  siteTemplateRoot: string;
  /** The engine's own `myst-cli` range, stamped into the site workflow ({@link engineMystRange}). */
  mystRange: string;
  log(msg: string): void;
  /** Print the plan + gate execution. Tests pass `() => true`; the CLI enforces --yes/TTY. */
  confirm(plan: string[]): Promise<boolean>;
  /** Fresh scratch dir for rendering the seed tree (default: os tmpdir). */
  workdir(): string;
}

export interface Outcome {
  exitCode: number;
  result: Record<string, unknown>;
}

/**
 * Where each value the tenant did NOT type came from, so the plan can say so. The CLI knows
 * this and bootstrap does not: by the time an input arrives here a defaulted value and a
 * typed one are indistinguishable, and a plan that cannot tell them apart cannot declare
 * either.
 */
export interface ResolvedFlags {
  engineVersionFrom?: 'flag' | 'latest-release';
  engineRepoFrom?: 'flag' | 'default';
}

/**
 * The plan's opening block: every value this run will use, and for each one whether it came
 * from a flag or from us. A default nobody was told about is a decision made on the tenant's
 * behalf, and `Proceed? [y/N]` is only consent if the assumptions are on the screen above it
 * — most of these end up stamped into files that are awkward to change afterwards.
 */
function declaredValues(v: {
  engineVersion: string;
  engineRepo: string;
  owner: string;
  ownerGiven: boolean;
  /** Whether this run actually USES the owner (an external journal repo gets no CODEOWNERS
   *  and no team grant, so declaring one there would be a value we do not honour). */
  ownerUsed: boolean;
  edition: string;
  editionGiven: boolean;
  /** The journal's name: a string when given, `null` on a journal run that did not give one,
   *  `undefined` when the row does not apply (a paper). */
  journalName?: string | null;
  instanceRepo?: string;
  resolved?: ResolvedFlags;
}): string[] {
  const rows: Array<[string, string]> = [];
  if (v.instanceRepo) {
    rows.push([
      msg.declared.labels.journalRepo,
      v.instanceRepo === '.'
        ? msg.declared.journalRepoCoLocated
        : msg.declared.journalRepo(v.instanceRepo),
    ]);
  }
  if (v.journalName !== undefined) {
    rows.push([
      msg.declared.labels.journalName,
      v.journalName ? msg.declared.journalNameGiven(v.journalName) : msg.declared.journalNameDefault,
    ]);
  }
  rows.push([
    msg.declared.labels.edition,
    v.editionGiven ? msg.declared.editionGiven(v.edition) : msg.declared.editionDefault(v.edition),
  ]);
  rows.push([
    msg.declared.labels.engineVersion,
    v.resolved?.engineVersionFrom === 'flag'
      ? msg.declared.engineVersionGiven(v.engineVersion)
      : msg.declared.engineVersionDefault(v.engineVersion),
  ]);
  rows.push([
    msg.declared.labels.engineRepo,
    v.resolved?.engineRepoFrom === 'flag'
      ? msg.declared.engineRepoGiven(v.engineRepo)
      : msg.declared.engineRepoDefault(v.engineRepo),
  ]);
  if (v.ownerUsed) {
    rows.push([
      msg.declared.labels.owner,
      v.ownerGiven ? msg.declared.ownerGiven(v.owner) : msg.declared.ownerDefault(v.owner),
    ]);
  }
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, val]) => `  ${k.padEnd(width)} : ${val}`);
}

export interface BootstrapPaperInput {
  repo: string; // owner/name
  from?: string; // author url (ingest mode) — bare when absent
  sourceRef?: string;
  instance?: string; // owner/instance-config; '.' co-located
  /** The journal edition this paper belongs to. REQUIRED (see cmdBootstrapPaper). */
  edition?: string;
  engineVersion: string;
  engineRepo: string; // resolved engine repo for pins.yml
  owner?: string; // @user | @org/team
  authedUser: string; // gh api user login (personal-account default owner)
  private: boolean;
  requireChecks: boolean; // add "Journal checks" to protect-main required checks (default true)
  secrets: SecretInputs;
  /** Provenance of the defaulted values, for the plan's declaration block. */
  resolved?: ResolvedFlags;
}

/** owner login (first path segment) of an owner/repo. */
function repoOwner(repo: string): string {
  return repo.split('/')[0]!;
}

/** Resolve the CODEOWNERS owner token + the org team (if any) from --owner / authed user. */
function resolveOwner(
  input: { owner?: string; authedUser: string; repo: string },
  prov: Provisioner,
): { ownerToken: string; team: string | null; ownerType: 'Organization' | 'User' } {
  const login = repoOwner(input.repo);
  const ownerType = prov.ownerType(login);
  const ownerToken = input.owner ?? `@${input.authedUser}`;
  // A team grant only applies when the owner token names an `@org/team` on an org account.
  const team = ownerType === 'Organization' && /^@[^/]+\/.+$/.test(ownerToken) ? ownerToken.slice(1) : null;
  return { ownerToken, team, ownerType };
}

function applyProvisioning(
  repo: string,
  owner: { team: string | null; ownerType: 'Organization' | 'User' },
  deps: BootstrapDeps,
  actions: Record<string, string>,
  requireChecks: boolean,
): void {
  const { prov, log } = deps;

  if (owner.team) {
    prov.grantTeamWrite(repo, owner.team);
    actions.team_grant = `granted ${owner.team} write`;
    log(msg.bootstrap.logTeamGranted(owner.team));
  }

  // protect-main
  if (prov.rulesetExists(repo, RULESET_PROTECT_MAIN)) {
    actions.protect_main = 'already exists';
    log(msg.bootstrap.logRulesetExists(RULESET_PROTECT_MAIN));
  } else {
    prov.createRuleset(repo, protectMainBody(requireChecks));
    actions.protect_main = 'created';
    log(msg.bootstrap.logRulesetCreated(RULESET_PROTECT_MAIN));
  }

  // editors-only-v-tags
  const bypass = owner.team
    ? [{ actor_id: prov.teamId(owner.team), actor_type: 'Team', bypass_mode: 'always' }]
    : [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]; // repo admin
  if (prov.rulesetExists(repo, RULESET_V_TAGS)) {
    actions.v_tags = 'already exists';
    log(msg.bootstrap.logTagRuleExists(RULESET_V_TAGS));
  } else {
    prov.createRuleset(repo, vTagsBody(bypass));
    actions.v_tags = 'created';
    log(msg.bootstrap.logTagRuleCreated(RULESET_V_TAGS));
  }

  // Pages
  if (prov.pagesEnabled(repo)) {
    actions.pages = 'already enabled';
    log(msg.bootstrap.logPagesExists);
  } else {
    prov.enablePages(repo);
    actions.pages = 'enabled';
    log(msg.bootstrap.logPagesEnabled);
  }

  // zenodo-publish environment + v* policy
  prov.upsertEnvironment(repo, 'zenodo-publish');
  if (prov.branchPolicyExists(repo, 'zenodo-publish', 'v*')) {
    actions.zenodo_env = 'v* policy already exists';
    log(msg.bootstrap.logZenodoEnvExists);
  } else {
    prov.createBranchPolicy(repo, 'zenodo-publish', 'v*', 'tag');
    actions.zenodo_env = 'created with v* policy';
    log(msg.bootstrap.logZenodoEnvCreated);
  }

  // labels
  for (const l of LABELS) prov.createLabel(repo, l.name, { color: l.color, description: l.description });
  actions.labels = LABELS.map((l) => l.name).join(', ');
}

/** Set the provided secrets; collect a runbook for the ones left unset ([R25] floor). */
function applySecrets(repo: string, secrets: SecretInputs, deps: BootstrapDeps): { set: string[]; runbook: string[] } {
  const set: string[] = [];
  const missing: string[] = [];
  for (const { key, name } of SECRET_MAP) {
    const value = secrets[key];
    if (value) {
      deps.prov.setSecret(repo, name, value);
      set.push(name);
      deps.log(msg.bootstrap.logSecretSet(name));
    } else {
      missing.push(name);
    }
  }
  const runbook: string[] = [];
  if (missing.length) {
    runbook.push(msg.bootstrap.runbookSecrets(repo, missing.join(', ')));
  }
  runbook.push(msg.bootstrap.runbookForkApproval);
  return { set, runbook };
}

export async function cmdBootstrapPaper(input: BootstrapPaperInput, deps: BootstrapDeps): Promise<Outcome> {
  const { prov, log } = deps;
  const { repo } = input;
  const mode = input.from ? 'ingest' : 'bare';

  // A paper has no meaning without the journal it is a paper OF, and the ONLY place that
  // link is recorded is `pins.yml`'s `instance_repo`. Defaulting a missing `--instance` to
  // `.` (co-located) silently claimed "the journal.yml is in this repo" about a repo the
  // very same render gives no journal.yml: the CI shim then clones nothing, `oak validate`
  // and `oak build` hit the no-instance usage error, and the tenant learns about it from a
  // red Stage 1 minutes after a bootstrap that printed `"status": "ok"`. Ask up front.
  // `--instance .` stays available as the EXPLICIT co-located opt-in (repo=journal — the
  // tier `oak bootstrap journal --co-located` stands up, which renders the paper template
  // itself and never comes through here).
  if (!input.instance) {
    return {
      exitCode: 2,
      result: {
        status: 'error',
        repo,
        error: msg.bootstrap.instanceRequired,
      },
    };
  }
  // Same shape as --instance, and for the same reason. The edition id is written into the
  // paper's myst.yml, and the journal must already have an `editions/<id>.yml` under that
  // exact name — so a defaulted literal `edition` is not a convenience, it is a guaranteed
  // failure the tenant meets in CI rather than here. (`bootstrap journal` may default it:
  // there the SAME value names the edition file it writes, so it is self-consistent.)
  if (!input.edition) {
    return {
      exitCode: 2,
      result: {
        status: 'error',
        repo,
        error: msg.bootstrap.editionRequired(input.instance),
      },
    };
  }
  const owner = resolveOwner(input, prov);

  const instanceRepo = input.instance;
  const answers: TemplateAnswers = {
    engineRepo: input.engineRepo,
    instanceRepo,
    owner: owner.ownerToken,
    version: input.engineVersion,
    edition: input.edition,
  };

  // ---- GET-then-act state reads (idempotency) ----
  const repoThere = prov.repoExists(repo);
  const mainThere = repoThere && prov.branchExists(repo, 'main');
  const reviewThere = repoThere && mode === 'ingest' && prov.branchExists(repo, 'review');
  const prThere = reviewThere && prov.prExists(repo, 'review');

  const plan = [
    msg.bootstrap.paperPlanHeader(mode, repo),
    ...declaredValues({
      engineVersion: input.engineVersion,
      engineRepo: input.engineRepo,
      owner: owner.ownerToken,
      ownerGiven: Boolean(input.owner),
      ownerUsed: true,
      edition: input.edition,
      editionGiven: true, // required for papers — never defaulted
      instanceRepo,
      resolved: input.resolved,
    }),
    repoThere ? msg.bootstrap.planRepoExists : msg.bootstrap.planCreateRepo(input.private),
    mainThere ? msg.bootstrap.planMainSeeded : msg.bootstrap.planSeedPaper,
    // Idempotency has a sharp edge worth naming: a re-run to CHANGE an answer (a different
    // --instance, a different --engine-version) does not re-seed, so the earlier pins.yml
    // survives and the re-run appears to succeed while fixing nothing.
    ...(mainThere ? [msg.bootstrap.planAlreadySeededPaper(instanceRepo)] : []),
    ...(mode === 'ingest'
      ? [
          reviewThere
            ? msg.bootstrap.planReviewBranchExists
            : msg.bootstrap.planReviewBranch(input.from!, input.sourceRef ?? 'main'),
          prThere ? msg.bootstrap.planReviewPrExists : msg.bootstrap.planReviewPr,
        ]
      : []),
    msg.bootstrap.planProvisioning,
    msg.bootstrap.planSecrets(
      SECRET_MAP.filter((s) => input.secrets[s.key]).map((s) => s.name).join(', '),
    ),
  ];
  if (!(await deps.confirm(plan)))
    return {
      exitCode: 0,
      result: {
        status: 'aborted',
        repo,
        mode,
        reason: msg.prompt.abortedNothingCreated,
      },
    };

  const actions: Record<string, string> = {};

  if (!repoThere) {
    prov.createRepo(repo, { private: input.private, description: msg.bootstrap.descriptionPaper });
    actions.repo = 'created';
    log(msg.bootstrap.logCreated(repo));
  } else actions.repo = 'exists';

  // Render the paper seed (frozen shim + starter content) once; reused for main seeding.
  const seedDir = deps.workdir();
  renderPaperTemplate(deps.paperTemplateRoot, seedDir, answers);

  if (!mainThere) {
    prov.seedBranch(repo, 'main', seedDir, 'startpoint');
    actions.main = 'seeded';
    log(msg.bootstrap.logSeeded);
  } else actions.main = 'exists';

  let prUrl: string | undefined;
  if (mode === 'ingest') {
    if (!reviewThere) {
      prov.ingestReviewBranch(repo, {
        sourceUrl: input.from!,
        sourceRef: input.sourceRef ?? 'main',
        message: msg.bootstrap.ingestCommitMessage(input.from!),
      });
      actions.review = 'ingested';
      log(msg.bootstrap.logReviewBranch);
    } else actions.review = 'exists';

    if (!prThere) {
      prUrl = prov.openPr(repo, {
        head: 'review',
        base: 'main',
        title: msg.bootstrap.ingestPrTitle(repoOwner(repo)),
        body: msg.bootstrap.ingestPrBody(input.from!),
      });
      actions.pr = 'opened';
      log(msg.bootstrap.logPrOpened(prUrl));
    } else actions.pr = 'exists';
  }

  applyProvisioning(repo, owner, deps, actions, input.requireChecks);
  const { set, runbook } = applySecrets(repo, input.secrets, deps);
  for (const line of runbook) log(`  → ${line}`);

  return {
    exitCode: 0,
    result: { status: 'ok', repo, mode, actions, secrets_set: set, runbook, ...(prUrl ? { pr: prUrl } : {}) },
  };
}

/** The placeholder edition id when `--edition` is not given. Self-consistent (it also names
 *  the `editions/<id>.yml` this run writes) and declared in the plan — unlike the paper path,
 *  where the same default would name an edition file some OTHER repo has to already have. */
const DEFAULT_EDITION = 'edition';

export interface BootstrapJournalInput {
  repo: string; // owner/name
  tier: 'external' | 'co-located';
  name?: string;
  /** Defaults to {@link DEFAULT_EDITION}, declared in the plan. */
  edition?: string;
  engineVersion: string;
  engineRepo: string;
  owner?: string;
  authedUser: string;
  requireChecks: boolean; // add "Journal checks" to protect-main required checks (default true)
  /** `--external` only: also stamp the journal site + enable Pages. Default true;
   *  `--no-site` opts out for a tenant who wants a config repo with no website (the
   *  design keeps the site optional, §2). Passing `site: false` with `--co-located` is a
   *  usage ERROR, not a no-op: that tier never gets a site (repo=journal's index is the
   *  deferred `assemble()` work, [S7]), so a flag that reads as "turn the site off" would
   *  be silently meaningless — and silently meaningless flags teach the wrong model. */
  site?: boolean;
  secrets: SecretInputs;
  /** Provenance of the defaulted values, for the plan's declaration block. */
  resolved?: ResolvedFlags;
}

export async function cmdBootstrapJournal(input: BootstrapJournalInput, deps: BootstrapDeps): Promise<Outcome> {
  const { prov, log } = deps;
  const { repo } = input;
  const external = input.tier === 'external';
  if (!external && input.site === false) {
    return {
      exitCode: 2,
      result: {
        status: 'error',
        repo,
        error: msg.bootstrap.noSiteNeedsExternal,
      },
    };
  }
  const withSite = external && input.site !== false;
  const owner = resolveOwner(input, prov);
  const edition = input.edition ?? DEFAULT_EDITION;

  const answers: TemplateAnswers = {
    engineRepo: input.engineRepo,
    instanceRepo: '.', // co-located: this repo IS the instance; external: unused
    owner: owner.ownerToken,
    version: input.engineVersion,
    edition,
    journalName: input.name,
  };

  const repoThere = prov.repoExists(repo);
  const mainThere = repoThere && prov.branchExists(repo, 'main');

  const plan = [
    msg.bootstrap.journalPlanHeader(external, repo),
    ...declaredValues({
      engineVersion: input.engineVersion,
      engineRepo: input.engineRepo,
      owner: owner.ownerToken,
      ownerGiven: Boolean(input.owner),
      // An external journal repo gets no CODEOWNERS file and no team grant — nothing here
      // consumes the owner, so the plan must not claim it does.
      ownerUsed: !external,
      edition,
      editionGiven: Boolean(input.edition),
      journalName: input.name ?? null,
      resolved: input.resolved,
    }),
    repoThere ? msg.bootstrap.planRepoExists : msg.bootstrap.planCreateJournalRepo(external),
    mainThere
      ? msg.bootstrap.planMainSeeded
      : external
        ? msg.bootstrap.planSeedJournal(withSite)
        : msg.bootstrap.planSeedCoLocated,
    external
      ? withSite
        ? msg.bootstrap.planPages(siteUrlFor(repo))
        : msg.bootstrap.planNoSite
      : msg.bootstrap.planProvisioningCoLocated,
    // Same sharp edge as the paper path: a re-run never re-seeds, so a changed --name /
    // --edition / --engine-version does not reach an already-seeded main.
    ...(mainThere ? [msg.bootstrap.planAlreadySeededJournal] : []),
  ];
  if (!(await deps.confirm(plan)))
    return {
      exitCode: 0,
      result: {
        status: 'aborted',
        repo,
        tier: input.tier,
        reason: msg.prompt.abortedNothingCreated,
      },
    };

  const actions: Record<string, string> = {};

  if (!repoThere) {
    prov.createRepo(repo, {
      private: false,
      description: external ? msg.bootstrap.descriptionJournal : msg.bootstrap.descriptionCoLocated,
    });
    actions.repo = 'created (public)';
    log(msg.bootstrap.logCreatedPublic(repo));
  } else {
    actions.repo = 'exists';
    // Instance-config repos must be public ([R32], dec. 16); enforce on a re-run too.
    if (prov.repoVisibility(repo) === 'private') {
      prov.setRepoPublic(repo);
      actions.visibility = 'forced public';
      log(msg.bootstrap.logMadePublic);
    }
  }

  const seedDir = deps.workdir();
  if (external) {
    renderInstanceTemplate(deps.instanceTemplateRoot, seedDir, answers);
    // A′ ([S8]): the site FOLDS into instance-config. The two roots write disjoint paths
    // (enforced by test/template.test.ts), so the union is a plain back-to-back render.
    if (withSite) renderSiteTemplate(deps.siteTemplateRoot, seedDir, answers, deps.mystRange);
  } else {
    renderPaperTemplate(deps.paperTemplateRoot, seedDir, answers); // shim + starter paper (instance_repo: .)
    renderInstanceTemplate(deps.instanceTemplateRoot, seedDir, answers); // co-located instance-config
  }

  if (!mainThere) {
    prov.seedBranch(repo, 'main', seedDir, 'startpoint');
    actions.main = 'seeded';
    log(msg.bootstrap.logSeeded);
  } else actions.main = 'exists';

  if (!external) {
    applyProvisioning(repo, owner, deps, actions, input.requireChecks);
    const { set, runbook } = applySecrets(repo, input.secrets, deps);
    for (const line of runbook) log(`  → ${line}`);
    return { exitCode: 0, result: { status: 'ok', repo, tier: input.tier, actions, secrets_set: set, runbook } };
  }

  // --- external -------------------------------------------------------------------
  // Deliberately NOT provisioned: rulesets / branch protection on instance-config.
  // Registry upkeep is a manual editorial PR ([S5]) into a repo only editors can write;
  // adding protection is a tenant policy call, the same stance as `--no-require-checks`
  // on papers. Named in the runbook, not imposed.
  const runbook: string[] = [
    msg.bootstrap.runbookStartHere(repo),
    msg.bootstrap.runbookNoProtection,
  ];
  if (!withSite) {
    return { exitCode: 0, result: { status: 'ok', repo, tier: input.tier, actions, runbook } };
  }

  // Pages, through the same GET-then-act seams the paper path uses (idempotent re-run).
  if (prov.pagesEnabled(repo)) {
    actions.pages = 'already enabled';
    log(msg.bootstrap.logPagesExists);
  } else {
    prov.enablePages(repo);
    actions.pages = 'enabled';
    log(msg.bootstrap.logPagesEnabled);
  }

  const siteUrl = siteUrlFor(repo);
  actions.site = 'stamped';
  log(msg.bootstrap.logSiteAdded(siteUrl));
  runbook.push(msg.bootstrap.runbookSite(siteUrl), msg.bootstrap.runbookSiteFailure);
  for (const line of runbook) log(`  → ${line}`);

  return {
    exitCode: 0,
    result: { status: 'ok', repo, tier: input.tier, actions, site_url: siteUrl, runbook },
  };
}
