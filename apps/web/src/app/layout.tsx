import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { themeBootScript, themeStylesheet } from '@quintara/design-tokens';
import { Header } from '@/components/header';
import { Providers } from './providers';
import './globals.css';
import { FooterLine } from '@/components/footer-line';
import { SecondStepGate } from '@/components/two-factor';
import { LapsedGate } from '@/components/membership';

export const metadata: Metadata = {
  title: { default: 'Quintara', template: '%s | Quintara' },
  description: 'A private membership for founders, investors, creatives and executives.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

// Dark is the brand look and the default; members can switch to light (saved on their device). Values come from the shared tokens.
const themeCss = themeStylesheet();

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeCss }} />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400;1,500&family=Jost:wght@300;400;500&display=swap"
        />
      </head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <Providers>
          <Header />
          <main id="main"><SecondStepGate><LapsedGate>{children}</LapsedGate></SecondStepGate></main>
          <footer><img src="/quintara-wordmark.png" alt="Quintara" height={12} /><FooterLine /></footer>
        </Providers>
      </body>
    </html>
  );
}
