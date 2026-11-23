import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pool } from "../lib/db.js";

const DIR = path.resolve(import.meta.dirname, "../../migrations");

// Any fixed number: every process that migrates takes the same session-level advisory lock,
// so two app instances starting together can't apply the same migration twice.
const MIGRATION_LOCK_KEY = 727_401_993;

export async function migrate() {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await lock.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // Read what's applied only after taking the lock: another process may have just finished.
    const done = new Set((await lock.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(DIR, file), "utf8");
      try {
        await lock.query("BEGIN");
        await lock.query(sql);
        await lock.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await lock.query("COMMIT");
        console.log(`Applied ${file}`);
      } catch (err) {
        await lock.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    lock.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  migrate()
    .then(() => {
      console.log("Database is up to date.");
      return pool.end();
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
