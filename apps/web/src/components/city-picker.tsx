'use client';

import { useMarket } from '@quintara/app-core';

/** Switches the city the app shows. Only the location icon is shown; choosing it opens the list of cities. */
export function CityPicker() {
  const { markets, market, setMarket } = useMarket();
  if (markets.length < 2 || !market) return null;
  return (
    <label className="city-picker" title={`City: ${market.name}`}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21Z" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="12" cy="9.8" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      <select value={market.slug} onChange={(event) => setMarket(event.target.value)} aria-label={`City: ${market.name}. Choose a city`}>
        {markets.map((m) => <option key={m.id} value={m.slug}>{m.name}</option>)}
      </select>
    </label>
  );
}
