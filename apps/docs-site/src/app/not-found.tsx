import { DocsPage } from '../components/DocsPage.tsx';
import { BASE_PATH, pagePath } from '../site.ts';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <DocsPage title="Page not found" searchable={false}>
      <p>
        This page does not exist. Start from the{' '}
        <a href={`${BASE_PATH}${pagePath('')}`}>home page</a> or pick a page from the menu.
      </p>
    </DocsPage>
  );
}
