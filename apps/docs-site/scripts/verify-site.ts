import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.DOCS_DIST ?? resolve(HERE, '../dist');
const MAIN_RS = resolve(HERE, '../../../packages/qaren-cli/src/main.rs');
const PLUGIN_JSON = resolve(HERE, '../../../packages/qaren-plugin/.claude-plugin/plugin.json');
const BASE = '/rn-dev-agent';
let failed = 0;

function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}`);
  }
}

function exists(relPath) {
  return existsSync(join(DIST, relPath));
}

function page(relPath) {
  return readFileSync(join(DIST, relPath), 'utf8');
}

function htmlFiles(dir = DIST) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

// KNOWN pre-existing broken references, skipped by the link check with a reason.
// Not introduced by this plan; remove an entry once the underlying asset ships.
const KNOWN_BROKEN = new Set();

function checkInternalLinks() {
  let broken = 0;
  for (const file of htmlFiles()) {
    const html = readFileSync(file, 'utf8');
    const pageUrl = `https://site${BASE}/${relative(DIST, dirname(file))}/`.replace(/\/+$/, '/');
    for (const [, href] of html.matchAll(/(?:href|src)="([^"#?]+)[#?]?[^"]*"/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
      const url = new URL(href, pageUrl).pathname.replace(/\/$/, '') || '/';
      if (url !== BASE && !url.startsWith(`${BASE}/`)) {
        broken += 1;
        console.error(`  link outside the site base ${url} in ${file.slice(DIST.length)}`);
        continue;
      }
      if (KNOWN_BROKEN.has(url)) continue;
      const rel = url === BASE ? '' : url.slice(BASE.length + 1);
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
      const target = rel === '' ? 'index.html' : join(rel, 'index.html');
      if (!exists(target) && !exists(rel)) {
        broken += 1;
        console.error(`  broken link ${url} in ${file.slice(DIST.length)}`);
      }
    }
  }
  check('no broken internal links or assets', broken === 0);
}

console.log('verify-site: pages');
check('dist exists (run `yarn build` first)', existsSync(DIST));
for (const slug of [
  '',
  'getting-started',
  'plans',
  'check',
  'pull-requests',
  'watch',
  'saved-blocks',
  'actions/rn-flow-1',
  'configuration',
  'cli',
  'troubleshooting',
  'plugin',
  'changelog',
]) {
  check(`${slug || 'index'} built`, exists(join(slug, 'index.html')));
}

console.log('\nverify-site: links');
checkInternalLinks();
const unbased = htmlFiles().filter((file) =>
  /href="\/(?!\/|rn-dev-agent(?:\/|"))/.test(readFileSync(file, 'utf8')),
);
check('internal links carry the base path', unbased.length === 0);
for (const file of unbased) console.error(`  link without base in ${relative(DIST, file)}`);

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
const skills = (JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).skills ?? []).map((path) =>
  path.replace(/^\.\/skills\//, ''),
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
