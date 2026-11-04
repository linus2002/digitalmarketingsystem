import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { one, pool, q } from "../lib/db.js";
import { DEFAULT_BRAND, DEFAULT_CONSENT, DEFAULT_RETENTION } from "../lib/settings.js";
import { SYSTEM_TEMPLATES, AGENT_TEMPLATES } from "./templates.js";

const DEFAULT_SOURCES: { name: string; kind: "rss" | "pubmed" | "newsapi"; url?: string; query?: string; enabled: boolean }[] = [
  { name: "WHO news", kind: "rss", url: "https://www.who.int/rss-feeds/news-english.xml", enabled: true },
  { name: "FDA press releases", kind: "rss", url: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml", enabled: true },
  { name: "European Medicines Agency news", kind: "rss", url: "https://www.ema.europa.eu/en/news.xml", enabled: true },
  { name: "ScienceDaily: cancer", kind: "rss", url: "https://www.sciencedaily.com/rss/health_medicine/cancer.xml", enabled: true },
  { name: "ScienceDaily: pharmacology", kind: "rss", url: "https://www.sciencedaily.com/rss/health_medicine/pharmacology.xml", enabled: true },
  { name: "Medical Xpress: cancer", kind: "rss", url: "https://medicalxpress.com/rss-feed/cancer-news/", enabled: true },
  { name: "PubMed: oncology drug therapy", kind: "pubmed", query: "(neoplasms[mh] OR oncology[tiab]) AND (drug therapy[sh] OR clinical trial[pt])", enabled: true },
  { name: "NewsAPI: pharma and oncology", kind: "newsapi", query: "oncology OR \"cancer drug\" OR pharmaceutical", enabled: false },
];

export async function seed() {
  // Settings: only insert when missing, so re-running never overwrites edits.
  const defaults: Record<string, unknown> = { brand: DEFAULT_BRAND, retention: DEFAULT_RETENTION, consent: DEFAULT_CONSENT };
  for (const [key, value] of Object.entries(defaults)) {
    await q("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, JSON.stringify(value)]);
  }

  const users = await one<{ n: number }>("SELECT count(*)::int AS n FROM users");
  if (!users?.n) {
    if (!env.ADMIN_EMAIL || env.ADMIN_PASSWORD.length < 12) {
      console.warn("No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters) in .env and run `npm run db:seed` again.");
    } else {
      const hash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);
      await q("INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,'admin')", [
        env.ADMIN_EMAIL.toLowerCase(),
        env.ADMIN_NAME,
        hash,
      ]);
      console.log(`Created admin ${env.ADMIN_EMAIL}. Remove ADMIN_PASSWORD from .env now.`);
    }
  }

  const sources = await one<{ n: number }>("SELECT count(*)::int AS n FROM trend_sources");
  if (!sources?.n) {
    for (const s of DEFAULT_SOURCES) {
      await q("INSERT INTO trend_sources (name, kind, url, query, enabled) VALUES ($1,$2,$3,$4,$5)", [s.name, s.kind, s.url ?? null, s.query ?? null, s.enabled]);
    }
    console.log(`Added ${DEFAULT_SOURCES.length} trend sources.`);
  }

  // System templates the assistant sends automatically. Seeded as approved; edits must be re-approved.
  for (const t of SYSTEM_TEMPLATES) {
    await q(
      `INSERT INTO response_templates (key, name, category, body, status, approved_at)
       VALUES ($1,$2,$3,$4,'approved', now()) ON CONFLICT (key) DO NOTHING`,
      [t.key, t.name, t.category, t.body],
    );
  }
  const agentCount = await one<{ n: number }>("SELECT count(*)::int AS n FROM response_templates WHERE key IS NULL");
  if (!agentCount?.n) {
    for (const t of AGENT_TEMPLATES) {
      await q(`INSERT INTO response_templates (name, category, body, status, approved_at) VALUES ($1,$2,$3,'approved', now())`, [t.name, t.category, t.body]);
    }
  }
  console.log("Seed complete.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
