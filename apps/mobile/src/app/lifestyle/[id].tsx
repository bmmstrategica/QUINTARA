import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useAction, useResource } from '@quintara/app-core';
import type { Privilege, Redemption } from '@quintara/domain';
import { ActionError, Body, Button, confirmThen, Divider, Heading, Muted, ResourceView, Screen, Tag, Title } from '@/components/ui';
import { useTheme } from '@/theme';

export default function PartnerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const partner = useResource((api) => api.getPartner(id), [id]);
  return (
    <Screen>
      <ResourceView resource={partner}>
        {(p) => (
          <>
            <Title>{p.name}</Title>
            <Muted>{p.category}{p.area ? `. ${p.area}` : ''}.</Muted>
            <Body>{p.summary}</Body>
            {p.description ? <Body>{p.description}</Body> : null}
            {p.offer ? <><Muted>They offer</Muted><Body>{p.offer}</Body></> : null}
            {p.contactName ? <><Muted>Focal point</Muted><Body>{p.contactName}</Body></> : null}
            {p.contactEmail ? <><Muted>Email</Muted><Body selectable>{p.contactEmail}</Body></> : null}
            {p.contactPhone ? <><Muted>Contact</Muted><Body selectable>{p.contactPhone}</Body></> : null}
            {p.address ? <><Muted>Location</Muted><Body>{p.address}</Body></> : null}
            <Divider />
            <Heading>Privileges for members</Heading>
            {p.privileges.length === 0 ? <Muted>Nothing on offer at the moment.</Muted> : null}
            {p.privileges.map((v) => <PrivilegeCard key={v.id} privilege={v} partnerName={p.name} />)}
            <Muted>Quintara shares nothing about you with a partner. The code is your proof of membership.</Muted>
          </>
        )}
      </ResourceView>
    </Screen>
  );
}

function PrivilegeCard({ privilege: v, partnerName }: { privilege: Privilege; partnerName: string }) {
  const { space } = useTheme();
  const redeem = useAction((api) => api.redeemPrivilege(v.id));
  const [issued, setIssued] = useState<Redemption | null>(null);
  const go = async () => { const result = await redeem.run(); if (result) setIssued(result); };
  return (
    <View style={{ gap: space.sm }}>
      <Body style={{ fontWeight: '500' }}>{v.title}</Body>
      <Body>{v.details}</Body>
      <Muted>{v.usesPerMember === 0 ? 'No limit on use' : v.usesPerMember === 1 ? 'Once per member' : `${v.usesPerMember} times per member, ${v.myUses} used`}. {v.terms}</Muted>
      {issued ? <Tag tone="accent" label={`Your code: ${issued.code}`} /> : null}
      {issued ? <Muted>Show it at {partnerName}. It is also kept under Lifestyle.</Muted> : null}
      <ActionError error={redeem.error} />
      {v.available && !issued ? <Button label="Get my code" busy={redeem.pending} onPress={() => (v.usesPerMember > 0 ? confirmThen('Use this privilege now?', 'This counts as one of your uses.', 'Get my code', go) : void go())} /> : null}
      {!v.available && !issued ? <Tag label={v.validUntil && v.validUntil < new Date().toISOString().slice(0, 10) ? 'Ended' : 'Used'} /> : null}
      <Divider />
    </View>
  );
}
