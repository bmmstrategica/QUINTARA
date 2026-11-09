/**
 * Quintara design tokens: the single source for colour, type and spacing.
 * Web turns these into CSS variables (toCssVariables); mobile reads them directly.
 * Palette from the brief: deep black, warm ivory, charcoal, soft stone, champagne.
 */
export interface Palette {
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  positive: string;
  critical: string;
  inverseBg: string;
  inverseInk: string;
  /** Raised areas: cover panels, cards, side bars. */
  raise: string;
  glow: string;
  cardTop: string;
  side: string;
  track: string;
}

export type ThemeName = 'light' | 'dark';

export const palettes: Record<ThemeName, Palette> = {
  // Light: pure white ground, warm ivory surfaces, near-black type, deep forest accent.
  light: {
    bg: '#FFFFFF',
    surface: '#F7F6F2',
    ink: '#161616',
    muted: '#686868',
    line: '#E5E2DB',
    accent: '#183C32',
    positive: '#2F6B4F',
    critical: '#8F3F3F',
    inverseBg: '#111111',
    inverseInk: '#FFFFFF',
    raise: '#F7F6F2',
    glow: '#EFEDE6',
    cardTop: '#FFFFFF',
    side: '#F7F6F2',
    track: '#E5E2DB',
  },
  // The brand theme: near-black ground, ivory type, champagne accent.
  dark: {
    bg: '#0A0B0C',
    surface: '#16181A',
    ink: '#F4F0E6',
    muted: '#A49D8F',
    line: '#2A2D31',
    accent: '#C9AB72',
    positive: '#93C4AB',
    critical: '#DDA0A0',
    inverseBg: '#F4F0E6',
    inverseInk: '#0A0B0C',
    raise: '#101113',
    glow: '#24211b',
    cardTop: '#1F2225',
    side: '#0c0d0e',
    track: '#1F2225',
  },
};

/** Spacing scale in density-independent pixels (also used as px on web). */
export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 40, xxl: 64 } as const;

export const radius = { sm: 2, md: 6, pill: 999 } as const;

export const fontFamily = {
  display: '"Cormorant Garamond", "Cormorant", Georgia, serif',
  body: '"Jost", "Helvetica Neue", Arial, sans-serif',
} as const;

/** Type scale: size / line height. */
export const type = {
  display: { size: 44, lineHeight: 48 },
  title: { size: 28, lineHeight: 32 },
  heading: { size: 21, lineHeight: 26 },
  body: { size: 16, lineHeight: 25 },
  small: { size: 14, lineHeight: 20 },
  caption: { size: 12.5, lineHeight: 16 },
} as const;

const cssName = (key: string) => '--q-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/** CSS custom properties for one palette, e.g. `--q-bg:#F6F2EA;--q-inverse-bg:#0A0A0A;` */
export function toCssVariables(theme: ThemeName): string {
  return Object.entries(palettes[theme])
    .map(([key, value]) => `${cssName(key)}:${value};`)
    .join('');
}

export const THEME_STORAGE_KEY = 'quintara.theme';

/**
 * Stylesheet for web apps: dark is the default (the brand look); `data-theme="light"` on <html> switches to light.
 */
export function themeStylesheet(): string {
  // Image-led panels (covers, the membership card) keep the dark treatment in light, so they look the same in both.
  return `:root{color-scheme:dark;${toCssVariables('dark')}}:root[data-theme="light"]{color-scheme:light;${toCssVariables('light')}}:root[data-theme="light"] :is(.cover,.card){${toCssVariables('dark')}color:var(--q-ink);}`;
}

/** Runs before first paint so there is no flash: applies the saved choice, defaulting to dark. */
export const themeBootScript = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
