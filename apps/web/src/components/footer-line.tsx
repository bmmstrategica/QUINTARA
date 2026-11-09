'use client';

import { useMarket } from '@quintara/app-core';

export function FooterLine() {
  const { market } = useMarket();
  return <span>A private membership.{market ? ` ${market.name}.` : ''}</span>;
}
