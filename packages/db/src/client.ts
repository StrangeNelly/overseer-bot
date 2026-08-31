import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Accepts either the root client or a transaction handle. */
export type DbLike = Db | Tx;

export function createDb(databaseUrl: string): { db: Db; client: ReturnType<typeof postgres> } {
  // Supabase's transaction pooler doesn't support prepared statements
  // (transactions themselves are fine).
  const client = postgres(databaseUrl, { prepare: false });
  const db = drizzle(client, { schema });
  return { db, client };
}
