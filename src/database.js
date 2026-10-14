import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';

/** @typedef {{query: (sql: string, values?: any[]) => Promise<{rows: any[]}>}} Queryable */
/** @typedef {Queryable & {transaction: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>}} Database */

/** @param {string} url @returns {Database & {close: () => Promise<void>}} */
export function connectDatabase(url) {
  if (!url) throw new Error('DATABASE_URL required');
  const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  if (process.env.VERCEL) attachDatabasePool(pool);
  return {
    query: (sql, values) => pool.query(sql, values),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
