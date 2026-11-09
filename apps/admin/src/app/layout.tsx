import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { themeBootScript, themeStylesheet } from '@quintara/design-tokens';
import { AdminGate } from '@/lib/admin';
import './globals.css';

export const metadata: Metadata = { title: 'Quintara admin', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeStylesheet() }} />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400&family=Jost:wght@300;400;500&display=swap" />
      </head>
      <body><AdminGate>{children}</AdminGate></body>
    </html>
  );
}
