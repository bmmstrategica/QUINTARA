'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { useAction, useApi, useLive, useResource } from '@quintara/app-core';
import { ResourceView } from '@/components/states';
import { Composer, Thread, timeOf } from '@/components/thread';

export default function ConversationPage() {
  const { memberId } = useParams<{ memberId: string }>();
  const api = useApi();
  const thread = useResource((client) => client.getConversation(memberId), [memberId]);
  const send = useAction((client, body: string) => client.sendMessage(memberId, body));

  // New messages appear while the conversation is open (every few seconds, only while the page is visible).
  useLive(thread.refresh, 5000);
  // Opening the conversation, and each new message arriving while it is open, marks it as read.
  const count = thread.data?.messages.length ?? 0;
  useEffect(() => { if (thread.status === 'ready') void api.markConversationRead(memberId).catch(() => undefined); }, [api, memberId, thread.status, count]);

  return (
    <>
      <p><Link href="/messages" className="muted">All messages</Link></p>
      <ResourceView resource={thread}>
        {(data) => (
          <>
            <div className="head">
              <div><h2><Link href={`/members/${data.with.memberId}`} style={{ textDecoration: 'none' }}>{data.with.fullName}</Link></h2><p className="muted" style={{ margin: '0.4rem 0 0' }}>{data.with.position}, {data.with.company}</p></div>
            </div>
            <Thread empty="No messages yet." bubbles={data.messages.map((m) => ({ id: m.id, mine: m.mine, body: m.body, meta: timeOf(m.sentAt) }))} />
            {data.canSend
              ? <Composer label="Write a message" pending={send.pending} error={send.error} onSend={async (body) => { const ok = Boolean(await send.run(body)); if (ok) thread.refresh(); return ok; }} />
              : <p className="notice">Messaging opens once you are connected. <Link href={`/members/${data.with.memberId}`}>Open the profile to connect.</Link></p>}
          </>
        )}
      </ResourceView>
    </>
  );
}
