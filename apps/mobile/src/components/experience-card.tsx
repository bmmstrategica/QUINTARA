import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { ADMISSION_LABEL, formatDateTime } from '@quintara/domain';
import type { Experience } from '@quintara/domain';
import { Body, Muted, Tag } from '@/components/ui';
import { useTheme } from '@/theme';

/** One row of the calendar. The whole row is the touch target. */
export function ExperienceCard({ experience }: { experience: Experience }) {
  const router = useRouter();
  const { color, space, displayFont } = useTheme();
  // Guests and visitors are not sent dates or seat counts.
  const when = experience.startsAt ? formatDateTime(experience.startsAt, experience.timezone) : null;
  const seatsLeft = experience.capacity === null ? null : experience.capacity - (experience.seatsTaken ?? 0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${experience.title}, ${when ? `${when.long}, ` : ''}${experience.area}`}
      onPress={() => router.push({ pathname: '/experience/[id]', params: { id: experience.id } })}
      style={({ pressed }) => ({ flexDirection: 'row', gap: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.line, opacity: pressed ? 0.7 : 1 })}
    >
      <View style={{ width: 52 }}>
        {when ? <Text style={{ color: color.ink, fontFamily: displayFont, fontSize: 32, lineHeight: 34 }}>{when.day}</Text> : <Muted>Date</Muted>}
        <Muted>{when ? when.month : 'members'}</Muted>
      </View>
      <View style={{ flex: 1, gap: space.xs }}>
        <Text style={{ color: color.ink, fontFamily: displayFont, fontSize: 21, lineHeight: 26 }}>{experience.title}</Text>
        <Muted>{experience.summary}</Muted>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' }}>
          <Tag label={experience.category} />
          {experience.admission !== 'open' ? <Tag tone="accent" label={ADMISSION_LABEL[experience.admission]} /> : null}
        </View>
        <Body style={{ fontSize: 14 }}>{experience.area}{when ? `, ${when.time}` : ''}.{seatsLeft === null ? ' Date and seats for members.' : seatsLeft > 0 ? ` ${seatsLeft} seats left.` : ' Waitlist open.'}</Body>
      </View>
    </Pressable>
  );
}
