// Local stub of the design system's DocsLayout (DocsPage composition): sidebar groups,
// a 760px article column, the current item marked by surface-2 and weight.
import type { ReactNode } from 'react';

export type SideGroup = {
  label: string;
  items: { label: string; href: string; current?: boolean }[];
};

function SideNav({ groups }: { groups: SideGroup[] }) {
  return (
    <nav aria-label="Docs" className="qr-docs__side">
      {groups.map((group) => (
        <div key={group.label} className="qr-docs__group">
          <p className="label">{group.label}</p>
          <ul>
            {group.items.map((item) => (
              <li key={item.href}>
                <a href={item.href} aria-current={item.current ? 'page' : undefined}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function DocsLayout({
  groups,
  kicker,
  title,
  lead,
  searchable = true,
  children,
}: {
  groups: SideGroup[];
  kicker?: string;
  title: string;
  lead?: string;
  /** False keeps the page out of the search index. */
  searchable?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="qr-docs">
      {/* Phone width: the same nav behind a disclosure; only one of the two is ever displayed. */}
      <details className="qr-docs__toggle">
        <summary>Menu</summary>
        <SideNav groups={groups} />
      </details>
      <div className="qr-docs__side--wide">
        <SideNav groups={groups} />
      </div>
      <main id="main" className="qr-docs__main" data-pagefind-body={searchable ? '' : undefined}>
        {kicker ? <p className="label">{kicker}</p> : null}
        <h1 className="h1">{title}</h1>
        {lead ? <p className="lead">{lead}</p> : null}
        <div className="qr-prose">{children}</div>
      </main>
    </div>
  );
}
