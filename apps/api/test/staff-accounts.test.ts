/** Five admin console accounts, managed by administrators, and the audit log of everything they do. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROLES, STAFF_ROLES } from '@quintara/domain';
import { startServer } from './harness.ts';

test('staff role keys never equal member role keys: both are stored in user_roles', async () => {
  assert.deepEqual(STAFF_ROLES.filter((r) => (ROLES as readonly string[]).includes(r)), []);
  const s = await startServer();
  try {
    const rows = await s.db.query<{ key: string; is_staff: boolean }>('SELECT key, is_staff FROM roles');
    for (const role of STAFF_ROLES) assert.equal(rows.find((r) => r.key === role)?.is_staff, true, role);
    for (const role of ROLES) assert.equal(rows.find((r) => r.key === role)?.is_staff, false, role);
  } finally { await s.close(); }
});

test('admin console accounts: a fixed number of seats, roles, suspension, and never without an administrator', async () => {
  // Three sample accounts are seeded (administrator, concierge, content); six seats leave room for three more.
  const s = await startServer({ staffSeats: 6 });
  try {
    const admin = await s.staff('admin@example.com');
    const list = await admin('GET', '/admin/v1/staff');
    assert.deepEqual([list.status, list.body.seats], [200, { used: 3, total: 6 }]);
    assert.deepEqual(list.body.staff.map((x: any) => [x.fullName, x.role, x.you]), [['Lerato Content', 'content', false], ['Nomsa Admin', 'admin', true], ['Palesa Makam', 'concierge', false]]);

    const add = (fullName: string, email: string, role: string, title = '') => admin('POST', '/admin/v1/staff', { fullName, email, role, title });
    assert.equal((await add('X', 'bad', 'admin')).status, 422);
    assert.equal((await add('Lindiwe Khumalo', 'lindiwe@quintara.test', 'admin', 'Membership director')).status, 200);
    assert.equal((await add('Sipho Ndlovu', 'sipho.staff@quintara.test', 'concierge', 'Concierge')).status, 200);
    assert.equal((await add('Thandi Mokoena', 'thandi@example.com', 'concierge', 'Events')).status, 200);   // a member can also be staff
    assert.equal((await add('Thandi again', 'thandi@example.com', 'concierge')).status, 409);
    const full = await add('Ayanda Six', 'ayanda@quintara.test', 'concierge');
    assert.deepEqual([full.status, full.body.message], [409, 'All 6 admin console accounts are in use. Suspend one before adding another.']);
    assert.ok(s.email.sent.some((m) => m.to === 'lindiwe@quintara.test' && m.subject === 'Your Quintara admin console account' && !/password/i.test(m.text.replace('There is no password', ''))));

    // The concierge desk cannot manage accounts.
    const desk = await s.staff('desk@example.com');
    assert.equal((await desk('GET', '/admin/v1/staff')).status, 403);
    assert.equal((await desk('POST', '/admin/v1/staff', { fullName: 'Someone', email: 'x@quintara.test', role: 'admin' })).status, 403);

    // A new account signs in, with the powers of its role and no more.
    const sipho = await s.staff('sipho.staff@quintara.test');
    assert.equal((await sipho('GET', '/admin/v1/experiences')).status, 200);
    assert.equal((await sipho('GET', '/admin/v1/members')).status, 403);
    // Thandi's membership is untouched; her app session has no staff powers.
    const thandi = s.client();
    await thandi.signIn({ email: 'thandi@example.com' });
    assert.ok(await thandi.getSession());

    // Suspending ends the person's console session at once and stops them signing in. The seat is freed.
    const ids = Object.fromEntries((await admin('GET', '/admin/v1/staff')).body.staff.map((x: any) => [x.fullName, x.userId]));
    assert.equal((await admin('PATCH', `/admin/v1/staff/${ids['Sipho Ndlovu']}`, { status: 'suspended' })).status, 204);
    assert.equal((await sipho('GET', '/admin/v1/experiences')).status, 401);
    assert.equal((await s.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email: 'sipho.staff@quintara.test' } })).statusCode, 401);
    assert.equal((await add('Ayanda Six', 'ayanda@quintara.test', 'concierge')).status, 200);
    assert.equal((await admin('PATCH', `/admin/v1/staff/${ids['Sipho Ndlovu']}`, { status: 'active' })).status, 409);   // no seat to come back to

    // Never without an administrator, and nobody changes their own access.
    assert.equal((await admin('PATCH', `/admin/v1/staff/${ids['Nomsa Admin']}`, { role: 'concierge' })).status, 403);
    assert.equal((await admin('PATCH', `/admin/v1/staff/${ids['Nomsa Admin']}`, { status: 'suspended' })).status, 403);
    const lindiwe = await s.staff('lindiwe@quintara.test');
    assert.equal((await lindiwe('PATCH', `/admin/v1/staff/${ids['Nomsa Admin']}`, { role: 'concierge' })).status, 204);
    assert.equal((await admin('GET', '/admin/v1/members')).status, 401);   // the change of role signed her out of the console
    const nomsa = await s.staff('admin@example.com');
    assert.equal((await nomsa('GET', '/admin/v1/members')).status, 403);   // now the concierge desk
    assert.equal((await lindiwe('PATCH', `/admin/v1/staff/${ids['Lindiwe Khumalo']}`, { role: 'concierge' })).status, 403);
    assert.equal((await lindiwe('PATCH', `/admin/v1/staff/${ids['Nomsa Admin']}`, { role: 'admin', title: 'Head of operations' })).status, 204);
  } finally { await s.close(); }
});

test('each staff role has the powers of its role and no more, checked by the server', async () => {
  const s = await startServer({ staffSeats: 12 });
  try {
    const admin = await s.staff('admin@example.com');
    const people = { executive_admin: 'exec', membership: 'members', experiences: 'events', finance: 'money', support: 'help' } as const;
    for (const [role, name] of Object.entries(people)) assert.equal((await admin('POST', '/admin/v1/staff', { fullName: `Staff ${name}`, email: `${name}@quintara.test`, role })).status, 200);
    const as = async (name: string) => s.staff(`${name}@quintara.test`);
    const status = async (who: Awaited<ReturnType<typeof as>>, url: string) => (await who('GET', url)).status;
    // [route, the roles that may open it]
    const matrix: [string, string[]][] = [
      ['/admin/v1/staff', []],
      ['/admin/v1/applications', ['executive_admin', 'membership']],
      ['/admin/v1/members', ['executive_admin', 'membership']],
      ['/admin/v1/payments', ['executive_admin', 'finance']],
      ['/admin/v1/insights', ['executive_admin', 'finance']],
      ['/admin/v1/experiences', ['executive_admin', 'experiences', 'support']],     // support: read-only, for the guest lists
      ['/admin/v1/concierge-requests', ['support']],
      ['/admin/v1/partners', []],
      ['/admin/v1/products', []],
      ['/admin/v1/audit', ['executive_admin', 'membership', 'experiences', 'finance', 'support']],
    ];
    for (const [role, name] of Object.entries(people)) {
      const who = await as(name);
      for (const [url, allowed] of matrix) assert.equal(await status(who, url), allowed.includes(role) ? 200 : 403, `${role} ${url}`);
    }
    // The content manager runs Maison Quintara, partners and services, but not members or money.
    const content = await s.staff('content@example.com');
    for (const url of ['/admin/v1/products', '/admin/v1/partners', '/admin/v1/services', '/admin/v1/tv/series']) assert.equal(await status(content, url), 200, url);
    for (const url of ['/admin/v1/members', '/admin/v1/payments', '/admin/v1/insights']) assert.equal(await status(content, url), 403, url);
    // Only the full audit log is for executives and administrators: everyone else sees their own entries.
    const finance = await as('money');
    assert.equal((await finance('GET', '/admin/v1/audit')).body.all, false);
    assert.equal((await (await as('exec'))('GET', '/admin/v1/audit')).body.all, true);
    // A member's business role "executive" gives no console powers, even to someone who also has a console account.
    const ids = Object.fromEntries((await admin('GET', '/admin/v1/staff')).body.staff.map((x: any) => [x.email, x.userId]));
    await s.db.query(`INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'executive')`, [ids['help@quintara.test']]);
    const support = await s.staff('help@quintara.test');
    assert.equal(await status(support, '/admin/v1/members'), 403);
    assert.equal((await support('GET', '/admin/v1/audit')).body.all, false);
    // Support reaches the guest lists through the experiences, but cannot change, create or cancel an experience.
    const help = await as('help');
    const experience = (await help('GET', '/admin/v1/experiences')).body[0];
    assert.equal((await help('GET', `/admin/v1/experiences/${experience.id}/guests`)).status, 200);
    assert.equal((await help('PATCH', `/admin/v1/experiences/${experience.id}`, { capacity: 99 })).status, 403);
    assert.equal((await help('POST', `/admin/v1/experiences/${experience.id}/cancel`, { reason: 'Not mine to cancel.' })).status, 403);
    assert.equal((await help('POST', '/admin/v1/experiences', {})).status, 403);
    // A role cannot be invented.
    assert.equal((await admin('POST', '/admin/v1/staff', { fullName: 'Someone Else', email: 'else@quintara.test', role: 'owner' })).status, 422);
  } finally { await s.close(); }
});

test('audit log: every action and request by each member of staff, append-only, checked by its hash chain, exported for auditors', async () => {
  const s = await startServer();
  try {
    const admin = await s.staff('admin@example.com');
    const desk = await s.staff('desk@example.com');
    await admin('POST', '/admin/v1/staff', { fullName: '=HYPERLINK("http://evil")', email: 'formula@quintara.test', role: 'concierge' });
    await admin('GET', '/admin/v1/members');
    await desk('GET', '/admin/v1/experiences');

    const log = await admin('GET', '/admin/v1/audit');
    assert.equal(log.status, 200);
    assert.equal(log.body.all, true);
    const added = log.body.entries.find((e: any) => e.action === 'staff.added');
    assert.deepEqual([added.staffName, added.summary, added.kind], ['Nomsa Admin', 'Added an admin console account', 'action']);
    assert.ok(added.ip);
    assert.ok(log.body.entries.some((e: any) => e.kind === 'request' && e.action === 'GET /admin/v1/members' && e.staffName === 'Nomsa Admin' && e.status === 200 && e.summary === 'Opened members'));
    assert.ok(log.body.entries.some((e: any) => e.kind === 'request' && e.staffName === 'Palesa Makam'));
    assert.ok(log.body.entries.some((e: any) => e.action === 'auth.staff_signed_in' && e.staffName === 'Palesa Makam'));

    // One person's entries, by kind and date.
    const deskId = log.body.staff.find((x: any) => x.fullName === 'Palesa Makam').userId;
    const only = await admin('GET', `/admin/v1/audit?staff=${deskId}&kind=request&from=${new Date().toISOString().slice(0, 10)}`);
    assert.ok(only.body.entries.length > 0 && only.body.entries.every((e: any) => e.staffId === deskId && e.kind === 'request'));
    assert.equal((await admin('GET', '/admin/v1/audit?staff=not-an-id')).status, 422);

    // The desk sees only its own activity, and cannot export or check the log.
    const own = await desk('GET', `/admin/v1/audit?staff=${log.body.staff.find((x: any) => x.fullName === 'Nomsa Admin').userId}`);
    assert.equal(own.body.all, false);
    assert.ok(own.body.entries.length > 0 && own.body.entries.every((e: any) => e.staffId === deskId));
    assert.equal((await desk('GET', '/admin/v1/audit/export')).status, 403);
    assert.equal((await desk('POST', '/admin/v1/audit/verify')).status, 403);

    // Export: CSV, formulas neutralised, and the export itself recorded. A name a spreadsheet would run as a formula:
    await admin('PATCH', `/admin/v1/staff/${deskId}`, { fullName: '=HYPERLINK("http://evil","x")' });
    const csv = await s.app.inject({ method: 'GET', url: '/admin/v1/audit/export', headers: { cookie: (await s.app.inject({ method: 'POST', url: '/admin/v1/session', payload: { email: 'admin@example.com' } })).cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.match(String(csv.headers['content-disposition']), /attachment; filename="quintara-audit-/);
    assert.ok(csv.body.startsWith('"Time (UTC)","Staff","Kind"'));
    assert.ok(!/(^|,)"[=+\-@]/m.test(csv.body));                          // no cell starts with a formula
    assert.ok(csv.body.includes(`'=HYPERLINK`));                               // kept, but as text
    assert.ok((await admin('GET', '/admin/v1/audit')).body.entries.some((e: any) => e.action === 'audit.exported'));

    // Append-only, and the chain shows any tampering done behind the database's back.
    await assert.rejects(s.db.query("UPDATE staff_activity SET route = 'nothing'"), /append-only|permission denied/);
    await assert.rejects(s.db.query('DELETE FROM staff_activity'), /append-only|permission denied/);
    await assert.rejects(s.db.query("UPDATE audit_logs SET action = 'tampered'"), /append-only|permission denied/);
    const intact = await admin('POST', '/admin/v1/audit/verify');
    assert.deepEqual([intact.body.actions.intact, intact.body.requests.intact], [true, true]);
    assert.ok(intact.body.actions.entries > 5 && intact.body.requests.entries > 3);
    const victim = (await s.db.query<{ seq: string }>("SELECT seq FROM audit_logs WHERE action = 'staff.added'"))[0]!.seq;
    // Someone with the owner's access (not the API's) disables the protection and edits an entry.
    await s.ownerDb.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only');
    await s.ownerDb.query("UPDATE audit_logs SET changes = '{\"fullName\":\"Someone else\"}' WHERE seq = $1", [victim]);
    await s.ownerDb.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only');
    const broken = await admin('POST', '/admin/v1/audit/verify');
    assert.deepEqual([broken.body.actions.intact, broken.body.actions.firstBrokenAt, broken.body.requests.intact], [false, Number(victim), true]);
  } finally { await s.close(); }
});
