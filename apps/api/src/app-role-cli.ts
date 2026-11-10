/**
 * Creates (or updates) the restricted role the API connects as in production.
 *   DATABASE_URL=<the owner's connection> APP_ROLE=quintara_app APP_ROLE_PASSWORD=<24+ random characters> \
 *     pnpm --filter @quintara/api run app-role
 * Then give the API DATABASE_URL=postgres://quintara_app:<password>@<host>/<database>, and keep the owner's connection
 * for migrations only.
 */
import { grantAppRole } from './app-role.ts';
import { createPostgresDb } from './db.ts';

const url = process.env.DATABASE_URL, role = process.env.APP_ROLE || 'quintara_app', password = process.env.APP_ROLE_PASSWORD ?? '';
if (!url) { console.error('Set DATABASE_URL to the connection of the role that owns the tables.'); process.exit(2); }
const db = createPostgresDb(url);
try {
  await grantAppRole(db, role, password);
  console.log(`Role ${role} is ready: data access only, the audit log append-only. Point the API's DATABASE_URL at it.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { await db.close(); }
