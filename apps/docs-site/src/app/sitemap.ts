import type { MetadataRoute } from 'next';
import { BASE_PATH, SITE_ORIGIN, pagePath, pages } from '../site.ts';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return pages.map((page) => ({ url: `${SITE_ORIGIN}${BASE_PATH}${pagePath(page.slug)}` }));
}
