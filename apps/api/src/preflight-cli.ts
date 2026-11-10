/**
 * Before a release:  pnpm --filter @quintara/api preflight
 * Checks the settings in this environment (as the API will, at start-up) and, with DATABASE_URL, the database the API
 * will use. Prints every problem and exits 1 if any would stop or endanger the deployment.
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPostgresDb } from './db.ts';
import { checkDatabase, checkDeployment } from './preflight.ts';

const settings = checkDeployment(process.env);
const errors = [...settings.errors], warnings = [...settings.warnings];
if (process.env.DATABASE_URL) {
  const db = createPostgresDb(process.env.DATABASE_URL);
  try {
    const files = (await readdir(fileURLToPath(new URL('../../../db/migrations/', import.meta.url)))).filter((f) => f.endsWith('.sql')).sort();
    // In a release, before the migrate step, the new version's migrations are expected to be pending.
    const found = await checkDatabase(db, files, { pendingAllowed: process.env.PREFLIGHT_PENDING_MIGRATIONS === 'allow' });
    errors.push(...found.errors); warnings.push(...found.warnings);
  } catch (error) {
    errors.push(`The database could not be reached or read: ${error instanceof Error ? error.message : String(error)}`);
  } finally { await db.close(); }
}
const environment = process.env.DEPLOY_ENV === 'staging' ? 'staging' : 'production';
console.log(`Preflight for ${environment}.`);
for (const w of warnings) console.log(`  warning: ${w}`);
for (const e of errors) console.log(`  PROBLEM: ${e}`);
console.log(errors.length ? `${errors.length} problem(s): do not deploy until they are fixed.` : `Ready: no problems${warnings.length ? `; ${warnings.length} warning(s) to decide on` : ''}.`);
process.exit(errors.length ? 1 : 0);
