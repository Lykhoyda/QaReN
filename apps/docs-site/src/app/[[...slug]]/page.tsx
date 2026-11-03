import type { Metadata, ResolvingMetadata } from 'next';
import { notFound } from 'next/navigation';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DocsPage } from '../../components/DocsPage.tsx';
import { Home } from '../../components/Home.tsx';
import { content } from '../../content.ts';
import { BASE_PATH, pages, pagePath, type Page } from '../../site.ts';
import { tableOfContents } from '../../toc.ts';

type Props = { params: Promise<{ slug?: string[] }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return pages.map((page) => ({ slug: page.slug ? page.slug.split('/') : [] }));
}

async function pageFor(props: Props): Promise<Page> {
  const slug = ((await props.params).slug ?? []).join('/');
  return pages.find((page) => page.slug === slug) ?? notFound();
}

export async function generateMetadata(props: Props, parent: ResolvingMetadata): Promise<Metadata> {
  const page = await pageFor(props);
  const url = `${BASE_PATH}${pagePath(page.slug)}`;
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: url },
    openGraph: {
      ...(await parent).openGraph,
      title: page.title,
      description: page.description,
      url,
    },
  };
}

export default async function DocPage(props: Props) {
  const page = await pageFor(props);
  if (page.slug === '') return <Home />;
  const { default: Content } = await content[page.file]();
  const source = readFileSync(join(process.cwd(), 'src/content/docs', page.file), 'utf8');
  return (
    <DocsPage
      current={page}
      title={page.title}
      description={page.description}
      toc={tableOfContents(source)}
    >
      <Content />
    </DocsPage>
  );
}
