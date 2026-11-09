import { createPostgresDb } from './db.ts';
import { migrate } from './migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to run migrations.');
  process.exit(1);
}
const db = createPostgresDb(url);
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply.');
await db.close();
