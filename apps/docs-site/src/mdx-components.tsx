import type { MDXComponents } from 'mdx/types';
import { Children, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { InlineCode, Link } from './design/index.tsx';
import { BASE_PATH } from './site.ts';

// Root-relative links in content get the deployment base path; relative links stay as written.
function withBase(href?: string): string | undefined {
  if (!href?.startsWith('/') || href.startsWith('//') || !BASE_PATH) return href;
  return href === BASE_PATH || href.startsWith(`${BASE_PATH}/`) ? href : `${BASE_PATH}${href}`;
}

const components: MDXComponents = {
  a: ({ href, children }: ComponentProps<'a'>) => <Link href={withBase(href)}>{children}</Link>,
  // Code is monochrome by design rule, so fences carry no highlighting; `pre` unwraps the inline style.
  pre: ({ children }: ComponentProps<'pre'>) => {
    const code = Children.only(children) as ReactElement<{ children: ReactNode }>;
    return (
      <div className="qr-codeblock">
        <pre>
          <code>{code.props.children}</code>
        </pre>
      </div>
    );
  },
  code: ({ children }: ComponentProps<'code'>) => <InlineCode>{children}</InlineCode>,
  table: (props: ComponentProps<'table'>) => (
    <div className="qr-table-wrap">
      <table className="qr-table" {...props} />
    </div>
  ),
};

export function useMDXComponents(): MDXComponents {
  return components;
}
