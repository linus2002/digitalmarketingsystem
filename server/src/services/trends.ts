import { XMLParser } from "fast-xml-parser";
import { env } from "../config/env.js";
import { q } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { chatJson } from "./ai.js";

// Trend discovery uses only feeds and APIs that publish for reuse: RSS, NCBI E-utilities, NewsAPI (with a key).
// It reads headlines and summaries; it never visits personal pages or social profiles.

export interface FeedItem {
  title: string;
  summary: string;
  link: string;
  published: Date | null;
  source: string;
}

export interface TrendTopic {
  rank: number;
  phrase: string;
  label: string;
  score: number;
  mentions: number;
  sources: string[];
  category: "oncology" | "pharmaceutical" | "medicine" | "healthcare";
  items: { title: string; link: string; source: string; published: string | null }[];
  why?: string;
  angle?: string;
}

const UA = "GetMedsMarketingHub/1.0 (trend monitor; RSS reader)";
// Entities are decoded by clean() instead: some feeds (e.g. WHO) exceed the parser's entity limit.
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", processEntities: false });

const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function txt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === "object") return txt((v as Record<string, unknown>)["#text"] ?? "");
  return "";
}

function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/<[^>]+>/g, " ") // again, for HTML that was entity-escaped inside the feed
    .replace(/\s+/g, " ")
    .trim();
}

function date(v: unknown): Date | null {
  const s = txt(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function fetchRss(url: string, source: string): Promise<FeedItem[]> {
  const doc = xml.parse(await getText(url, { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }));
  const rssItems = arr(doc?.rss?.channel?.item ?? doc?.["rdf:RDF"]?.item);
  const items: FeedItem[] = rssItems.map((i: Record<string, unknown>) => ({
    title: clean(txt(i.title)),
    summary: clean(txt(i.description ?? i["content:encoded"])).slice(0, 700),
    link: txt(i.link) || txt(i.guid),
    published: date(i.pubDate ?? i["dc:date"]),
    source,
  }));
  for (const e of arr(doc?.feed?.entry) as Record<string, unknown>[]) {
    const links = arr(e.link as Record<string, string> | Record<string, string>[]);
    const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
    items.push({
      title: clean(txt(e.title)),
      summary: clean(txt(e.summary ?? e.content)).slice(0, 700),
      link: alt?.["@_href"] ?? "",
      published: date(e.updated ?? e.published),
      source,
    });
  }
  return items.filter((i) => i.title);
}

export async function fetchPubmed(query: string, source: string, days = 7): Promise<FeedItem[]> {
  const key = env.NCBI_API_KEY ? `&api_key=${encodeURIComponent(env.NCBI_API_KEY)}` : "";
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const search = JSON.parse(
    await getText(`${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=60&sort=pub_date&datetype=edat&reldate=${days}&term=${encodeURIComponent(query)}${key}`),
  ) as { esearchresult?: { idlist?: string[] } };
  const ids = search.esearchresult?.idlist ?? [];
  if (!ids.length) return [];
  const summary = JSON.parse(await getText(`${base}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}${key}`)) as {
    result?: Record<string, { title?: string; source?: string; sortpubdate?: string; pubdate?: string }>;
  };
  return ids
    .map((id) => {
      const r = summary.result?.[id];
      return {
        title: clean(r?.title ?? ""),
        summary: "", // only titles are ranked for PubMed
        link: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        published: date(r?.sortpubdate ?? r?.pubdate),
        source,
      };
    })
    .filter((i) => i.title);
}

export async function fetchNewsApi(query: string, source: string, days = 7): Promise<FeedItem[]> {
  if (!env.NEWSAPI_KEY) throw new Error("NEWSAPI_KEY isn't set in .env");
  const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const data = JSON.parse(
    await getText(`https://newsapi.org/v2/everything?language=en&sortBy=publishedAt&pageSize=60&from=${from}&q=${encodeURIComponent(query)}`, {
      "X-Api-Key": env.NEWSAPI_KEY,
    }),
  ) as { articles?: { title?: string; description?: string; url?: string; publishedAt?: string; source?: { name?: string } }[] };
  return (data.articles ?? []).map((a) => ({
    title: clean(a.title ?? ""),
    summary: clean(a.description ?? ""),
    link: a.url ?? "",
    published: date(a.publishedAt),
    source: a.source?.name ? `${a.source.name} (via NewsAPI)` : source,
  }));
}

// ---------------- Ranking ----------------

const STOP = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each " +
    "few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our out " +
    "over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while " +
    "who whom why will with would you your yours new news study studies research researchers finds find found shows show says said say may might could report reports reported " +
    "people year years week weeks day days month months according university team data results result help helps using use used via first one two three four five also among " +
    "within without latest update updates today announces announced launch launches press release statement says global world million billion percent per many much " +
    "published publishes journal article review reviews findings finding suggests suggest reveals revealed linked associated " +
    "based may might likely increase increased higher lower reduces reduced role effect effects impact " +
    // Agency names are sources, not topics ("Food and Drug Administration" must not become "drug administration")
    "administration agency institute institutes national centers center organization department ministry"
  ).split(/\s+/),
);

