/**
 * After each deployment: checks that the API and the three web apps are up, wired to each other, and serving the
 * protections they should. Read-only (GET and CORS preflights only), so it is safe against production.
 *
 *   SMOKE_API_URL=https://api.example.com SMOKE_WEB_URL=https://app.example.com \
 *   SMOKE_ADMIN_URL=https://admin.example.com SMOKE_MAISON_URL=https://maison.example.com \
 *   pnpm --filter @quintara/api smoke
 *
 * SMOKE_EXPECT=development relaxes what only a production deployment has (code sign-in, HTTPS, HSTS), for trying it
 * locally. Exits 1 on any failure.
 */
export {};

const env = (key: string) => (process.env[key] ?? '').replace(/\/$/, '');
const api = env('SMOKE_API_URL'), apps = { web: env('SMOKE_WEB_URL'), admin: env('SMOKE_ADMIN_URL'), maison: env('SMOKE_MAISON_URL') };
const production = process.env.SMOKE_EXPECT !== 'development';
if (!api || Object.values(apps).some((u) => !u)) {
  console.error('Set SMOKE_API_URL, SMOKE_WEB_URL, SMOKE_ADMIN_URL and SMOKE_MAISON_URL.');
  process.exit(2);
}

const results: [ok: boolean, what: string, detail?: string][] = [];
const check = (ok: boolean, what: string, detail?: string) => { results.push([ok, what, ok ? undefined : detail]); };
const get = (url: string, init: RequestInit = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
async function attempt(what: string, run: () => Promise<void>) {
  try { await run(); } catch (error) { check(false, what, error instanceof Error ? error.message : String(error)); }
}

await attempt('API alive (/health)', async () => { const r = await get(`${api}/health`); check(r.ok, 'API alive (/health)', `answered ${r.status}`); });
await attempt('API ready, database answering (/ready)', async () => {
  const r = await get(`${api}/ready`), body = await r.json().catch(() => null) as { ok?: boolean; database?: string } | null;
  check(r.ok && body?.ok === true && body.database === 'ok', 'API ready, database answering (/ready)', `answered ${r.status} ${JSON.stringify(body)}`);
});
if (production) await attempt('sign-in by emailed code', async () => {
  const body = await (await get(`${api}/v1/auth/config`)).json() as { method?: string };
  check(body.method === 'code', 'sign-in by emailed code', `method is ${body.method}`);
});
// CORS: each app may call with cookies; any other site may not.
for (const [name, origin] of Object.entries(apps)) {
  await attempt(`API accepts calls from the ${name} app`, async () => {
    const r = await get(`${api}/v1/session`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
    check(r.headers.get('access-control-allow-origin') === origin && r.headers.get('access-control-allow-credentials') === 'true',
      `API accepts calls from the ${name} app`, `allow-origin was ${r.headers.get('access-control-allow-origin')}: add ${origin} to WEB_ORIGINS`);
  });
}
await attempt('API refuses calls from other sites', async () => {
  const r = await get(`${api}/v1/session`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  check(!r.headers.get('access-control-allow-origin'), 'API refuses calls from other sites', `allow-origin was ${r.headers.get('access-control-allow-origin')}`);
});
await attempt('API security headers', async () => {
  const h = (await get(`${api}/health`)).headers;
  check(h.get('x-content-type-options') === 'nosniff', 'API security headers', 'x-content-type-options missing');
});

for (const [name, url] of Object.entries(apps)) {
  await attempt(`${name} app is served`, async () => {
    const r = await get(`${url}/`);
    check(r.status === 200, `${name} app is served`, `answered ${r.status}`);
    const h = r.headers, csp = h.get('content-security-policy') ?? '';
    // The policy is fixed when the app is built: it shows which API the build talks to.
    check(csp.includes(`connect-src 'self' ${api}`), `${name} app was built for this API`, `its policy allows ${/connect-src [^;]*/.exec(csp)?.[0] ?? 'nothing'}: rebuild with NEXT_PUBLIC_API_URL=${api}`);
    check(h.get('x-frame-options') === 'DENY' && csp.includes("frame-ancestors 'none'"), `${name} app cannot be framed`, 'x-frame-options or frame-ancestors missing');
    if (production) {
      check(url.startsWith('https://'), `${name} app on HTTPS`, url);
      check((h.get('strict-transport-security') ?? '').includes('max-age='), `${name} app sends HSTS`, 'strict-transport-security missing');
    }
    if (name === 'admin') check((h.get('x-robots-tag') ?? '').includes('noindex'), 'admin console kept out of search engines', 'x-robots-tag missing');
  });
}

for (const [ok, what, detail] of results) console.log(`${ok ? '  ok  ' : '  FAIL'}  ${what}${detail ? `: ${detail}` : ''}`);
const failed = results.filter(([ok]) => !ok).length;
console.log(failed ? `${failed} check(s) failed.` : `All ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
