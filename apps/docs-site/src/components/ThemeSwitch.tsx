'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

/** Light/Dark switch; the choice is kept in localStorage and applied before paint by layout.tsx. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, []);

  function choose(next: Theme) {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('qaren-theme', next);
    } catch {
      // Private browsing can refuse storage; the switch still applies to this page.
    }
    setTheme(next);
  }

  return (
    <div className="docs-theme" role="group" aria-label="Theme">
      {(['light', 'dark'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={theme === value}
          onClick={() => choose(value)}
        >
          {value === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}
