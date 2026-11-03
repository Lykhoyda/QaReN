import createMDX from '@next/mdx';
import type { NextConfig } from 'next';
import { BASE_PATH } from './src/site.ts';

const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: {
    // .md (changelog, rn-flow-1) compiles as plain Markdown, .mdx as MDX.
    format: 'detect',
    // Strings, not functions: Turbopack needs serialisable loader options.
    remarkPlugins: ['remark-gfm', 'remark-frontmatter'],
    rehypePlugins: ['rehype-slug'],
  },
});

const config: NextConfig = {
  output: 'export',
  distDir: 'dist',
  trailingSlash: true,
  basePath: BASE_PATH,
  // Inlined so client components (search) see the same base path.
  env: { DOCS_BASE_PATH: BASE_PATH },
  images: { unoptimized: true },
  pageExtensions: ['ts', 'tsx'],
  // Next's built-in check needs the TypeScript 5 JS API; `bun run typecheck` runs tsc 7 instead.
  typescript: { ignoreBuildErrors: true },
  turbopack: { root: import.meta.dirname },
};

export default withMDX(config);