const LEX = {
  oncology:
    "cancer cancers oncology oncologic tumor tumour tumors tumours chemotherapy chemo immunotherapy carcinoma leukemia leukaemia lymphoma myeloma melanoma metastatic metastasis " +
    "radiotherapy radiation car-t sarcoma glioblastoma glioma breast lung prostate colorectal pancreatic ovarian cervical bladder kidney liver gastric thyroid neoplasm neoplasms",
  pharmaceutical:
    "drug drugs fda ema approval approved approves pharmaceutical pharma biosimilar biosimilars generic generics inhibitor inhibitors antibody antibodies medication medications " +
    "recall shortage label dosing formulary pricing patent manufacturer manufacturing biologic biologics adc conjugate",
  medicine: "trial trials phase clinical therapy therapies treatment treatments vaccine vaccines medicine medicines diagnosis screening diagnostic gene genetic",
  healthcare: "health hospital hospitals patients patient care outbreak disease diseases public who access insurance coverage mental diabetes heart stroke",
};
const LEX_SETS = Object.fromEntries(Object.entries(LEX).map(([k, v]) => [k, new Set(v.split(/\s+/))])) as Record<keyof typeof LEX, Set<string>>;
const DRUG_SUFFIX = /(mab|nib|lib|parib|ciclib|tinib|zumab|ximab|cel|leucel|platin|taxel|rubicin|stat|tide)$/;

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length > 1 && !/^\d+$/.test(t));
}

function categoryFor(words: string[]): TrendTopic["category"] {
  if (words.some((w) => LEX_SETS.oncology.has(w))) return "oncology";
  if (words.some((w) => LEX_SETS.pharmaceutical.has(w) || DRUG_SUFFIX.test(w))) return "pharmaceutical";
  if (words.some((w) => LEX_SETS.medicine.has(w))) return "medicine";
  return "healthcare";
}

function lexHits(words: string[]): number {
  return words.filter((w) => LEX_SETS.oncology.has(w) || LEX_SETS.pharmaceutical.has(w) || LEX_SETS.medicine.has(w) || DRUG_SUFFIX.test(w)).length;
}

const titleCase = (s: string) =>
  s.replace(/\b([a-z])([a-z-]*)/g, (_, a: string, b: string) => (["fda", "who", "ema", "nih", "car-t", "adc"].includes(a + b) ? (a + b).toUpperCase() : a.toUpperCase() + b));

