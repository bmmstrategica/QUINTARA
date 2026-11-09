'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { createHttpApi, createMockApi } from '@quintara/api-client';
import type { QuintaraApi } from '@quintara/api-client';
import { QuintaraProvider } from '@quintara/app-core';

/**
 * The same API as the Quintara apps and the admin console: the pieces, prices, stock, orders and wishlists are one
 * set of data. With NEXT_PUBLIC_API_URL set the shop talks to the real API; otherwise to the offline mock.
 */
function createApi(): QuintaraApi {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL;
  if (baseUrl) return createHttpApi({ baseUrl });
  return createMockApi({ storage: typeof window === 'undefined' ? undefined : window.localStorage });
}

export function Providers({ children }: { children: ReactNode }) {
  const [api] = useState(createApi);
  return <QuintaraProvider api={api}>{children}</QuintaraProvider>;
}
