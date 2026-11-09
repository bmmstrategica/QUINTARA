'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { createHttpApi, createMockApi } from '@quintara/api-client';
import type { QuintaraApi } from '@quintara/api-client';
import { QuintaraProvider } from '@quintara/app-core';

/**
 * Chooses the API implementation once per page load.
 * With NEXT_PUBLIC_API_URL set, the app talks to the real API; otherwise it
 * runs on the mock, persisted in localStorage so a reload keeps your place.
 */
function createApi(): QuintaraApi {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL;
  if (baseUrl) {
    // The session lives in an HttpOnly cookie set by the API, so no token is handled in the browser.
    return createHttpApi({ baseUrl });
  }
  return createMockApi({ storage: typeof window === 'undefined' ? undefined : window.localStorage });
}

const MARKET_KEY = 'quintara.market';
const readMarket = () => { try { return typeof window === 'undefined' ? null : window.localStorage.getItem(MARKET_KEY); } catch { return null; } };
const saveMarket = (slug: string | null) => { try { if (slug) window.localStorage.setItem(MARKET_KEY, slug); else window.localStorage.removeItem(MARKET_KEY); } catch { /* private browsing: the choice lasts this visit */ } };

export function Providers({ children }: { children: ReactNode }) {
  const [api] = useState(createApi);
  const [initial] = useState(readMarket);
  return <QuintaraProvider api={api} initialMarket={initial} onMarketChange={saveMarket}>{children}</QuintaraProvider>;
}
