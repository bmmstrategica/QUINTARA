import type { NextConfig } from 'next';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const production = process.env.NODE_ENV === 'production';
/**
 * What the page may load and from where. Scripts only from this site (Next.js needs inline scripts for start-up;
 * eval only while developing), data only from the Quintara API, fonts from Google Fonts, never framed by anyone.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: blob: ${API}`,
  `media-src 'self' blob: https:`,
  `connect-src 'self' ${API}${production ? '' : ' ws: http://localhost:*'}`,
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ...(production ? ['upgrade-insecure-requests'] : []),
].join('; ');

const config: NextConfig = {
  transpilePackages: ['@quintara/api-client', '@quintara/design-tokens', '@quintara/domain'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Content-Security-Policy', value: contentSecurityPolicy },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ...(production ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }] : []),
      // Staff tools should never be indexed.
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ] }];
  },
};

export default config;
