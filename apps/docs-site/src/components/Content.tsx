// Docs elements from the Elements board that content uses by name: callouts, steps and the
// setup prompt.
import type { ReactNode } from 'react';
import { AGENT_PROMPT } from '../agent-prompt.ts';
import { CopyButton } from './CopyButton.tsx';

const CALLOUT = { note: 'Note', caution: 'Caution', danger: 'Danger' } as const;

export function Callout({
  kind = 'note',
  children,
}: {
  kind?: keyof typeof CALLOUT;
  children: ReactNode;
}) {
  return (
    <aside aria-label={CALLOUT[kind]} className={`docs-callout docs-callout--${kind}`}>
      <span className="docs-callout__label">{CALLOUT[kind]}</span>
      <div className="docs-callout__body">{children}</div>
    </aside>
  );
}

/** Wraps an ordered list so its items render as numbered steps on a rail. */
export function Steps({ children }: { children: ReactNode }) {
  return <div className="docs-steps">{children}</div>;
}

export function AgentPrompt() {
  return (
    <figure className="docs-prompt" aria-label="Setup prompt for your agent" data-copy>
      <div className="docs-prompt__head">
        <span>Copy this prompt to your agent</span>
        <CopyButton label="Copy prompt" />
      </div>
      <pre tabIndex={0}>{AGENT_PROMPT}</pre>
    </figure>
  );
}
