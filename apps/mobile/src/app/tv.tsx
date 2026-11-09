import { Linking, View } from 'react-native';
import { useApi, usePermission, useResource } from '@quintara/app-core';
import { formatDuration } from '@quintara/domain';
import type { TvEpisode } from '@quintara/domain';
import { Body, Button, Divider, Heading, Muted, ResourceView, Screen, Tag, Title } from '@/components/ui';
import { useTheme } from '@/theme';
import { useSection } from '@/components/section-copy';

export default function TvScreen() {
  const series = useResource((api) => api.listTvSeries());
  const intro = useSection('tv');
  return (
    <Screen onRefresh={series.reload} refreshing={series.status === 'loading'}>
      <Title>Quintara TV</Title>
      <Muted>{intro.description}</Muted>
      <ResourceView resource={series} isEmpty={(list) => list.length === 0} empty={<Muted>The first series is in production.</Muted>}>
        {(list) => list.map((s) => (
          <View key={s.id} style={{ gap: 12 }}>
            <Heading>{s.title}</Heading>
            <Muted>{s.summary}</Muted>
            {s.episodes.map((e) => <EpisodeCard key={e.id} episode={e} onWatched={series.reload} />)}
          </View>
        ))}
      </ResourceView>
    </Screen>
  );
}

function EpisodeCard({ episode: e, onWatched }: { episode: TvEpisode; onWatched: () => void }) {
  const { space } = useTheme();
  const api = useApi();
  const canSave = usePermission('tv.watch');
  // Playback opens in the phone's own player for now. An in-app player with resume arrives with the video host.
  const play = async () => {
    if (!e.videoUrl) return;
    await Linking.openURL(e.videoUrl);
    if (canSave && e.positionSeconds === 0) { await api.saveTvProgress(e.id, 1).catch(() => undefined); onWatched(); }
  };
  return (
    <View style={{ gap: space.sm }}>
      <Body style={{ fontWeight: '500' }}>{e.number}. {e.title}</Body>
      <Body>{e.summary}</Body>
      <Muted>{formatDuration(e.durationSeconds)}. {e.audience === 'public' ? 'Open to all.' : 'For members.'}</Muted>
      {e.completed ? <Tag tone="positive" label="Watched" /> : e.positionSeconds > 0 ? <Tag tone="accent" label="Started" /> : null}
      {e.locked ? <Tag label="For members" /> : e.videoUrl ? <Button label={e.positionSeconds > 0 && !e.completed ? 'Continue' : 'Play'} onPress={() => { void play(); }} /> : <Tag label="Coming soon" />}
      <Divider />
    </View>
  );
}
