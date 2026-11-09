'use client';

import { useEffect, useState } from 'react';
import { THEME_STORAGE_KEY } from '@quintara/design-tokens';

type Mode = 'dark' | 'light';

/** Switches between the dark (default) and light looks and remembers the choice on this device. */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>('dark');
  useEffect(() => {
    setMode(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  }, []);
  function choose(next: Mode) {
    setMode(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* the choice just will not be remembered */ }
  }
  return (
    <div className="theme-toggle" role="group" aria-label="Appearance">
      <button type="button" aria-pressed={mode === 'dark'} onClick={() => choose('dark')}>Dark</button>
      <button type="button" aria-pressed={mode === 'light'} onClick={() => choose('light')}>Light</button>
    </div>
  );
}
