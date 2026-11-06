export type Page = {
  /** URL path under the base, without slashes; '' is the home page. */
  slug: string;
  /** Source file under src/content/docs. */
  file: string;
  /** Sidebar label. */
  label: string;
  /** The page's h1 and document title. */
  title: string;
  /** One line; `backticks` mark inline code, rendered as code under the title. */
  description: string;
};

export type Group = { label: string; pages: Page[]; links?: { label: string; href: string }[] };

export const SITE_NAME = 'QaReN';
export const SITE_DESCRIPTION =
  'QaReN is a QA engineer for your coding agent. It tries your React Native change on an iOS simulator and reports PASS or FAIL with the evidence.';
export const GITHUB_URL = 'https://github.com/Lykhoyda/QaReN';
export const X_URL = 'https://x.com/qaren_agent';

// The /QaReN base-path mode is only for GitHub Pages and is removed at the Vercel cutover.
export const BASE_PATH = process.env.DOCS_BASE_PATH ?? '';

const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
/** Absolute origin used for canonical URLs, the sitemap and the llms files. */
export const SITE_ORIGIN =
  process.env.DOCS_SITE_URL ?? (vercelHost ? `https://${vercelHost}` : 'http://localhost:3000');

export const groups: Group[] = [
  {
    label: 'Start here',
    pages: [
      {
        slug: '',
        file: 'index.mdx',
        label: 'Why QaReN',
        title: 'A QA engineer for your coding agent',
        description: SITE_DESCRIPTION,
      },
      {
        slug: 'getting-started',
        file: 'getting-started.mdx',
        label: 'Getting started',
        title: 'Getting started',
        description:
          'Install `qaren` and the QaReN plugin, run `/qaren:setup` and reach a first passing check.',
      },
      {
        slug: 'plugin',
        file: 'plugin.mdx',
        label: 'Use it from your agent',
        title: 'Use QaReN from your agent',
        description: "The QaReN plugin's three skills and what each host loads.",
      },
    ],
  },
  {
    label: 'How it works',
    pages: [
      {
        slug: 'cli',
        file: 'cli.mdx',
        label: 'The qaren CLI',
        title: 'The qaren CLI',
        description: 'Every `qaren` verb, its arguments and its flags.',
      },
      {
        slug: 'check',
        file: 'check.mdx',
        label: 'Check a plan',
        title: 'Check a plan',
        description:
          "Run `qaren check` against the working tree, read the receipt and find the run's evidence.",
      },
      {
        slug: 'pull-requests',
        file: 'pull-requests.mdx',
        label: 'Test a pull request',
        title: 'Test a pull request',
        description:
          "Walk a plan at a pull request's head with `qaren pr`, then post the result with `qaren publish`.",
      },
      {
        slug: 'plans',
        file: 'plans.mdx',
        label: 'Write a plan',
        title: 'Write a plan',
        description: 'The Markdown grammar `qaren` walks, and what a check reads from the screen.',
      },
      {
        slug: 'jev',
        file: 'jev.mdx',
        label: 'Jev: phrase judgments',
        title: 'Jev: how QaReN judges phrase steps',
        description:
          'When QaReN asks Jev to resolve a phrase or judge a check, what it can see, and how to run without a key.',
      },
      {
        slug: 'saved-blocks',
        file: 'saved-blocks.mdx',
        label: 'Saved blocks',
        title: 'Saved blocks',
        description:
          'How a passing block is saved, replayed on the next run, and patched when the app changes.',
      },
      {
        slug: 'actions/rn-flow-1',
        file: 'actions/rn-flow-1.md',
        label: 'rn-flow/1 replay dialect',
        title: 'rn-flow@1 replay dialect',
        description:
          'The contract for replaying saved actions — which Maestro-format commands compile, how selectors resolve, which domain runs each step, and the budgets every wait uses.',
      },
      {
        slug: 'configuration',
        file: 'configuration.mdx',
        label: 'Configuration',
        title: 'Configuration',
        description: 'Every key in `.qaren/config.yaml`, with its type, default and meaning.',
      },
      {
        slug: 'watch',
        file: 'watch.mdx',
        label: 'Watch a run',
        title: 'Watch a run',
        description: 'Follow a `qaren check` or `qaren pr` run live, locally or over ssh.',
      },
      {
        slug: 'troubleshooting',
        file: 'troubleshooting.mdx',
        label: 'Troubleshooting',
        title: 'Troubleshooting',
        description: 'The refusals and failures you meet most, and what to do about each.',
      },
    ],
  },
  {
    label: 'Project',
    pages: [
      {
        slug: 'changelog',
        file: 'changelog.md',
        label: 'Changelog',
        title: 'Changelog',
        description: 'Release history for QaReN',
      },
    ],
    links: [
      {
        label: 'Upgrading from rn-dev-agent 1.x',
        href: 'https://github.com/Lykhoyda/QaReN/blob/develop/packages/qaren-cli/README.md#upgrading-from-rn-dev-agent-1x-1014-to-20',
      },
    ],
  },
];

export const pages: Page[] = groups.flatMap((group) => group.pages);

/** Site-relative path of a page with the trailing slash every URL keeps. */
export function pagePath(slug: string): string {
  return slug ? `/${slug}/` : '/';
}

/** A description as plain text, for meta tags. */
export function plainDescription(page: Page): string {
  return page.description.replaceAll('`', '');
}

export function groupOf(page: Page): Group {
  return groups.find((group) => group.pages.includes(page))!;
}
