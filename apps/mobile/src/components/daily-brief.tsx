import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import type { BriefItem, BriefLink, DailyBrief, DailyItem } from '@quintara/domain';
import { useTheme } from '@/theme';

const SOURCE: Record<DailyItem['source'], string> = { calendar: 'YOUR CALENDAR', quintara: 'QUINTARA', reminder: 'REMINDER' };

/** Where a line of the brief leads in the mobile app. */
function route(link: BriefLink | null): string | null {
  if (!link) return null;
  if (link.kind === 'experience' && link.id) return `/experience/${link.id}`;
  if (link.kind === 'bookings') return '/bookings';
  if (link.kind === 'business') return '/business';
  if (link.kind === 'boutique') return '/boutique';
  if (link.kind === 'service') return '/lifestyle';
  if (link.kind === 'memory') return '/memory';
  if (link.kind === 'calendar') return '/calendar';
  if (link.kind === 'document' && link.id) return `/document/${link.id}`;
  return '/qera';
}

/** QÉRA's daily brief, set like a note from a chief of staff: the day in order, then one thought. */
export function DailyBriefCard({ brief }: { brief: DailyBrief }) {
  const router = useRouter();
  const { color, space, radius, displayFont } = useTheme();
  const label = (text: string) => <Text style={{ color: color.muted, fontSize: 10.5, letterSpacing: 3, marginBottom: space.sm }}>{text}</Text>;
  const go = (link: BriefLink | null) => { const to = route(link); if (to) router.push(to as never); };
  const line = (item: BriefItem, k: number) => (
    <Pressable key={k} accessibilityRole="button" onPress={() => go(item.link)} style={{ paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.line }}>
      <Text style={{ color: color.ink, fontSize: 15 }}>{item.title}</Text>
      <Text style={{ color: color.muted, fontSize: 13 }}>{item.detail}</Text>
    </Pressable>
  );
  return (
    <View accessibilityLabel="Your daily brief" style={{ borderWidth: 1, borderColor: color.line, borderTopColor: color.accent, borderTopWidth: 2, borderRadius: radius.md, padding: space.lg, backgroundColor: color.raise, gap: space.md }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: space.xs }}>
        <Text style={{ color: color.accent, fontSize: 10.5, letterSpacing: 3 }}>QÉRA · DAILY BRIEF</Text>
        <Text style={{ color: color.muted, fontSize: 10.5, letterSpacing: 2 }}>{brief.dateLabel.toUpperCase()}{brief.city ? ` · ${brief.city.toUpperCase()}` : ''}</Text>
      </View>
      <Text accessibilityRole="header" style={{ color: color.ink, fontFamily: displayFont, fontStyle: 'italic', fontSize: 34, lineHeight: 38 }}>{brief.greeting}</Text>
      <Text style={{ color: color.muted, fontSize: 15, lineHeight: 22 }}>{brief.summary}</Text>
      <View>
        {label('TODAY')}
        {brief.agenda.length === 0 ? <Text style={{ color: color.muted, fontFamily: displayFont, fontStyle: 'italic', fontSize: 18 }}>Nothing is planned. A good day to keep open.</Text> : null}
        {brief.agenda.map((item, k) => (
          <Pressable key={k} accessibilityRole={item.link ? 'button' : undefined} onPress={() => go(item.link)} style={{ flexDirection: 'row', gap: space.md, paddingVertical: space.sm }}>
            <View style={{ width: 54 }}>
              <Text style={{ color: color.ink, fontFamily: displayFont, fontSize: 20 }}>{item.time ?? 'All day'}</Text>
              {item.endTime ? <Text style={{ color: color.muted, fontSize: 11 }}>{item.endTime}</Text> : null}
            </View>
            <View style={{ width: 9, height: 9, marginTop: 8, borderRadius: item.source === 'reminder' ? 1 : 5, borderWidth: 1, borderColor: item.source === 'calendar' ? color.muted : color.accent, backgroundColor: item.source === 'quintara' ? color.accent : 'transparent', transform: item.source === 'reminder' ? [{ rotate: '45deg' }] : [] }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: color.ink, fontSize: 15 }}>{item.title}</Text>
              {item.detail ? <Text style={{ color: color.muted, fontSize: 13 }}>{item.detail}</Text> : null}
              <Text style={{ color: item.source === 'quintara' ? color.accent : color.muted, fontSize: 9.5, letterSpacing: 2.4, marginTop: 2 }}>{SOURCE[item.source]}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      {brief.suggestion ? (
        <Pressable accessibilityRole="button" onPress={() => go(brief.suggestion!.link)} style={{ borderWidth: 1, borderColor: color.accent, borderRadius: radius.sm, padding: space.md, gap: space.xs }}>
          <Text style={{ color: color.accent, fontSize: 10.5, letterSpacing: 3 }}>QÉRA SUGGESTS</Text>
          <Text style={{ color: color.ink, fontFamily: displayFont, fontStyle: 'italic', fontSize: 21 }}>{brief.suggestion.title}</Text>
          <Text style={{ color: color.muted, fontSize: 14, lineHeight: 20 }}>{brief.suggestion.detail}</Text>
        </Pressable>
      ) : null}
      {brief.waiting.length ? <View>{label('WAITING ON YOU')}{brief.waiting.map(line)}</View> : null}
      {brief.ahead.length ? <View>{label('AHEAD THIS WEEK')}{brief.ahead.map(line)}</View> : null}
      <Pressable accessibilityRole="link" onPress={() => router.push('/calendar')} style={{ borderTopWidth: 1, borderTopColor: color.line, paddingTop: space.sm }}>
        <Text style={{ color: color.muted, fontSize: 12.5 }}>{brief.calendar.connected ? `From your ${brief.calendar.label}${brief.calendar.showTitles ? '' : ', busy times only'}. Manage` : 'Connect your calendar and your own meetings appear here. Connect a calendar'}</Text>
      </Pressable>
    </View>
  );
}
