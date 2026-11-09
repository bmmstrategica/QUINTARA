import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));

/** Applies every migration that has not run yet, in file-name order, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((row) => row.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = await readFile(MIGRATIONS_DIR + name, 'utf8');
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${name.replace(/'/g, "''")}');\nCOMMIT;`);
    applied.push(name);
  }
  return applied;
}
