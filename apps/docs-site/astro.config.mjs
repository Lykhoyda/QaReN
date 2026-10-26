import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import remarkGfm from 'remark-gfm';

export default defineConfig({
  markdown: { remarkPlugins: [remarkGfm] },
  site: 'https://lykhoyda.github.io',
  base: '/rn-dev-agent',
  integrations: [
    starlight({
      plugins: [starlightLlmsTxt()],
      title: 'QaReN',
      description:
        'QaReN walks a plan on the simulator or emulator, records the run, and reports PASS/FAIL with video.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Lykhoyda/rn-dev-agent' },
      ],
      head: [
        {
          tag: 'meta',
          attrs: {
            name: 'keywords',
            content:
              'react native, qa, expo, ios simulator, android emulator, test plan, pull request, video, claude code, codex, cursor',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: 'https://lykhoyda.github.io/rn-dev-agent/og-image.png',
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
              'QaReN walks a plan on the simulator or emulator, records the run, and reports PASS/FAIL with video.',
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'macOS',
            url: 'https://lykhoyda.github.io/rn-dev-agent/',
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
            { label: 'What QaReN does', slug: 'index' },
            { label: 'Getting started', slug: 'getting-started' },
          ],
        },
        {
          label: 'Using QaReN',
          items: [
            { label: 'Write a plan', slug: 'plans' },
            { label: 'Check a plan', slug: 'check' },
            { label: 'Test a pull request', slug: 'pull-requests' },
            { label: 'Watch a run', slug: 'watch' },
            { label: 'Saved blocks', slug: 'saved-blocks' },
            { label: 'rn-flow/1 replay dialect', slug: 'actions/rn-flow-1' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration', slug: 'configuration' },
            { label: 'CLI', slug: 'cli' },
            { label: 'Troubleshooting', slug: 'troubleshooting' },
            { label: 'Plugin', slug: 'plugin' },
            { label: 'Changelog', slug: 'changelog' },
          ],
        },
      ],
    }),
  ],
});
