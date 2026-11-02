import { DocsLayout } from '../design/DocsLayout.tsx';
import { Link } from '../design/index.tsx';
import { BASE_PATH, pagePath } from '../site.ts';
import { sideGroups } from './side-groups.ts';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <DocsLayout groups={sideGroups()} kicker="404" title="Page not found" searchable={false}>
      <p>
        This page does not exist. Start from{' '}
        <Link href={`${BASE_PATH}${pagePath('')}`}>Why QaReN</Link> or pick a page from the menu.
      </p>
    </DocsLayout>
  );
}
