import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Maison Quintara',
  description: 'Pieces made in Cape Town and beyond by Quintara, its members and the ateliers it works with.',
  icons: { icon: '/quintara-emblem.png' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#16302B' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400;0,6..96,500;1,6..96,400&family=Cinzel:wght@600&family=Jost:wght@300;400;500&display=swap" />
      </head>
      <body>
        <a className="skip" href="#collection">Skip to the collection</a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