export function rankTopics(items: FeedItem[], top = 5): TrendTopic[] {
  const now = Date.now();
  const phrases = new Map<string, { score: number; items: Set<number>; sources: Set<string> }>();

  items.forEach((item, idx) => {
    const ageDays = item.published ? Math.max(0, (now - item.published.getTime()) / 86400_000) : 3;
    const recency = Math.exp(-ageDays / 4);
    const seen = new Set<string>();
    const add = (p: string, w: number) => {
      if (seen.has(p)) return;
      seen.add(p);
      const e = phrases.get(p) ?? { score: 0, items: new Set<number>(), sources: new Set<string>() };
      e.score += w * recency;
      e.items.add(idx);
      e.sources.add(item.source);
      phrases.set(p, e);
    };
    for (const [text, weight] of [
      [item.title, 2],
      [item.summary, 1],
    ] as const) {
      // Build phrases within one clause only, so words either side of a full stop or comma are never joined
      // ("…medicine. The findings…" must not become "medicine the findings").
      for (const clause of text.split(/[.!?;:,()[\]{}"“”|–—]+|\s-\s/)) {
        const t = tokens(clause);
        for (let n = 2; n <= 3; n++) {
          for (let i = 0; i + n <= t.length; i++) {
            const gram = t.slice(i, i + n);
            // No filler words anywhere in a phrase: "lung cancer screening" yes, "diagnosis and treatment" no
            if (gram.some((g) => STOP.has(g))) continue;
            add(gram.join(" "), weight);
          }
        }
        // Single words only when they look like a drug name (e.g. pembrolizumab, osimertinib)
        for (const w of t) if (w.length > 6 && DRUG_SUFFIX.test(w) && !STOP.has(w)) add(w, weight * 1.2);
      }
    }
  });

  const minItems = items.length > 40 ? 2 : 1;
  const scored = [...phrases.entries()]
    .filter(([, e]) => e.items.size >= minItems)
    .map(([p, e]) => {
      const words = p.split(" ");
      const relevance = 1 + 0.6 * lexHits(words) + (words.some((w) => LEX_SETS.oncology.has(w)) ? 0.6 : 0);
      const sourceBonus = 1 + 0.5 * (e.sources.size - 1);
      return { p, e, words, score: e.score * relevance * sourceBonus * (lexHits(words) ? 1 : 0.35) };
    })
    .sort((a, b) => b.score - a.score);

  // Pick the top phrases, merging near-duplicates, and keep a mix: at most 3 from one category
  // in the first pass; the second pass fills any remaining slots regardless of category.
  const chosen: typeof scored = [];
  const perCategory = new Map<string, number>();
  const cap = Math.max(1, top - 2);
  for (const pass of [1, 2]) {
    for (const cand of scored) {
      if (chosen.length >= top) break;
      if (chosen.includes(cand)) continue;
      const dup = chosen.find((c) => {
        if (c.p.includes(cand.p) || cand.p.includes(c.p)) return true;
        const inter = [...cand.e.items].filter((i) => c.e.items.has(i)).length;
        return inter / Math.min(cand.e.items.size, c.e.items.size) > 0.6;
      });
      if (dup) {
        if (pass === 1) {
          cand.e.items.forEach((i) => dup.e.items.add(i));
          cand.e.sources.forEach((s) => dup.e.sources.add(s));
        }
        continue;
      }
      const cat = categoryFor(cand.words);
      if (pass === 1 && (perCategory.get(cat) ?? 0) >= cap) continue;
      perCategory.set(cat, (perCategory.get(cat) ?? 0) + 1);
      chosen.push(cand);
    }
  }
  chosen.sort((a, b) => b.score - a.score);

  const max = chosen[0]?.score || 1;
  return chosen.map((c, i) => {
    const its = [...c.e.items]
      .map((n) => items[n])
      .sort((a, b) => (b.published?.getTime() ?? 0) - (a.published?.getTime() ?? 0))
      .slice(0, 4)
      .map((it) => ({ title: it.title, link: it.link, source: it.source, published: it.published?.toISOString() ?? null }));
    return {
      rank: i + 1,
      phrase: c.p,
      label: titleCase(c.p),
      score: Math.round((c.score / max) * 100),
      mentions: c.e.items.size,
      sources: [...c.e.sources],
      category: categoryFor(c.words),
      items: its,
    };
  });
}

async function enrichWithAi(topics: TrendTopic[]): Promise<boolean> {
  if (!topics.length) return false;
  try {
    // Kept short on purpose: a CPU-only local model spends most of its time reading the prompt.
    const listing = topics
      .map((t, i) => `${i + 1}. "${t.phrase}"\n${t.items.slice(0, 2).map((it) => `   - ${it.title.slice(0, 140)}`).join("\n")}`)
      .join("\n");
    const out = await chatJson<{ topics?: { index: number; label?: string; why?: string; angle?: string }[] }>({
      system:
        "You help a pharmaceutical company's marketing team understand healthcare news. Be factual and cautious. " +
        "Never invent facts beyond the headlines given. Never give medical advice. Reply in JSON only.",
      prompt:
        `Here are trending phrases with the headlines they came from:\n${listing}\n\n` +
        `For each, return {"topics":[{"index":1,"label":"a clear 2-6 word topic name","why":"one sentence on why it's in the news, based only on the headlines",` +
        `"angle":"one sentence on an educational, compliant post idea"}]}`,
      temperature: 0.3,
      effort: "low",
      maxTokens: 700,
      // Runs in the background, so it can take its time on a slow machine.
      timeoutMs: 360_000,
    });
    for (const t of out.topics ?? []) {
      const topic = topics[t.index - 1];
      if (!topic) continue;
      if (t.label) topic.label = String(t.label).slice(0, 80);
      if (t.why) topic.why = String(t.why).slice(0, 300);
      if (t.angle) topic.angle = String(t.angle).slice(0, 300);
    }
    return true;
  } catch (err) {
    log.warn("Trend AI enrichment skipped", { error: errMsg(err) });
    return false;
  }
}

export async function refreshTrends(userId: number | null, opts: { days?: number; useAi?: boolean } = {}) {
  const days = opts.days ?? 7;
  const sources = await q<{ id: number; name: string; kind: string; url: string | null; query: string | null }>(
    "SELECT id, name, kind, url, query FROM trend_sources WHERE enabled ORDER BY id",
  );
  const errors: { source: string; error: string }[] = [];
  let ok = 0;
  const results = await Promise.all(
    sources.map(async (s) => {
      try {
        let items: FeedItem[] = [];
        if (s.kind === "rss" && s.url) items = await fetchRss(s.url, s.name);
        else if (s.kind === "pubmed" && s.query) items = await fetchPubmed(s.query, s.name, days);
        else if (s.kind === "newsapi" && s.query) items = await fetchNewsApi(s.query, s.name, days);
        ok++;
        return items;
      } catch (err) {
        errors.push({ source: s.name, error: errMsg(err) });
        return [];
      }
    }),
  );
  const cutoff = Date.now() - days * 86400_000;
  const items = results.flat().filter((i) => !i.published || i.published.getTime() >= cutoff);
  const topics = rankTopics(items, 5);
  const useAi = opts.useAi !== false && topics.length > 0;
  const [snap] = await q(
    `INSERT INTO trend_snapshots (topics, items_scanned, sources_ok, source_errors, ai_enriched, ai_status, created_by)
     VALUES ($1,$2,$3,$4,false,$5,$6) RETURNING *`,
    [JSON.stringify(topics), items.length, ok, JSON.stringify(errors), useAi ? "pending" : "off", userId],
  );
  // The ranked topics are returned straight away; the AI summaries are written in the background
  // and saved onto the same snapshot (the Trends page checks back until they're in).
  if (useAi) void addAiSummaries(snap.id as number, topics);
  return snap;
}

async function addAiSummaries(snapshotId: number, topics: TrendTopic[]) {
  const ok = await enrichWithAi(topics);
  await q("UPDATE trend_snapshots SET topics=$2, ai_enriched=$3, ai_status=$4 WHERE id=$1", [snapshotId, JSON.stringify(topics), ok, ok ? "done" : "failed"]).catch((err) =>
    log.error("Saving trend summaries failed", { error: errMsg(err) }),
  );
}
