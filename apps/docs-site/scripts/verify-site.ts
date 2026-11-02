import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { SITE_ORIGIN, pagePath, pages } from '../src/site.ts';

const HERE = import.meta.dirname;
const DIST = process.env.DOCS_DIST ?? resolve(HERE, '../dist');
const VERCEL_JSON = resolve(HERE, '../vercel.json');
const MAIN_RS = resolve(HERE, '../../../packages/qaren-cli/src/main.rs');
const PLUGIN_JSON = resolve(HERE, '../../../packages/qaren-plugin/.claude-plugin/plugin.json');
const BASE = process.env.DOCS_BASE_PATH ?? '';
const OLD_BASE = '/QaReN';
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}`);
  }
}

function exists(relPath: string): boolean {
  return existsSync(join(DIST, relPath));
}

function page(relPath: string): string {
  return readFileSync(join(DIST, relPath), 'utf8');
}

function htmlFiles(dir = DIST): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

function pageFile(slug: string): string {
  return join(slug, 'index.html');
}

// KNOWN pre-existing broken references, skipped by the link check with a reason.
// Not introduced by this plan; remove an entry once the underlying asset ships.
const KNOWN_BROKEN = new Set<string>();

function checkInternalLinks(): void {
  let broken = 0;
  for (const file of htmlFiles()) {
    const html = readFileSync(file, 'utf8');
    const pageUrl = `https://site${BASE}/${relative(DIST, dirname(file))}/`.replace(/\/+$/, '/');
    for (const [, href] of html.matchAll(/(?:href|src)="([^"#?]+)[#?]?[^"]*"/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
      const url = new URL(href, pageUrl).pathname.replace(/\/$/, '') || '/';
      if (BASE && url !== BASE && !url.startsWith(`${BASE}/`)) {
        broken += 1;
        console.error(`  link outside the site base ${url} in ${file.slice(DIST.length)}`);
        continue;
      }
      if (KNOWN_BROKEN.has(url)) continue;
      const rel = url === (BASE || '/') ? '' : url.slice(BASE.length + 1);
      if (
        /\.(css|js|png|svg|txt|xml|ico|json|webmanifest|woff2?|ttf|webp|avif|jpe?g|gif|mp4)$/.test(
          rel,
        )
      ) {
        if (!exists(rel)) {
          broken += 1;
          console.error(`  broken asset ${url} in ${file.slice(DIST.length)}`);
        }
        continue;
      }
      if (!exists(join(rel, 'index.html')) && !exists(rel)) {
        broken += 1;
        console.error(`  broken link ${url} in ${file.slice(DIST.length)}`);
      }
    }
  }
  check('no broken internal links or assets', broken === 0);
}

console.log('verify-site: pages');
check('dist exists (run `bun run build` first)', existsSync(DIST));
for (const { slug } of pages) check(`${slug || 'index'} built`, exists(pageFile(slug)));
check('404.html built', exists('404.html'));

console.log('\nverify-site: links');
checkInternalLinks();
const rootRelative = /(?:href|src)="(\/(?!\/)[^"]*)"/g;
const misbased = htmlFiles().filter((file) =>
  [...readFileSync(file, 'utf8').matchAll(rootRelative)].some(([, href]) =>
    BASE
      ? href !== BASE && !href.startsWith(`${BASE}/`)
      : href === OLD_BASE || href.startsWith(`${OLD_BASE}/`),
  ),
);
check(
  BASE
    ? 'internal links carry the base path'
    : `internal links do not carry the old ${OLD_BASE} base`,
  misbased.length === 0,
);
for (const file of misbased) console.error(`  link with the wrong base in ${relative(DIST, file)}`);

console.log('\nverify-site: page structure');
for (const file of htmlFiles()) {
  const name = relative(DIST, file);
  const html = readFileSync(file, 'utf8');
  const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map(([, level]) => Number(level));
  check(`${name} has one h1`, levels.filter((level) => level === 1).length === 1);
  const skipped = levels.findIndex((level, i) => i > 0 && level > levels[i - 1] + 1);
  check(`${name} heading order starts at h1 and skips no level`, levels[0] === 1 && skipped === -1);
  if (/\bclass="[^"]*\bsl-|starlight/i.test(html)) {
    failed += 1;
    console.error(`FAIL  ${name} carries Starlight markup`);
  }
}
for (const { slug } of pages) {
  const html = exists(pageFile(slug)) ? page(pageFile(slug)) : '';
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? '';
  check(
    `${slug || 'index'} canonical is ${SITE_ORIGIN}${BASE}${pagePath(slug)}`,
    canonical === `${SITE_ORIGIN}${BASE}${pagePath(slug)}`,
  );
}

