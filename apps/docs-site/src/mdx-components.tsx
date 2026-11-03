import type { MDXComponents } from 'mdx/types';
import { Children, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { AgentPrompt, Callout, Steps } from './components/Content.tsx';
import { CopyButton } from './components/CopyButton.tsx';
import { BASE_PATH } from './site.ts';

// Root-relative links in content get the deployment base path; relative links stay as written.
function withBase(href?: string): string | undefined {
  if (!href?.startsWith('/') || href.startsWith('//') || !BASE_PATH) return href;
  return href === BASE_PATH || href.startsWith(`${BASE_PATH}/`) ? href : `${BASE_PATH}${href}`;
}

// Code is monochrome on the boards; only shell and YAML comment lines are muted.
function muteComments(lang: string, code: ReactNode): ReactNode {
  if ((lang !== 'sh' && lang !== 'yaml') || typeof code !== 'string') return code;
  return code
    .split('\n')
    .map((line, i) =>
      /^\s*#/.test(line) ? (
        <span key={i} className="docs-code-comment">
          {line}
        </span>
      ) : (
        line
      ),
    )
    .flatMap((line, i) => (i ? ['\n', line] : [line]));
}

const components: MDXComponents = {
  a: ({ href, children }: ComponentProps<'a'>) => <a href={withBase(href)}>{children}</a>,
  pre: ({ children }: ComponentProps<'pre'>) => {
    const code = Children.only(children) as ReactElement<ComponentProps<'code'>>;
    const lang = /language-(\w+)/.exec(code.props.className ?? '')?.[1] ?? 'text';
    return (
      <div className="docs-code" data-copy>
        <div className="docs-code__head" data-pagefind-ignore>
          <span>{lang}</span>
          <CopyButton />
        </div>
        <pre tabIndex={0}>
          <code>{muteComments(lang, code.props.children)}</code>
        </pre>
      </div>
    );
  },
  code: ({ children }: ComponentProps<'code'>) => <code className="docs-ic">{children}</code>,
  table: (props: ComponentProps<'table'>) => (
    <div className="docs-table">
      <table {...props} />
    </div>
  ),
  AgentPrompt,
  Callout,
  Steps,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
