import type { MDXContent } from 'mdx/types';

type Loader = () => Promise<{ default: MDXContent }>;

// Keyed by Page.file in site.ts; static imports so the bundler compiles each page.
export const content: Record<string, Loader> = {
  'getting-started.mdx': () => import('./content/docs/getting-started.mdx'),
  'plugin.mdx': () => import('./content/docs/plugin.mdx'),
  'pull-requests.mdx': () => import('./content/docs/pull-requests.mdx'),
  'plans.mdx': () => import('./content/docs/plans.mdx'),
  'saved-blocks.mdx': () => import('./content/docs/saved-blocks.mdx'),
  'configuration.mdx': () => import('./content/docs/configuration.mdx'),
  'cli.mdx': () => import('./content/docs/cli.mdx'),
  'check.mdx': () => import('./content/docs/check.mdx'),
  'watch.mdx': () => import('./content/docs/watch.mdx'),
  'troubleshooting.mdx': () => import('./content/docs/troubleshooting.mdx'),
  'actions/rn-flow-1.md': () => import('./content/docs/actions/rn-flow-1.md'),
  'changelog.md': () => import('./content/docs/changelog.md'),
};
