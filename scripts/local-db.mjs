// Runs a private PostgreSQL inside the project folder (.localdb/), so no system install is needed
// for local use. Keep this window open while using the app. For a server, use a real PostgreSQL.
// Usage: npm run db:local
import fs from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import dotenv from "dotenv";

const root = path.resolve(import.meta.dirname, "..");
dotenv.config({ path: path.join(root, ".env") });

const url = new URL(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/digitmarketing");
const dir = path.join(root, ".localdb");
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: decodeURIComponent(url.username || "postgres"),
  password: decodeURIComponent(url.password || "postgres"),
  port: Number(url.port || 5433),
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
});

if (!fs.existsSync(path.join(dir, "PG_VERSION"))) {
  console.log("Creating the local database (first run only)…");
  await pg.initialise();
}
await pg.start();
const dbName = url.pathname.replace(/^\//, "") || "digitmarketing";
try {
  await pg.createDatabase(dbName);
  console.log(`Created database "${dbName}"`);
} catch {
  /* already exists */
}
console.log(`Local PostgreSQL ready on port ${url.port || 5433} (database "${dbName}"). Press Ctrl+C to stop.`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
