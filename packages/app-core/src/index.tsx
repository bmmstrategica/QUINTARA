'use client';
/**
 * React glue shared by the web and mobile apps: the API provider, the session,
 * and two small hooks that give every screen the same five states
 * (loading, ready, empty, error, permission denied).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, toApiError } from '@quintara/api-client';
import type { QuintaraApi } from '@quintara/api-client';
import { can } from '@quintara/domain';
import type { GuestAccount, GuestAccountInput, Market, MembershipStatus, Permission, SecondStep, Session, TwoFactorSetup } from '@quintara/domain';

/* ---------- API and session ---------- */

interface SessionState {
  /** `loading` until the first session check completes. */
  status: 'loading' | 'ready';
  session: Session | null;
  /** A signed-in guest account. Never set together with a member session. */
  guest: GuestAccount | null;
  /**
   * A sign-in waiting for its second step: `verify` (the code from the authenticator app) or `enrol` (set one up).
   * Until it is done the person is not signed in, and the apps show the second step instead of anything else.
   */
  secondStep: SecondStep;
  /**
   * A member whose membership has lapsed: signed in, with no member permissions until it is renewed. The apps show
   * the renewal screen instead of the member screens.
   */
  lapsed: MembershipStatus | null;
}

interface AppContextValue extends SessionState {
  api: QuintaraApi;
  /**
   * Signs in a member, or failing that a guest account with that address. With a code (production), the code sent
   * by `requestCode` is checked and the person is signed in as whatever the address belongs to.
   */
  signIn(email: string, code?: string): Promise<{ session: Session | null; guest: GuestAccount | null }>;
  /** `code` in production: the apps ask for a one-time code after the address. `dev`: the address alone. */
  authMethod: 'dev' | 'code';
  /** Emails a one-time code: to sign in, or to create a guest account (`join`). */
  requestCode(email: string, purpose?: 'sign_in' | 'join'): Promise<void>;
  signOut(): Promise<void>;
  createGuestAccount(input: GuestAccountInput & { code?: string }): Promise<GuestAccount>;
  /** Erases the guest account and signs out. */
  deleteGuestAccount(): Promise<void>;
  /** The open cities, and the one being viewed. */
  markets: Market[];
  market: Market | null;
  /** Switches city. Every list on screen reloads for the new city. */
  setMarket(slug: string | null): void;
  /** Re-reads the session, for moments when it changes on the server (a membership being activated). */
  refresh(): Promise<void>;
  /** Finishes a sign-in with the code from the authenticator app, or a recovery code. */
  verifySecondStep(code: string): Promise<void>;
  /** Starts setting up an authenticator (the QR code and key). */
  beginTwoFactorSetup(code?: string): Promise<TwoFactorSetup>;
  /** Confirms the authenticator with its first code; returns the recovery codes, shown once. Finishes a sign-in waiting for it. */
  confirmTwoFactorSetup(code: string): Promise<string[]>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function QuintaraProvider({ api, children, initialMarket = null, onMarketChange }: {
  api: QuintaraApi; children: ReactNode;
  /** The city chosen on an earlier visit, which the host app keeps (local storage on the web, device storage on mobile). */
  initialMarket?: string | null;
  onMarketChange?: (slug: string | null) => void;
}) {
  const [state, setState] = useState<SessionState>({ status: 'loading', session: null, guest: null, secondStep: null, lapsed: null });
  const [markets, setMarkets] = useState<Market[]>([]);
  const [authMethod, setAuthMethod] = useState<'dev' | 'code'>('dev');
  useEffect(() => { let off = false; api.getAuthConfig().then((c) => { if (!off) setAuthMethod(c.method); }).catch(() => undefined); return () => { off = true; }; }, [api]);
  const [chosen, setChosen] = useState<string | null>(() => { api.setMarket(initialMarket); return initialMarket; });
  useEffect(() => { let off = false; api.listMarkets().then((list) => { if (!off) setMarkets(list); }).catch(() => undefined); return () => { off = true; }; }, [api]);
  const changeMarket = useCallback((slug: string | null) => { api.setMarket(slug); setChosen(slug); onMarketChange?.(slug); }, [api, onMarketChange]);
  // The city on screen: the one chosen, if it is still open; otherwise the member's home city; otherwise the first.
  const market = markets.find((m) => m.slug === chosen) ?? markets.find((m) => m.id === state.session?.marketId) ?? markets[0] ?? null;

  const read = useCallback(async (): Promise<SessionState> => {
    const two = await api.getTwoFactor().catch(() => null);
    if (two && (two.state === 'verify' || two.state === 'enrol')) return { status: 'ready', session: null, guest: null, secondStep: two.state, lapsed: null };
    const session = await api.getSession();
    const guest = session ? null : await api.getGuestAccount().catch(() => null);
    // Signed in but neither a member nor a guest: perhaps a membership that has lapsed.
    const membership = !session && !guest && two ? await api.getMembership().catch(() => null) : null;
    return { status: 'ready', session, guest, secondStep: null, lapsed: membership?.state === 'lapsed' ? membership : null };
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    read()
      .then((next) => { if (!cancelled) setState(next); })
      .catch(() => { if (!cancelled) setState({ status: 'ready', session: null, guest: null, secondStep: null, lapsed: null }); });
    return () => { cancelled = true; };
  }, [read]);

  const value = useMemo<AppContextValue>(
    () => ({
      ...state,
      api,
      authMethod,
      async requestCode(email, purpose = 'sign_in') { await api.requestSignInCode({ email, purpose }); },
      async signIn(email, code) {
        if (code) {
          const result = await api.verifySignInCode({ email, code });
          // Neither a member nor a guest, and no second step: a lapsed membership, which the session read finds.
          if (!result.twoFactor && !result.session && !result.guest) { setState(await read()); return result; }
          setState({ status: 'ready', session: result.twoFactor ? null : result.session, guest: result.twoFactor ? null : result.guest, secondStep: result.twoFactor ?? null, lapsed: null });
          return result;
        }
        try {
          const session = await api.signIn({ email });
          const step = (session as Session & { twoFactor?: SecondStep }).twoFactor ?? null;
          if ((session as unknown as { lapsed?: boolean }).lapsed) { setState(step ? { status: 'ready', session: null, guest: null, secondStep: step, lapsed: null } : await read()); return { session: null, guest: null }; }
          setState({ status: 'ready', session: step ? null : session, guest: null, secondStep: step, lapsed: null });
          return { session: step ? null : session, guest: null };
        } catch (caught) {
          if (!(caught instanceof ApiError) || caught.code !== 'unauthenticated') throw caught;
          // Not a member: perhaps a guest account. One answer either way, so addresses cannot be tested.
          try {
            const guest = await api.signInGuest({ email });
            const step = (guest as GuestAccount & { twoFactor?: SecondStep }).twoFactor ?? null;
            setState({ status: 'ready', session: null, guest: step ? null : guest, secondStep: step, lapsed: null });
            return { session: null, guest: step ? null : guest };
          } catch (second) {
            if (second instanceof ApiError && second.code === 'unauthenticated') throw new ApiError('unauthenticated', 'No account was found for that email address.');
            throw second;
          }
        }
      },
      async signOut() {
        await api.signOut();
        setState({ status: 'ready', session: null, guest: null, secondStep: null, lapsed: null });
      },
      async createGuestAccount(input) {
        const guest = await api.createGuestAccount(input);
        // Where two-factor is required, the new account sets up an authenticator before going further.
        setState(await read());
        return guest;
      },
      async deleteGuestAccount() {
        await api.deleteGuestAccount();
        setState({ status: 'ready', session: null, guest: null, secondStep: null, lapsed: null });
      },
      async refresh() {
        setState(await read());
      },
      async verifySecondStep(code) {
        await api.verifyTwoFactor(code);
        setState(await read());
      },
      beginTwoFactorSetup: (code) => api.startTwoFactorSetup(code),
      async confirmTwoFactorSetup(code) {
        const { recoveryCodes } = await api.confirmTwoFactor(code);
        // Not re-read yet: the person first keeps their recovery codes, then calls refresh().
        return recoveryCodes;
      },
      markets,
      market,
      setMarket: changeMarket,
    }),
    [api, state, read, markets, market, changeMarket, authMethod],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('Quintara hooks must be used inside <QuintaraProvider>.');
  return value;
}

export const useApi = (): QuintaraApi => useApp().api;

/** The open cities and the one being viewed, with a way to switch. */
export function useMarket() {
  const { markets, market, setMarket } = useApp();
  return { markets, market, setMarket };
}

export function useSession() {
  const { status, session, guest, signIn, signOut, refresh, createGuestAccount, deleteGuestAccount, authMethod, requestCode, secondStep, lapsed } = useApp();
  return { status, session, guest, signIn, signOut, refresh, createGuestAccount, deleteGuestAccount, authMethod, requestCode, secondStep, lapsed };
}

/** The second step of signing in (two-factor), and setting up an authenticator. */
export function useSecondStep() {
  const { secondStep, verifySecondStep, beginTwoFactorSetup, confirmTwoFactorSetup, refresh, signOut } = useApp();
  return { secondStep, verify: verifySecondStep, beginSetup: beginTwoFactorSetup, confirmSetup: confirmTwoFactorSetup, finish: refresh, cancel: signOut };
}

/** True when the current viewer (member or visitor) holds the permission. */
export function usePermission(permission: Permission): boolean {
  return can(useApp().session, permission);
}

/* ---------- Loading data ---------- */

export type Resource<T> =
  | { status: 'loading'; data: undefined; error: undefined; reload: () => void }
  | { status: 'ready'; data: T; error: undefined; reload: () => void }
  | { status: 'error'; data: undefined; error: ApiError; reload: () => void };

/**
 * Loads data for a screen and reloads when `deps` or the signed-in user change.
 * A slow earlier response can never overwrite a newer one.
 */
export function useResource<T>(load: (api: QuintaraApi) => Promise<T>, deps: readonly unknown[] = []): Resource<T> {
  const { api, session, guest, status: sessionStatus, market } = useApp();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ApiError }>({ status: 'loading' });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (sessionStatus === 'loading') return;
    let cancelled = false;
    setState({ status: 'loading' });
    loadRef.current(api).then(
      (data) => { if (!cancelled) setState({ status: 'ready', data }); },
      (error: unknown) => { if (!cancelled) setState({ status: 'error', error: toApiError(error) }); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session?.userId, guest?.userId, market?.id, sessionStatus, attempt, ...deps]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  if (state.status === 'ready') return { status: 'ready', data: state.data, error: undefined, reload };
  if (state.status === 'error') return { status: 'error', data: undefined, error: state.error, reload };
  return { status: 'loading', data: undefined, error: undefined, reload };
}

/* ---------- Performing actions ---------- */

export interface Action<Args extends unknown[], T> {
  /** Resolves with the result, or `undefined` if the call failed (the error is in `error`). */
  run: (...args: Args) => Promise<T | undefined>;
  pending: boolean;
  error: ApiError | null;
  clearError: () => void;
}

/** Wraps a mutation with pending and error state, and blocks double submission. */
export function useAction<Args extends unknown[], T>(perform: (api: QuintaraApi, ...args: Args) => Promise<T>): Action<Args, T> {
  const { api } = useApp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const busy = useRef(false);
  const performRef = useRef(perform);
  performRef.current = perform;

  const run = useCallback(
    async (...args: Args) => {
      if (busy.current) return undefined;
      busy.current = true;
      setPending(true);
      setError(null);
      try {
        return await performRef.current(api, ...args);
      } catch (caught) {
        setError(toApiError(caught));
        return undefined;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [api],
  );

  return { run, pending, error, clearError: useCallback(() => setError(null), []) };
}

export { ApiError };
