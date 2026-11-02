import type { SideGroup } from '../design/DocsLayout.tsx';
import { BASE_PATH, groups, pagePath, type Page } from '../site.ts';

export function sideGroups(current?: Page): SideGroup[] {
  return groups.map((group) => ({
    label: group.label,
    items: [
      ...group.pages.map((page) => ({
        label: page.label,
        href: `${BASE_PATH}${pagePath(page.slug)}`,
        current: page === current,
      })),
      ...(group.links ?? []),
    ],
  }));
}
