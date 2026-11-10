'use client';

import { ThemeToggle } from '@/components/theme-toggle';
import { SecondStep } from '@/components/two-factor';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, createAdminApi, toApiError } from '@quintara/api-client';
import type { AdminApi, StaffMarket, StaffSession } from '@quintara/api-client';
import { STAFF_ROLE_LABELS, staffCan, staffCanAny } from '@quintara/domain';
import type { StaffPermission } from '@quintara/domain';

interface AdminContextValue {
  api: AdminApi; session: StaffSession; signOut: () => void;
  /** Every city, and the one staff are working in. Lists show that city; new entries are created in it. */
  markets: StaffMarket[]; market: StaffMarket | null; setMarket: (slug: string) => void; reloadMarkets: () => void;
}
const AdminContext = createContext<AdminContextValue | null>(null);
const MARKET_KEY = 'quintara.admin.market';

export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdmin must be used inside <AdminGate>.');
  return value;
}

export const useCan = (permission: StaffPermission) => staffCan(useAdmin().session.roles, permission);

/** Loads data for a page; `reload` refetches after an action. */
export function useLoad<T>(load: (api: AdminApi) => Promise<T>, deps: readonly unknown[] = []) {
  const { api, market } = useAdmin();
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let cancelled = false;
    loadRef.current(api).then(
      (data) => { if (!cancelled) setState({ data, loading: false }); },
      (error: unknown) => { if (!cancelled) setState({ error: toApiError(error), loading: false }); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, attempt, market?.id, ...deps]);
  return { ...state, reload: useCallback(() => setAttempt((n) => n + 1), []) };
}

/** Runs an action, remembers its error, and blocks double clicks. */
export function useRun() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<unknown>, after?: () => void) => {
    setPending(true);
    setError(null);
    try { await work(); after?.(); } catch (caught) { setError(toApiError(caught).message); } finally { setPending(false); }
  }, []);
  return { run, pending, error };
}

/** Shows the page's loading, error and permission states so each page only writes its ready state. */
export function Loaded<T>({ state, children }: { state: { data?: T; error?: ApiError; loading: boolean }; children: (data: T) => ReactNode }) {
  if (state.loading) return <p className="muted" role="status">Loading</p>;
  if (state.error) return <p className="error" role="alert">{state.error.code === 'forbidden' ? 'Your staff role does not include this.' : state.error.message}</p>;
  return <>{children(state.data as T)}</>;
}

/** Each page and who may open it: any one of its permissions, or every member of staff (none listed). */
const NAV: [href: string, label: string, permissions: StaffPermission[]][] = [
  ['/', 'Overview', []],
  ['/cities', 'Cities', ['admin.markets.manage']],
  ['/applications', 'Applications', ['admin.applications.review']],
  ['/questions', 'Application questions', ['admin.applications.review']],
  ['/members', 'Members', ['admin.members.manage']],
  ['/tiers', 'Tiers', ['admin.finance.manage']],
  ['/payments', 'Payments', ['admin.finance.manage']],
  ['/renewals', 'Renewals', ['admin.finance.manage']],
  ['/experiences', 'Experiences', ['admin.experiences.manage', 'admin.bookings.manage']],
  ['/concierge', 'Concierge', ['admin.concierge.manage']],
  ['/business', 'Business', ['admin.business.manage']],
  ['/partners', 'Partners', ['admin.providers.manage']],
  ['/services', 'Services', ['admin.concierge.manage', 'admin.providers.manage']],
  ['/orders', 'Maison orders', ['admin.boutique.manage']],
  ['/boutique', 'Maison Quintara', ['admin.boutique.manage']],
  ['/tv', 'Quintara TV', ['admin.content.manage']],
  ['/home', 'Home page', ['admin.content.manage']],
  ['/descriptions', 'Descriptions', ['admin.content.manage']],
  ['/check-in', 'Check-in', ['admin.bookings.manage']],
  ['/insights', 'Insights', ['admin.insights.view']],
  ['/staff', 'Staff accounts', ['admin.staff.manage']],
  ['/audit', 'Audit log', []],
];