console.log('\nverify-site: generated files');
const sitemap = exists('sitemap.xml') ? page('sitemap.xml') : '';
for (const { slug } of pages)
  check(
    `sitemap lists ${slug || 'index'}`,
    sitemap.includes(`<loc>${SITE_ORIGIN}${BASE}${pagePath(slug)}</loc>`),
  );
check(
  'robots.txt points at the sitemap',
  exists('robots.txt') && page('robots.txt').includes(`Sitemap: ${SITE_ORIGIN}${BASE}/sitemap.xml`),
);
const llms = exists('llms.txt') ? page('llms.txt') : '';
const llmsFull = exists('llms-full.txt') ? page('llms-full.txt') : '';
const llmsSmall = exists('llms-small.txt') ? page('llms-small.txt') : '';
check(
  'llms.txt links both documentation sets',
  llms.includes('/llms-full.txt') && llms.includes('/llms-small.txt'),
);
for (const { slug, title } of pages) {
  check(
    `llms.txt and llms-full.txt name ${title}`,
    llms.includes(title) && llmsFull.includes(`# ${title}\n`),
  );
  if (slug !== 'changelog')
    check(`llms-small.txt names ${title}`, llmsSmall.includes(`# ${title}\n`));
}
check('pagefind index built', exists('pagefind/pagefind.js'));

console.log('\nverify-site: old-URL redirects');
type Redirect = { source: string; destination: string; permanent?: boolean };
const redirects: Redirect[] = existsSync(VERCEL_JSON)
  ? (JSON.parse(readFileSync(VERCEL_JSON, 'utf8')).redirects ?? [])
  : [];
for (const { slug } of pages)
  check(
    `vercel.json redirects ${OLD_BASE}${pagePath(slug)} permanently`,
    redirects.some((r) => {
      if (r.permanent !== true) return false;
      const oldPath = `${OLD_BASE}${pagePath(slug)}`;
      if (r.source.endsWith('/:path*')) {
        const prefix = r.source.slice(0, -6);
        return (
          oldPath.startsWith(prefix) &&
          r.destination.replace(':path*', oldPath.slice(prefix.length)) === pagePath(slug)
        );
      }
      return r.source === oldPath && r.destination === pagePath(slug);
    }),
  );

console.log('\nverify-site: CLI drift');
const usage = /const USAGE: &str = "((?:[^"\\]|\\.)*)";/.exec(readFileSync(MAIN_RS, 'utf8'))?.[1];
check('USAGE found in qaren-cli main.rs', usage !== undefined);
const verbs = new Set(
  [...(usage ?? '').matchAll(/\bqaren +([a-z][a-z-]*)/g)].map(([, verb]) => verb),
);
check('USAGE names verbs', verbs.size > 0);
const cliHtml = exists('cli/index.html') ? page('cli/index.html') : '';
for (const verb of verbs)
  check(`cli page has a qaren ${verb} section`, cliHtml.includes(`id="qaren-${verb}"`));

console.log('\nverify-site: skill drift');
const skills: string[] = (JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).skills ?? []).map(
  (path: string) => path.replace(/^\.\/skills\//, ''),
);
check('plugin manifest lists skills', skills.length > 0);
const pluginHtml = exists('plugin/index.html') ? page('plugin/index.html') : '';
for (const skill of skills)
  check(`plugin page names /qaren:${skill}`, pluginHtml.includes(`/qaren:${skill}`));

console.log('\nverify-site: no 1.x tool names');
const legacy = htmlFiles().filter(
  (file) =>
    !relative(DIST, file).startsWith('changelog/') &&
    /\b(?:cdp_[a-z]|device_(?!boot_seconds\b)[a-z])/.test(readFileSync(file, 'utf8')),
);
check('no page outside the changelog names a cdp_ or device_ tool', legacy.length === 0);
for (const file of legacy) console.error(`  1.x tool name in ${relative(DIST, file)}`);

if (failed > 0) {
  console.error(`\nverify-site: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nverify-site: all assertions passed');
