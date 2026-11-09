'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useApi, usePermission, useResource } from '@quintara/app-core';
import { formatDuration } from '@quintara/domain';
import type { TvEpisode } from '@quintara/domain';
import { ResourceView } from '@/components/states';
import { useSection } from '@/components/section-copy';

export default function TvPage() {
  const series = useResource((api) => api.listTvSeries());
  const [playing, setPlaying] = useState<TvEpisode | null>(null);
  const intro = useSection('tv');
  return (
    <>
      <div className="head"><div><h2>Quintara TV</h2><p className="lede">{intro.description}</p></div></div>
      {playing ? <Player episode={playing} onClose={() => { setPlaying(null); series.reload(); }} /> : null}
      <ResourceView resource={series} isEmpty={(list) => list.length === 0} empty={<p className="muted">The first series is in production.</p>}>
        {(list) => list.map((s) => (
          <section key={s.id} style={{ marginBottom: '2.5rem' }}>
            <div className="cover" style={{ minHeight: '11rem', marginBottom: '0.5rem' }}><span className="tag">Series</span><h1 style={{ fontSize: 'clamp(2rem, 4vw, 3rem)' }}>{s.title}</h1><p className="lede" style={{ margin: 0 }}>{s.summary}</p></div>
            {s.episodes.map((e) => <EpisodeRow key={e.id} episode={e} active={playing?.id === e.id} onPlay={() => { setPlaying(e); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />)}
          </section>
        ))}
      </ResourceView>
    </>
  );
}

function EpisodeRow({ episode: e, active, onPlay }: { episode: TvEpisode; active: boolean; onPlay: () => void }) {
  const percent = e.completed ? 100 : Math.round((e.positionSeconds / e.durationSeconds) * 100);
  return (
    <article className="item-row">
      <div><div className="date-day">{e.number}</div><div className="date-month">Episode</div></div>
      <div>
        <h3>{e.title}</h3>
        <p>{e.summary}</p>
        <div className="facts row">
          <span>{formatDuration(e.durationSeconds)}.</span>
          {e.audience === 'public' ? <span className="tag">Open to all</span> : <span className="tag accent">Members</span>}
          {e.completed ? <span className="tag positive">Watched</span> : percent > 0 ? <span className="muted">{percent}% watched</span> : null}
        </div>
        {percent > 0 && !e.completed ? <div aria-hidden="true" style={{ height: 2, background: 'var(--q-line)', marginTop: '0.6rem', maxWidth: '22rem' }}><div style={{ height: 2, width: `${percent}%`, background: 'var(--q-accent)' }} /></div> : null}
      </div>
      <div className="actions">
        {e.locked ? <Link className="btn quiet small" href="/apply">For members</Link>
          : e.videoUrl ? <button className="btn small" disabled={active} onClick={onPlay}>{active ? 'Playing' : e.positionSeconds > 0 && !e.completed ? 'Continue' : 'Play'}</button>
          : <span className="tag">Coming soon</span>}
      </div>
    </article>
  );
}

/** Plays one episode, starting where the member stopped and remembering their place every few seconds. */
function Player({ episode, onClose }: { episode: TvEpisode; onClose: () => void }) {
  const api = useApi();
  const canSave = usePermission('tv.watch');
  const video = useRef<HTMLVideoElement>(null);
  const saved = useRef(episode.positionSeconds);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const save = () => {
      // The sample clip is shorter than the episode it stands in for, so scale its position to the episode's length.
      const share = element.duration ? element.currentTime / element.duration : 0;
      const position = Math.round(share * episode.durationSeconds);
      if (!canSave || Math.abs(position - saved.current) < 5) return;
      saved.current = position;
      void api.saveTvProgress(episode.id, position).catch(() => undefined);
    };
    const start = () => { if (!episode.completed && episode.positionSeconds > 0 && element.duration) element.currentTime = (episode.positionSeconds / episode.durationSeconds) * element.duration; };
    const timer = setInterval(save, 5000);
    element.addEventListener('loadedmetadata', start);
    element.addEventListener('pause', save);
    element.addEventListener('ended', save);
    return () => { clearInterval(timer); save(); element.removeEventListener('loadedmetadata', start); element.removeEventListener('pause', save); element.removeEventListener('ended', save); };
  }, [api, canSave, episode]);

  return (
    <section aria-label={`Now playing: ${episode.title}`} style={{ marginBottom: '2rem' }}>
      <video ref={video} key={episode.id} src={episode.videoUrl ?? undefined} controls autoPlay playsInline style={{ width: '100%', maxHeight: '70vh', background: '#000', borderRadius: 6, border: '1px solid var(--q-line)' }} />
      <div className="row" style={{ justifyContent: 'space-between', marginTop: '0.8rem' }}>
        <div><strong style={{ fontWeight: 500 }}>Episode {episode.number}. {episode.title}</strong>{canSave ? null : <div className="muted" style={{ fontSize: '0.9rem' }}>Members keep their place across devices.</div>}</div>
        <button className="btn quiet small" onClick={onClose}>Close</button>
      </div>
    </section>
  );
}
