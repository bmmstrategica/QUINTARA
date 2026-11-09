/**
 * A small database interface with two implementations:
 * PostgreSQL through `pg` for real environments, and PGlite (PostgreSQL compiled
 * to WebAssembly, in memory) for local development and tests. Both run the same SQL.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs several statements with no parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Everything inside commits together or not at all. */
  tx<T>(work: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPostgresDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params)).rows as T[];
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({ query: async <T extends Row>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[] });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function createMemoryDb(): Db {
  const lite = new PGlite();
  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await lite.query<T>(sql, params)).rows;
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    tx: (work) =>
      lite.transaction((tx) => work({ query: async <T extends Row>(sql: string, params: unknown[] = []) => (await tx.query<T>(sql, params)).rows })) as Promise<never>,
    close: () => lite.close(),
  };
}
