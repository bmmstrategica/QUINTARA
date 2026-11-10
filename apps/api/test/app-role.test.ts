/**
 * The restricted role the API connects as in production: the whole API works through it, and the audit log cannot be
 * altered, emptied or unprotected through it. Needs PostgreSQL (TEST_DATABASE_URL); skipped without it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grantAppRole } from '../src/app-role.ts';
import { createPostgresDb } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { seed } from '../src/seed.ts';
import { startServer } from './harness.ts';

const skip = process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

test('the API runs as the restricted role, and through it the audit log cannot be changed, emptied or unprotected', { skip }, async () => {
  const base = new URL(process.env.TEST_DATABASE_URL!);
  const name = `quintara_role_${Date.now().toString(36)}`, role = `qapp_${Date.now().toString(36)}`, password = `pw-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const admin = createPostgresDb(base.toString());
  await admin.exec(`CREATE DATABASE ${name}`);
  const ownerUrl = new URL(base); ownerUrl.pathname = `/${name}`;
  const owner = createPostgresDb(ownerUrl.toString());
  const appUrl = new URL(ownerUrl); appUrl.username = role; appUrl.password = password;
  let app: ReturnType<typeof createPostgresDb> | null = null;
  try {
    await migrate(owner);
    await seed(owner);
    await grantAppRole(owner, role, password);
    await grantAppRole(owner, role, password);          // safe to run again
    app = createPostgresDb(appUrl.toString());

    // The API, connected as the role: members sign in and book, staff work in the console, the audit chain verifies.
    const s = await startServer({}, { db: app, prepared: true });
    try {
      const api = s.client();
      await api.signIn({ email: 'thandi@example.com' });
      const yacht = (await api.listExperiences()).find((e) => e.title === 'The Executive Yacht Club')!;
      assert.equal((await api.bookExperience(yacht.id, 1)).status, 'confirmed');
      const staff = await s.staff('admin@example.com');
      assert.equal((await staff('GET', '/admin/v1/dashboard')).status, 200);
      assert.equal((await staff('PATCH', `/admin/v1/experiences/${yacht.id}`, { capacity: yacht.capacity! + 1 })).status, 200);
      const check = await staff('POST', '/admin/v1/audit/verify');
      assert.equal(check.status, 200, JSON.stringify(check.body));
      assert.deepEqual([check.body.actions.intact, check.body.requests.intact], [true, true]);
    } finally { await s.app.flushEmails(); await s.app.close(); }

    // Directly in SQL, as the role: none of these is allowed.
    const refused = async (sql: string) => { await assert.rejects(app!.query(sql), (e: { code?: string }) => e.code === '42501', sql); };
    await refused(`UPDATE audit_logs SET action = 'nothing happened'`);
    await refused('DELETE FROM audit_logs');
    await refused('TRUNCATE audit_logs');
    await refused('DELETE FROM staff_activity');
    await refused('ALTER TABLE audit_logs DISABLE TRIGGER ALL');
    await refused('DROP TRIGGER audit_logs_append_only ON audit_logs');
    await refused('TRUNCATE experiences');
    await refused('CREATE TABLE intruder (id int)');
    await refused('SELECT * FROM schema_migrations');
    const me = (await app.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>('SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user'))[0]!;
    assert.deepEqual(me, { rolsuper: false, rolcreaterole: false, rolcreatedb: false });

    // A table added by a later migration (created by the owner) is usable without new grants.
    await owner.exec('CREATE TABLE later_feature (id int PRIMARY KEY)');
    await app.query('INSERT INTO later_feature (id) VALUES (1)');
    assert.equal((await app.query('SELECT id FROM later_feature')).length, 1);
  } finally {
    await app?.close(); await owner.close();
    await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.exec(`DROP ROLE IF EXISTS ${role}`);
    await admin.close();
  }
});
