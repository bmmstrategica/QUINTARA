/**
 * The database role the API connects as in production: it reads and writes Quintara's data and nothing more.
 *
 * - It owns no table, so it cannot alter tables or disable triggers; the audit log's append-only rule and its hash
 *   chain (triggers) therefore hold against the API itself, and against anyone who obtains its connection string.
 * - The audit log and the staff activity log are append-only for it by permission too (no UPDATE, no DELETE).
 * - No TRUNCATE, no DDL, no superuser, no role or database creation, and no access to schema_migrations.
 *
 * Run by the role that owns the tables and runs the migrations (DEFAULT PRIVILEGES apply to tables that role creates
 * later, so new migrations need no extra grants). Safe to run again: it updates the password and re-applies grants.
 */
import type { Queryable } from './db.ts';

export async function grantAppRole(db: Queryable, role: string, password: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(role)) throw new Error('The role name may use lower-case letters, digits and underscores.');
  if (password.length < 24) throw new Error('Use a password of at least 24 random characters.');
  const exists = (await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).length > 0;
  // Identifiers and the password are quoted by PostgreSQL itself (format %I and %L), never pasted into the SQL.
  const make = (await db.query<{ sql: string }>(
    exists ? `SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', $1::text, $2::text) AS sql`
           : `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', $1::text, $2::text) AS sql`, [role, password]))[0]!.sql;
  await db.query(make);
  const statements = await db.query<{ sql: string }>(`
    SELECT unnest(ARRAY[
      format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text),
      format('GRANT USAGE ON SCHEMA public TO %I', $1::text),
      format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', $1::text),
      format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', $1::text),
      format('REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, staff_activity FROM %I', $1::text),
      format('REVOKE ALL ON schema_migrations FROM %I', $1::text),
      -- Read-only, so the release's preflight can confirm, as this role, that the schema is current.
      format('GRANT SELECT ON schema_migrations TO %I', $1::text),
      format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', $1::text),
      format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', $1::text)
    ]) AS sql`, [role]);
  for (const { sql } of statements) await db.query(sql);
}
