'use client';

import Link from 'next/link';
import { useLive, useResource } from '@quintara/app-core';
import { EmptyState, ResourceView } from '@/components/states';
import { timeOf } from '@/components/thread';
import { useSection } from '@/components/section-copy';

export default function MessagesPage() {
  const messaging = useSection('messaging');
  const conversations = useResource((api) => api.listConversations());
  useLive(conversations.refresh, 15000);
  return (
    <>
      <div className="head"><div><h2>Messages</h2><p className="lede">{messaging.description}</p></div></div>
      <ResourceView
        resource={conversations}
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No conversations yet"><p className="lede">Connect with a member, then write to them from their profile.</p><Link className="btn" href="/members">Find members</Link></EmptyState>}
      >
        {(list) => list.map((c) => (
          <div className="panel-item" key={c.memberId} style={{ maxWidth: '46rem' }}>
            <div>
              <strong style={{ fontWeight: c.unread ? 600 : 500 }}>{c.fullName}</strong>{c.unread ? <> <span className="tag accent">New</span></> : null}
              <small>{c.lastMessage.length > 90 ? c.lastMessage.slice(0, 90) + '…' : c.lastMessage}</small>
              <small>{timeOf(c.lastMessageAt)}</small>
            </div>
            <Link className="btn quiet small" href={`/messages/${c.memberId}`}>Open</Link>
          </div>
        ))}
      </ResourceView>
    </>
  );
}
