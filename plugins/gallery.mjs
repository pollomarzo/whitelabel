/**
 * gallery.mjs: the journal site's `paper-cards` directive (design §5; [S2]).
 *
 * A port of `impact-scholars.github.io/plugins/paper-gallery.mjs`, re-pointed from
 * `papers.txt` + a hardcoded org constant to the **registry** (`registry/papers.yml`,
 * design §9). Every URL is derived from a registry entry's `location`, never from an org
 * constant, so the same plugin serves any tenant.
 *
 * This file is ENGINE-owned but is NOT engine TypeScript: myst consumes it at runtime by
 * tag-pinned raw URL (`project.plugins:` accepts remote `.mjs`, myst-cli `config.ts:415-419`),
 * so it never enters `dist/cli.cjs` and `myst.ts` stays the only importer of myst-cli.
 *
 * WHY IT MUST STAY DEPENDENCY-LIGHT: myst downloads a remote plugin into
 * `<project>/_build/cache/config-item-<hash>.mjs` and imports it from there, so every bare
 * import must resolve from the SITE repo's own `node_modules`: the mystmd install (an npx
 * cache) is not on that resolution path. `js-yaml` is therefore declared in the site
 * scaffold's `package.json` and installed by the site workflow. Add nothing else here
 * without adding it there too.
 *
 * FAILURE IS HARD, ON PURPOSE. A registry entry whose `myst.yml` will not fetch is a broken
 * registry: it must be fixed, not papered over. A failed build is not an outage, Pages keeps
 * serving the last successful deploy, so the live journal stays exactly as it was until the
 * entry is corrected. Degrading would publish a visibly broken card to readers and bury the
 * signal in a log nobody reads. Note the division of labour, CORRECTED by a live run ([R80]):
 * the `throw` below covers PER-PAPER failures (it propagates and crashes the build regardless
 * of flags); `--strict` covers errors raised while building a page (a bad DOI, a missing
 * image); and NEITHER covers "the plugin never loaded at all"; myst logs `Unknown plugin` +
 * `unknown directive` and still exits 0, deploying a gallery-less page over a good one. That
 * third case is caught in the site workflow by asserting this plugin's `name` appears in the
 * build log, which is why the name below is load-bearing: do not rename it casually.
 *
 * The THUMBNAIL is deliberately not fetched here. This transform runs at `stage: 'document'`
 * (`process/mdast.ts:224`), i.e. BEFORE `transformImagesToDisk` (`:438`), so the remote URL
 * emitted below is picked up by `saveImageInStaticFolder` → `downloadAndSaveImage`
 * (`transforms/images.ts:115-117`) and written into the site's public folder under a content
 * hash. Three consequences: the published site serves a LOCAL copy rather than hotlinking
 * `raw.githubusercontent.com`; a broken thumbnail is already an error-kind warning
 * (`RuleId.imageDownloads`, `images.ts:82-88`, including the HTML-error-page content-type
 * case), so `--strict` fails the build on it with no extra check here; and caching titles in
 * the registry could never make the site build hermetic, because N thumbnail downloads would
 * remain either way.
 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

/** The registry, relative to the site build root. Fixed, not an option: [S8] fixed the repo
 *  layout (the site IS the instance-config repo), so a `:registry:` option would be
 *  configurability for a layout that cannot occur. Adding one later stays compatible. */
export const REGISTRY_PATH = 'registry/papers.yml';

/** Read + parse the registry. A missing/malformed registry is fatal: without it the page
 *  would deploy with an empty gallery, which reads as "this journal has no papers". */
export function loadRegistry(file = REGISTRY_PATH) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(
      `paper-cards: cannot read the paper registry at "${file}" (${err.message}). ` +
        `The gallery is built from this repo's registry, run the build from the repo root.`,
    );
  }
  const entries = yaml.load(raw) ?? [];
  if (!Array.isArray(entries)) {
    throw new Error(`paper-cards: "${file}" must be a LIST of registry entries (design §9).`);
  }
  return entries;
}

/**
 * The papers a `:::{paper-cards}` block shows, in **registry file order**: the editor
 * controls sequence by where they insert the entry, which is the one ordering rule that
 * needs no extra field. `edition` omitted → every registered paper (what the scaffold's
 * single page uses); a fresh journal has exactly one edition, and a tenant who grows a
 * second one adds a page and filters it ([S6]).
 */
export function selectEntries(registry, opts = {}) {
  const { edition } = opts;
  return edition ? registry.filter((entry) => entry.edition === edition) : [...registry];
}

/** `location.path` as a URL prefix: '.' / '' → '', 'papers/x' → 'papers/x/'. Kept even
 *  though every entry is `.` today: it is what keeps the repo=journal (n>1) tier reachable
 *  without touching this plugin ([S7]). */
function pathPrefix(path) {
  const trimmed = (path ?? '.').replace(/^\.$/, '').replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : '';
}