/** Nothing renders until a staff session exists; otherwise the sign-in form is shown. */
export function AdminGate({ children }: { children: ReactNode }) {
  const [api] = useState(() => createAdminApi({ baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000' }));
  const [session, setSession] = useState<StaffSession | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  // A sign-in waiting for its second step (two-factor): the code from the authenticator, or setting one up.
  const [secondStep, setSecondStep] = useState<'verify' | 'enrol' | null>(null);
  const check = useCallback(async () => {
    const two = await api.getTwoFactor().catch(() => null);
    if (two && (two.state === 'verify' || two.state === 'enrol')) { setSecondStep(two.state); setSession(null); return; }
    setSecondStep(null);
    setSession(await api.getSession().catch(() => null));
  }, [api]);
  useEffect(() => { void check(); }, [check]);
  const [method, setMethod] = useState<'dev' | 'code'>('dev');
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  useEffect(() => { api.getAuthConfig().then((c) => setMethod(c.method), () => undefined); }, [api]);
  const [markets, setMarkets] = useState<StaffMarket[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const reloadMarkets = useCallback(() => { api.listMarkets().then(setMarkets, () => setMarkets([])); }, [api]);
  useEffect(() => {
    if (!session) return;
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(MARKET_KEY); } catch { /* not available */ }
    api.setMarket(saved);
    setSlug(saved);
    reloadMarkets();
  }, [api, session, reloadMarkets]);
  const setMarket = useCallback((next: string) => {
    api.setMarket(next);
    setSlug(next);
    try { window.localStorage.setItem(MARKET_KEY, next); } catch { /* not available */ }
  }, [api]);
  const market = markets.find((m) => m.slug === slug) ?? markets.find((m) => m.isOpen) ?? null;

  if (session === undefined) return <div className="gate"><p className="muted" role="status">Loading</p></div>;
  const restart = () => { void api.signOut().catch(() => undefined).finally(() => { setSecondStep(null); setSession(null); setCodeSent(false); setCode(''); }); };
  if (!session && secondStep) return <SecondStep api={api} step={secondStep} onDone={() => { void check(); }} onCancel={restart} />;
  if (!session) {
    return (
      <div className="gate">
        <div style={{ position: 'absolute', top: 16, right: 16 }}><ThemeToggle /></div>
        <form onSubmit={async (event) => {
          event.preventDefault(); setError(null);
          try {
            // Production: the address, then the one-time code sent to it. Development: the address alone.
            if (method === 'code' && !codeSent) { await api.requestSignInCode(email.trim()); setCodeSent(true); return; }
            const signedIn = await api.signIn(email.trim(), method === 'code' ? code : undefined);
            if (signedIn.twoFactor) { setSecondStep(signedIn.twoFactor); return; }
            setSession({ userId: signedIn.userId!, roles: signedIn.roles });
          } catch (caught) { setError(toApiError(caught).message); }
        }}>
          <img src="/quintara-emblem.png" alt="Quintara" style={{ width: 64 }} />
          <h1>Admin console</h1>
          <p className="lede">For Quintara staff.</p>
          <label style={{ textAlign: 'left' }}>Email<input type="email" autoComplete="email" value={email} readOnly={codeSent} onChange={(event) => setEmail(event.target.value)} required /></label>
          {codeSent ? <label style={{ textAlign: 'left' }}>Code from your email<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} autoFocus /></label> : null}
          {error ? <p className="error" role="alert">{error}</p> : null}
          <button className="btn" disabled={codeSent && code.length !== 6}>{method === 'code' && !codeSent ? 'Send me a code' : 'Sign in'}</button>
          {codeSent ? <button type="button" className="btn ghost" onClick={() => { setCodeSent(false); setCode(''); setError(null); }}>Use another address</button> : null}
          <p className="muted" style={{ fontSize: 12.5 }}>{method === 'code' ? 'If the address belongs to a staff account, a six-digit code is sent to it. It works once, for ten minutes.' : 'Development sign-in: the address alone signs you in. In production a one-time code is sent to it.'}</p>
        </form>
      </div>
    );
  }
  // Back to the overview, so the next person to sign in does not land on a page their role cannot open.
  const signOut = () => { void api.signOut().finally(() => { setSession(null); router.push('/'); }); };
  return (
    <AdminContext.Provider value={{ api, session, signOut, markets, market, setMarket, reloadMarkets }}>
      <div className="shell">
        <aside className="side">
          <Link className="logo" href="/" aria-label="Overview"><img src="/quintara-emblem.png" alt="" /><img src="/quintara-wordmark.png" alt="Quintara" /></Link>
          <small>Admin console</small>
          {markets.length ? (
            <label className="city">
              <span>Working in</span>
              <select value={market?.slug ?? ''} onChange={(event) => setMarket(event.target.value)} aria-label="City you are working in">
                {markets.map((m) => <option key={m.id} value={m.slug}>{m.name}{m.isOpen ? '' : ' (closed)'}</option>)}
              </select>
            </label>
          ) : null}
          <nav aria-label="Admin">
            {NAV.filter(([, , permissions]) => !permissions.length || staffCanAny(session.roles, permissions)).map(([href, label]) => (
              <Link key={href} href={href} aria-current={(href === '/' ? pathname === '/' : pathname.startsWith(href)) ? 'page' : undefined}>{label}</Link>
            ))}
          </nav>
          <ThemeToggle />
          <div className="who"><span>Signed in as {session.roles[0] ? STAFF_ROLE_LABELS[session.roles[0]] : 'staff'}</span><Link href="/security">Your security</Link><button className="link" onClick={signOut}>Sign out</button></div>
        </aside>
        <main>
          {market && !market.isOpen ? <p className="notice" role="status">{market.name} is closed. What you add here is seen only by staff until the city is opened under Cities.</p> : null}
          {children}
        </main>
      </div>
    </AdminContext.Provider>
  );
}

/** An amount of money, zero included ("R 0"): for totals. fmtMoney is for prices, where zero means complimentary. */
export const fmtAmount = (minor: number, currency: string) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: currency || 'ZAR', maximumFractionDigits: 0 }).format(minor / 100);
export const fmtMoney = (minor: number, currency: string) => (minor ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100) : 'Complimentary');
export const fmtDate = (iso: string, timeZone?: string) => new Intl.DateTimeFormat('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(iso));
