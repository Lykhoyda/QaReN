import type { Metadata, ResolvingMetadata } from 'next';
import { notFound } from 'next/navigation';
import { content } from '../../content.ts';
import { DocsLayout } from '../../design/DocsLayout.tsx';
import { BASE_PATH, groupOf, pages, pagePath, type Page } from '../../site.ts';
import { sideGroups } from '../side-groups.ts';

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
  const { default: Content } = await content[page.file]();
  return (
    <DocsLayout
      groups={sideGroups(page)}
      kicker={groupOf(page).label}
      title={page.title}
      lead={page.description}
    >
      <Content />
    </DocsLayout>
  );
}
