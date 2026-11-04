import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pool } from "../lib/db.js";

const DIR = path.resolve(import.meta.dirname, "../../migrations");

export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
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
