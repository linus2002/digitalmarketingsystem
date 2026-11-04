import pg from "pg";
import { env } from "../config/env.js";

// Return bigint (counts) and numeric as JS numbers: values here stay well inside the safe range.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// Keep DATE columns as 'YYYY-MM-DD' strings so time zones can't shift the day.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

pool.on("error", (err) => {
  console.error(JSON.stringify({ level: "error", msg: "Idle database client error", error: err.message }));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export type Db = pg.Pool | pg.PoolClient;

export async function q<T = Row>(text: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const res = await db.query(text, params as unknown[]);
  return res.rows as T[];
}

export async function one<T = Row>(text: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const rows = await q<T>(text, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
