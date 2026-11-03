'use client';

import { useState, type MouseEvent } from 'react';

/** Copies the text of the `pre` inside the nearest `[data-copy]` frame. */
export function CopyButton({ label = 'Copy' }: { label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    const pre = event.currentTarget.closest('[data-copy]')?.querySelector('pre');
    try {
      await navigator.clipboard.writeText(pre?.innerText.replace(/\n$/, '') ?? '');
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1600);
  }

  return (
    <button type="button" className="docs-copy" onClick={copy}>
      <span aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </span>
    </button>
  );
}
