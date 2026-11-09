import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { useAction, useResource } from '@quintara/app-core';
import { Body, Button, Field, Heading, Muted, ResourceView, Row, Screen, Tag } from '@/components/ui';
import { useTheme } from '@/theme';
import { useSection } from '@/components/section-copy';

export default function MembersScreen() {
  const club = useSection('club');
  const router = useRouter();
  const { color, space } = useTheme();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const members = useResource((api) => api.listMembers({ search: debounced }), [debounced]);

  return (
    <Screen>
      <Muted>{club.description}</Muted>
      <Field label="Search members" value={search} onChangeText={setSearch} placeholder="Name, company, industry or interest" autoCorrect={false} returnKeyType="search" />
      <Suggestions />
      <ResourceView resource={members} isEmpty={(list) => list.length === 0} empty={<Muted>No members match. Try a different search.</Muted>}>
        {(list) =>
          list.map((member) => (
            <Pressable
              key={member.id}
              accessibilityRole="button"
              accessibilityLabel={`${member.fullName}, ${member.position} at ${member.company}`}
              onPress={() => router.push({ pathname: '/member/[id]', params: { id: member.id } })}
              style={({ pressed }) => ({ paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.line, gap: space.xs, opacity: pressed ? 0.7 : 1 })}
            >
              <Body style={{ fontWeight: '500' }}>{member.fullName}</Body>
              <Muted>{member.position}, {member.company}. {member.city}.</Muted>
              {member.connection === 'connected' ? <Tag tone="positive" label="Connected" /> : null}
            </Pressable>
          ))
        }
      </ResourceView>
      <Blocked onChanged={members.reload} />
    </Screen>
  );
}

/** Members this person has blocked, with a way to undo it. Shown only when there are any. */
function Blocked({ onChanged }: { onChanged: () => void }) {
  const blocked = useResource((api) => api.listBlockedMembers());
  const unblock = useAction(async (api, id: string) => { await api.unblockMember(id); return true; });
  if (blocked.status !== 'ready' || blocked.data.length === 0) return null;
  return (
    <>
      <Heading>Blocked</Heading>
      {blocked.data.map((member) => (
        <Row key={member.id} title={member.fullName} detail="Cannot see your profile or contact you"
          trailing={<Button quiet label="Unblock" busy={unblock.pending} onPress={async () => { if (await unblock.run(member.id)) { blocked.reload(); onChanged(); } }} />} />
      ))}
    </>
  );
}

/** People to meet, with the reasons. Shown only when there are suggestions. */
function Suggestions() {
  const router = useRouter();
  const suggestions = useResource((api) => api.listSuggestions());
  const matching = useSection('matching');
  if (suggestions.status !== 'ready' || suggestions.data.length === 0) return null;
  return (
    <>
      <Heading>People to meet</Heading>
      <Muted>{matching.description}</Muted>
      {suggestions.data.map(({ member, reasons }) => <Row key={member.id} title={member.fullName} detail={reasons.join('. ') + '.'} onPress={() => router.push({ pathname: '/member/[id]', params: { id: member.id } })} />)}
    </>
  );
}
