'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ApiError, Resource } from '@quintara/app-core';

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite" aria-label={label}>
      <div className="skeleton wide" />
      <div className="skeleton" />
      <div className="skeleton" style={{ width: '80%' }} />
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** One place decides what each kind of failure looks like and what the next step is. */
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  switch (error.code) {
    case 'unauthenticated':
      return (
        <EmptyState title="This is for members">
          <p className="lede">Sign in to continue, or apply to join Quintara.</p>
          <div className="row">
            <Link className="btn" href="/sign-in">Sign in</Link>
            <Link className="btn quiet" href="/apply">Apply for membership</Link>
          </div>
        </EmptyState>
      );
    case 'forbidden':
      return (
        <EmptyState title="Not part of your membership">
          <p className="lede">{error.message}</p>
          <Link className="btn quiet" href="/">Back to home</Link>
        </EmptyState>
      );
    case 'not_found':
      return (
        <EmptyState title="No longer available">
          <p className="lede">{error.message}</p>
          <Link className="btn quiet" href="/experiences">See experiences</Link>
        </EmptyState>
      );
    default:
      return (
        <EmptyState title="That did not load">
          <p className="lede">{error.message}</p>
          {onRetry ? <button className="btn" onClick={onRetry}>Try again</button> : null}
        </EmptyState>
      );
  }
}

interface ResourceViewProps<T> {
  resource: Resource<T>;
  /** Shown instead of `children` when the data is empty. */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/** Renders the loading, error, permission-denied, empty and ready states of a screen. */
export function ResourceView<T>({ resource, isEmpty, empty, children }: ResourceViewProps<T>) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'error') return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (isEmpty?.(resource.data)) return <>{empty}</>;
  return <>{children(resource.data)}</>;
}

/** Inline message for a failed action (booking, saving, sending). */
export function ActionError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return <p className="notice error" role="alert">{error.message}</p>;
}
