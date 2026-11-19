'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * A filter kept in the page's address (?key=value), so the menu's shortcuts, the back button and shared links
 * all land on the same view. An empty value means "everything". Read inside a Suspense boundary.
 */
export function useQueryFilter<T extends string = string>(key: string, allowed?: readonly T[]): [T | '', (value: T | '') => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get(key) ?? '';
  // Without a fixed list (types that come from the data), any value is taken; the page shows nothing for an unknown one.
  const value = !allowed || (allowed as readonly string[]).includes(raw) ? (raw as T) : '';
  const set = (next: T | '') => {
    const query = new URLSearchParams(params.toString());
    if (next) query.set(key, next); else query.delete(key);
    const qs = query.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return [value, set];
}

/** A row of filters. The first option is usually "All" with the value ''. A count, when given, follows the label. */
export function FilterChips<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: readonly (readonly [value: T | '', text: string, count?: number])[];
  value: T | '';
  onChange: (value: T | '') => void;
}) {
  return (
    <div className="chips-row" role="group" aria-label={label}>
      {options.map(([key, text, count]) => (
        <button type="button" key={key || 'all'} className={`filter${key === value ? ' on' : ''}`} aria-pressed={key === value} onClick={() => onChange(key)}>
          {text}{count !== undefined ? <span className="count">{count}</span> : null}
        </button>
      ))}
    </div>
  );
}