/**
 * The three URLs a card is built from. The ONE place [S4]'s shape shows up, and the one
 * place that changes if we ever read a built `myst.json` instead of the raw `myst.yml`.
 *
 * `site_url` is honored when present (custom domains, non-Pages hosting) and otherwise
 * derived from `location.repo`. Raw URLs go through **`HEAD`**, not `main`, so a tenant
 * whose default branch is named otherwise still resolves. The thumbnail path is not a
 * guess: `paper-base.yml` pins `project.thumbnail: thumbnails/thumbnail.png` for every paper.
 */
export function paperUrls(entry) {
  const repo = entry?.location?.repo;
  if (typeof repo !== 'string' || !repo.includes('/')) {
    throw new Error(
      `paper-cards: registry entry "${entry?.slug ?? entry?.id ?? '?'}" has no valid ` +
        `location.repo ("owner/name"). Fix the entry in ${REGISTRY_PATH}.`,
    );
  }
  const [owner, name] = repo.split('/');
  const prefix = pathPrefix(entry.location.path);
  const raw = `https://raw.githubusercontent.com/${repo}/HEAD/${prefix}`;
  return {
    siteUrl: entry.site_url ?? `https://${owner}.github.io/${name}`,
    configUrl: `${raw}myst.yml`,
    thumbUrl: `${raw}thumbnails/thumbnail.png`,
  };
}

/**
 * One card node, PURE: (registry entry, that paper's fetched myst config) → mdast. Title and
 * keywords come from the paper (the registry stays a thin pointer list, [S4]); the DOI comes
 * from the registry, since that is the one display field the registry actually owns.
 */
export function cardFrom(entry, config) {
  const { siteUrl, thumbUrl } = paperUrls(entry);
  const project = config?.project ?? {};
  const title = project.title || entry.slug || entry.id;
  const keywords = project.keywords ?? [];

  const children = [
    { type: 'header', children: [{ type: 'text', value: title }] },
    { type: 'image', url: thumbUrl, alt: title, width: '100%' },
  ];
  if (keywords.length > 0) {
    children.push({ type: 'paragraph', children: [{ type: 'text', value: keywords.join(' | ') }] });
  }
  // The DOI is TEXT, deliberately not a link. myst converts any `link` whose url is a DOI
  // into a `cite` node (`myst-cli/transforms/dois.ts:239-242`, no per-node opt-out), which
  // on a gallery card is wrong twice over: the card would render a citation label plus a
  // stray bibliography instead of the identifier, and each card would cost a doi.org
  // metadata fetch per build: rate-limited upstream, and one unreachable DOI fails the
  // whole journal under `--strict`. Found on the first live run, with a sandbox DOI.
  // The card itself already links to the paper, whose own page carries a real DOI link.
  if (entry.doi) {
    children.push({
      type: 'footer',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: `DOI: ${entry.doi}` }] }],
    });
  }
  return { type: 'card', url: siteUrl, children };
}

/** Fetch one paper's myst config. Throws naming BOTH the slug and the URL, because the fix
 *  is a registry edit and the editor needs to know which line to edit. */
export async function fetchPaperConfig(entry, fetchImpl = fetch) {
  const { configUrl } = paperUrls(entry);
  let response;
  try {
    response = await fetchImpl(configUrl);
  } catch (err) {
    throw new Error(
      `paper-cards: failed to fetch the config for "${entry.slug ?? entry.id}" from ${configUrl} ` +
        `(${err.message}). Fix or remove the entry in ${REGISTRY_PATH}.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `paper-cards: failed to fetch the config for "${entry.slug ?? entry.id}" from ${configUrl} ` +
        `(${response.status} ${response.statusText}). Fix or remove the entry in ${REGISTRY_PATH}.`,
    );
  }
  return yaml.load(await response.text());
}

const paperCardsDirective = {
  name: 'paper-cards',
  doc: 'A gallery of cards, one per registered paper.',
  options: {
    edition: {
      type: String,
      doc: 'Only show papers whose registry `edition` matches. Omit for every registered paper.',
    },
  },
  run(data) {
    const entries = selectEntries(loadRegistry(), { edition: data.options?.edition });
    if (entries.length === 0) {
      return [{ type: 'paragraph', children: [{ type: 'text', value: 'No papers found.' }] }];
    }
    // The directive is sync, so the per-paper fetch happens in the transform below; these
    // placeholder nodes carry the entry across.
    return [
      {
        type: 'grid',
        columns: [1, 1, 2, 3],
        children: entries.map((entry) => ({ type: 'paper-card-ref', entry, children: [] })),
      },
    ];
  },
};

function paperCardsTransform(opts, utils) {
  return async (mdast) => {
    const nodes = utils.selectAll('paper-card-ref', mdast);
    if (nodes.length === 0) return;
    await Promise.all(
      nodes.map(async (node) => {
        const { entry } = node;
        const config = await fetchPaperConfig(entry);
        const card = cardFrom(entry, config);
        delete node.entry;
        Object.assign(node, card);
      }),
    );
  };
}

const plugin = {
  name: 'Paper Gallery',
  directives: [paperCardsDirective],
  // `stage: 'document'` is load-bearing, not incidental; see the thumbnail note at the top.
  transforms: [{ plugin: paperCardsTransform, stage: 'document' }],
};

export default plugin;
