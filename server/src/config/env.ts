import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// The .env file lives at the project root (two levels above src/ or dist/).
dotenv.config({ path: path.resolve(import.meta.dirname, "../../../.env") });
dotenv.config();

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? fallback : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())));

const csv = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v : fallback).split(",").map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters (run: npm run gen:keys)"),
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "DATA_ENCRYPTION_KEY must be 64 hex characters (run: npm run gen:keys)"),
  SESSION_HOURS: z.coerce.number().positive().default(10),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: bool(false),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  PUBLIC_FORM_ORIGINS: csv("http://localhost:5173"),
  PRIVACY_POLICY_URL: z.string().default("https://www.example.com/privacy"),
  BUSINESS_NAME: z.string().default("GetMeds"),

  ADMIN_EMAIL: z.string().default(""),
  ADMIN_PASSWORD: z.string().default(""),
  ADMIN_NAME: z.string().default("Administrator"),

  // Which AI writes content: "anthropic" (Claude, cloud) or "ollama" (local model)
  AI_PROVIDER: z.enum(["anthropic", "ollama"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().default(""),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  AI_TIMEOUT_MS: z.coerce.number().default(120_000),
  // Whether inquiry text (health-related personal data) may be sent to the AI provider.
  // Unset: allowed for the local Ollama model, NOT allowed for a cloud provider.
  AI_FOR_INQUIRIES: z.enum(["true", "false", ""]).default(""),
  OLLAMA_URL: z.string().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().default(180_000),

  META_GRAPH_VERSION: z.string().default("v23.0"),
  META_APP_SECRET: z.string().default(""),
  META_VERIFY_TOKEN: z.string().default(""),
  META_PAGE_ID: z.string().default(""),
  META_PAGE_ACCESS_TOKEN: z.string().default(""),
  META_ENABLE_HUMAN_AGENT_TAG: bool(false),
  META_POST_METRICS: csv("post_impressions,post_impressions_unique,post_clicks,post_media_view,post_total_media_view_unique"),
  META_PAGE_METRICS: csv("page_impressions_unique,page_post_engagements,page_follows,page_media_view,page_total_media_view_unique,page_views_total"),
  PUBLISH_DRY_RUN: bool(false),
  MESSENGER_DRY_RUN: bool(false),

  SCHEDULER_ENABLED: bool(true),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().min(5).default(30),
  ANALYTICS_SYNC_HOURS: z.coerce.number().min(0).default(6),

  NEWSAPI_KEY: z.string().default(""),
  NCBI_API_KEY: z.string().default(""),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("\nThe configuration in .env is incomplete:\n");
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  console.error("\nCopy .env.example to .env and fill it in.\n");
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
