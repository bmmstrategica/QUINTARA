'use client';

/**
 * Where the payment provider's checkout sends the member back (`?payment=<id>`). It asks the API how the payment
 * stands (the API asks the provider if its webhook has not arrived yet) until it is settled, then says so plainly.
 * Nothing is shown as paid until the API says it is.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApi } from '@quintara/app-core';
import type { CheckoutStatus } from '@quintara/domain';
import { Loading } from '@/components/states';

const NEXT: Record<CheckoutStatus['purpose'], [href: string, label: string]> = {
  experience: ['/bookings', 'Your bookings'],
  boutique: ['/boutique', 'Your orders'],
  membership: ['/profile', 'Your membership'],
};

export default function PaymentReturnPage() {
  const api = useApi();
  const [status, setStatus] = useState<CheckoutStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('payment');
    if (!id) { setProblem('This link does not name a payment.'); return; }
    let stopped = false, tries = 0;
    const check = async () => {
      try {
        const now = await api.getCheckout(id);
        if (stopped) return;
        setStatus(now);
        // Still waiting for the provider: ask again for up to two minutes.
        if (now.status === 'pending' && ++tries < 60) setTimeout(check, 2000);
      } catch (error) {
        if (!stopped) setProblem(error instanceof Error ? error.message : 'This payment could not be found.');
      }
    };
    void check();
    return () => { stopped = true; };
  }, [api]);

  const next = status ? NEXT[status.purpose] : null;
  return (
    <>
      <div className="head"><div><h2>Payment</h2></div></div>
      {problem ? <div className="notice" role="alert"><p style={{ margin: 0 }}>{problem}</p></div> : null}
      {!problem && (!status || status.status === 'pending') ? (
        <>
          <Loading label="Confirming your payment" />
          {status ? <p className="lede">This can take a few moments. You can leave this page: we will let you know as soon as it is confirmed.</p> : null}
        </>
      ) : null}
      {status?.status === 'paid' ? <div className="notice" role="status"><p style={{ margin: 0 }}>Thank you. Your payment is confirmed.</p></div> : null}
      {status?.status === 'failed' ? <div className="notice" role="alert"><p style={{ margin: 0 }}>The payment did not go through.{status.reason ? ` ${status.reason}` : ''} Nothing was charged. You can try again.</p></div> : null}
      {status?.status === 'refunded' ? <div className="notice" role="status"><p style={{ margin: 0 }}>This had changed before your payment arrived, so your money has been returned in full.</p></div> : null}
      {next && status?.status !== 'pending' ? <p style={{ marginTop: '1.2rem' }}><Link className="btn" href={next[0]}>{next[1]}</Link></p> : null}
    </>
  );
}
