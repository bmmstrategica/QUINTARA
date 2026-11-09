import { createHttpApi } from '@quintara/api-client';
import type { QuintaraApi } from '@quintara/api-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createMemoryDb, createPostgresDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { MockEmailProvider } from '../src/email.ts';
import { MockPaymentProvider } from '../src/payments.ts';
import { seed } from '../src/seed.ts';
import { createHmac } from 'node:crypto';
import { MockWhatsAppProvider } from '../src/whatsapp.ts';
import type { WhatsAppConfig } from '../src/whatsapp.ts';

export interface TestServer {
  app: FastifyInstance;
  db: Db;
  payments: MockPaymentProvider;
  email: MockEmailProvider;
  /** A signed-in staff browser: call(method, url, body) returns { status, body }. */
  staff(email: string): Promise<(method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>>;
  /** A fresh client with its own cookie jar, like a separate browser. */
  client(): QuintaraApi;
  /** What QÉRA sent on WhatsApp. */
  whatsapp: MockWhatsAppProvider;
  whatsappConfig: WhatsAppConfig;
  /** A message arriving from a WhatsApp number, signed as Meta signs it; resolves once it has been handled. */
  whatsappIn(from: string, message: { text?: string; button?: string; id?: string }): Promise<number>;
  close(): Promise<void>;
}

/** A real API on an in-memory PostgreSQL, called through the same HTTP client the apps use. */
export async function startServer(overrides: Partial<import('../src/app.ts').AppConfig> = {}, options: { db?: Db } = {}): Promise<TestServer> {
  // An in-memory PostgreSQL by default; a real one when the test passes it (see freshPostgres), or for every test when
  // TEST_ALL_ON_POSTGRES=1 (with TEST_DATABASE_URL), so the whole suite can be run on a real server.
  const own = !options.db && process.env.TEST_ALL_ON_POSTGRES === '1' ? await freshPostgres() : null;
  const db = options.db ?? own?.db ?? createMemoryDb();
  await migrate(db);
  await seed(db);
  const payments = new MockPaymentProvider();
  const email = new MockEmailProvider();
  const whatsapp = new MockWhatsAppProvider();
  const whatsappConfig: WhatsAppConfig = { provider: whatsapp, businessNumber: '+27 21 000 0000', verifyToken: 'test-verify-token', appSecret: 'test-app-secret', numberSecret: 'test-number-secret-of-at-least-32-chars', perMinute: 1000 };
  const app = await buildApp(db, { webOrigins: ['http://localhost:3000'], authMode: 'dev', secureCookies: false, payments, email, webUrl: 'https://app.quintara.test', signInLimit: 1000, whatsapp: whatsappConfig, ...(process.env.TEST_LOG === '1' ? { logger: true } : {}), ...overrides });
  let seq = 0;
  const whatsappIn = async (from: string, message: { text?: string; button?: string; id?: string }) => {
    const m = message.button ? { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: message.button, title: 'x' } } } : { type: 'text', text: { body: message.text ?? '' } };
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: [{ from, id: message.id ?? `wamid.test.${++seq}`, timestamp: '0', ...m }] } }] }] });
    const signature = 'sha256=' + createHmac('sha256', whatsappConfig.appSecret).update(raw).digest('hex');
    const response = await app.inject({ method: 'POST', url: '/v1/whatsapp/webhook', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, payload: raw });
    await app.flushWhatsApp();
    return response.statusCode;
  };

  const staff = async (email: string) => {
    const signIn = await app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email } });
    const cookie = signIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    return async (method: string, url: string, body?: unknown) => {
      const response = await app.inject({ method: method as 'GET', url, headers: { cookie }, payload: body as object | undefined });
      return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
    };
  };

  const client = () => {
    const jar = new Map<string, string>();
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const response = await app.inject({
        method: (init.method ?? 'GET') as 'GET',
        url: url.pathname + url.search,
        headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
        payload: init.body as string | undefined,
      });
      for (const c of response.cookies) c.value ? jar.set(c.name, c.value) : jar.delete(c.name);
      return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return createHttpApi({ baseUrl: 'http://api.test', fetchImpl });
  };
  return { app, db, payments, email, staff, client, whatsapp, whatsappConfig, whatsappIn, close: async () => { await app.flushEmails(); await app.close(); await db.close(); await own?.drop(); } };
}

/**
 * A new, empty database on the PostgreSQL server at TEST_DATABASE_URL, for tests that need real concurrency (the
 * in-memory database has a single connection). Returns null when TEST_DATABASE_URL is not set. `drop` removes it.
 */
export async function freshPostgres(): Promise<{ db: Db; drop: () => Promise<void> } | null> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return null;
  const name = `quintara_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = createPostgresDb(base);
  await admin.exec(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = `/${name}`;
  const db = createPostgresDb(url.toString());
  return { db, drop: async () => { await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.close(); } };
}
