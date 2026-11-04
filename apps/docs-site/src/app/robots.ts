import type { MetadataRoute } from 'next';
import { BASE_PATH, SITE_ORIGIN } from '../site.ts';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: `${SITE_ORIGIN}${BASE_PATH}/sitemap.xml`,
  };
}
