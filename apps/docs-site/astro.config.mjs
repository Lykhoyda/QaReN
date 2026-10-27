import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import remarkGfm from 'remark-gfm';

export default defineConfig({
  markdown: { remarkPlugins: [remarkGfm] },
  site: 'https://lykhoyda.github.io',
  base: '/QaReN',
  integrations: [
    starlight({
      plugins: [starlightLlmsTxt()],
      title: 'QaReN',
      description:
        'QaReN is a QA engineer for your coding agent. It tries your React Native change on an iOS simulator and reports PASS or FAIL with the evidence.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Lykhoyda/QaReN' }],
      head: [
        {
          tag: 'meta',
          attrs: {
            name: 'keywords',
            content:
              'react native, qa, qa agent, expo, ios simulator, test plan, pull request, claude code, codex',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: 'https://lykhoyda.github.io/QaReN/og-image.png',
          },
        },
        { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'QaReN',
            description:
              'QaReN is a QA engineer for your coding agent. It tries your React Native change on an iOS simulator and reports PASS or FAIL with the evidence.',
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'macOS',
            url: 'https://lykhoyda.github.io/QaReN/',
            author: {
              '@type': 'Person',
              name: 'Anton Lykhoyda',
              url: 'https://github.com/Lykhoyda',
            },
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          }),
        },
      ],
      components: {
        ThemeSelect: './src/components/ThemeSelect.astro',
        ThemeProvider: './src/components/ThemeProvider.astro',
        PageTitle: './src/components/PageTitle.astro',
      },
      customCss: ['./src/styles/custom.css'],
      expressiveCode: {
        themes: ['github-dark'],
        styleOverrides: {
          borderColor: 'var(--sl-color-gray-5)',
          borderRadius: '8px',
          frames: {
            terminalTitlebarBackground: 'var(--sl-color-gray-6)',
            terminalTitlebarBorderBottomColor: 'var(--sl-color-gray-5)',
          },
        },
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Why QaReN', slug: 'index' },
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'Use it from your agent', slug: 'plugin' },
          ],
        },
        {
          label: 'How it works',
          items: [
            { label: 'The qaren CLI', slug: 'cli' },
            { label: 'Check a plan', slug: 'check' },
            { label: 'Test a pull request', slug: 'pull-requests' },
            { label: 'Write a plan', slug: 'plans' },
            { label: 'Saved blocks', slug: 'saved-blocks' },
            { label: 'rn-flow/1 replay dialect', slug: 'actions/rn-flow-1' },
            { label: 'Configuration', slug: 'configuration' },
            { label: 'Watch a run', slug: 'watch' },
            { label: 'Troubleshooting', slug: 'troubleshooting' },
          ],
        },
        {
          label: 'Project',
          items: [{ label: 'Changelog', slug: 'changelog' }],
        },
      ],
    }),
  ],
});
