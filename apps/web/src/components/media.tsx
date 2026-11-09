'use client';

import { useEffect, useState } from 'react';
import { useResource } from '@quintara/app-core';
import { photoSrcSet, photoUrl } from '@quintara/domain';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
/** Images are served by the API; a data: address (offline mock) is used as it is. */
export const mediaUrl = (path: string) => (/^(data:|https?:)/.test(path) ? path : API_URL + path);

const fromApi = (path: string) => !/^(data:|https?:|blob:)/.test(path);

/**
 * A photograph at the quality the screen can show. The browser is offered every stored width and picks the
 * sharpest one for the space it fills and the screen's pixel density, so retina screens get full detail and
 * phones are not sent more than they need. `sizes` says how wide it is shown, as for <img sizes>.
 */
export function Photo({ path, sizes, alt = '', eager = false, ...rest }: { path: string; sizes: string; alt?: string; eager?: boolean } & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes' | 'alt'>) {
  return fromApi(path)
    ? <img {...rest} src={photoUrl(API_URL, path, 1440)} srcSet={photoSrcSet(API_URL, path)} sizes={sizes} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" />
    : <img {...rest} src={path} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" />;
}

/** A member's picture, or their initials when they have not added one. */
export function Avatar({ name, path, size = 56 }: { name: string; path: string | null; size?: number }) {
  const initials = name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  const style = { width: size, height: size, borderRadius: '50%', border: '1px solid var(--q-line)', flex: 'none' } as const;
  return path
    ? <Photo path={path} sizes={`${size}px`} style={{ ...style, objectFit: 'cover' }} />
    : <span aria-hidden="true" style={{ ...style, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--q-surface)', color: 'var(--q-muted)', fontFamily: 'var(--display)', fontSize: size * 0.36 }}>{initials}</span>;
}

/** The welcome area of the home page: photographs and films that take turns. Renders nothing when there are none. */
export function HomeSlides() {
  const slides = useResource((api) => api.listHomeSlides());
  const list = slides.data ?? [];
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (list.length < 2 || paused) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % list.length), 7000);
    return () => window.clearInterval(timer);
  }, [list.length, paused]);
  if (!list.length) return null;
  const slide = list[index % list.length]!;
  return (
    <figure className="cover" style={{ position: 'relative', padding: 0, overflow: 'hidden', margin: '0 0 2.5rem', minHeight: 'min(56vw, 30rem)' }} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      {slide.kind === 'image'
        ? <Photo key={slide.id} path={slide.src} alt={slide.caption} eager sizes="(max-width: 1200px) 100vw, 1200px" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        : <video key={slide.id} src={slide.src} aria-label={slide.caption || 'Film'} autoPlay muted loop playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
      {slide.caption ? <figcaption style={{ position: 'relative', marginTop: 'auto', padding: '3rem 1.5rem 1.2rem', background: 'linear-gradient(0deg, rgba(10,11,12,.85), transparent)', fontFamily: 'var(--display)', fontStyle: 'italic', fontSize: '1.5rem' }}>{slide.caption}</figcaption> : null}
      {list.length > 1 ? (
        <div className="row" style={{ position: 'absolute', right: 12, bottom: 12, gap: 6 }}>
          {list.map((item, i) => <button key={item.id} aria-label={`Show ${item.kind === 'image' ? 'photograph' : 'film'} ${i + 1}`} aria-pressed={i === index % list.length} onClick={() => setIndex(i)} style={{ width: 10, height: 10, padding: 0, borderRadius: '50%', border: '1px solid var(--q-ink)', background: i === index % list.length ? 'var(--q-ink)' : 'transparent', cursor: 'pointer' }} />)}
        </div>
      ) : null}
    </figure>
  );
}
