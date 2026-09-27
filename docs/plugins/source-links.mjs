/**
 * source-links.mjs: rewrites `[text](src:path#L10-L20)` to a GitHub blob URL at a pinned ref.
 *
 * The one place the docs name where the engine's source lives. MyST's GitHub link transform
 * then gives each link a hover preview of exactly those lines, fetched from the pinned ref.
 *
 * REF is a release tag: the launchers a paper runs are a release's launchers, so a link shows what the
 * fleet runs. Bump it after a release when the text describes newer code, and re-check the
 * cited line ranges then; a pinned link never drifts on its own. REPO moves with the
 * canonical move, alongside `engine_repo` in the paper template's `pins.yml`.
 */
const REPO = 'pollomarzo/whitelabel';
const REF = 'v0.0.4';

const SCHEME = 'src:';

function rewrite(node, file) {
  if (node.type === 'link' && typeof node.url === 'string' && node.url.startsWith(SCHEME)) {
    const path = node.url.slice(SCHEME.length);
    if (!path || path.startsWith('/')) {
      file.message(`source link '${node.url}' needs a repository-relative path`, node);
      return;
    }
    node.url = `https://github.com/${REPO}/blob/${REF}/${path}`;
    node.urlSource = node.url;
  }
  node.children?.forEach((c) => rewrite(c, file));
}

export default {
  name: 'Source links',
  transforms: [
    {
      name: 'source-links',
      doc: 'Resolve src: links to the engine source at the pinned ref.',
      // `document` runs before MyST's link transforms, so the GitHub transform sees the URL.
      stage: 'document',
      plugin: () => (tree, file) => rewrite(tree, file),
    },
  ],
};
