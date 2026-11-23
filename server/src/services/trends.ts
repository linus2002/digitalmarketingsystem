import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { XMLParser } from "fast-xml-parser";
import { env } from "../config/env.js";
import { one, q, type Row } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { getSetting } from "../lib/settings.js";
import { chatJson } from "./ai.js";

// Trend discovery uses only feeds and APIs that publish for reuse: RSS, Google Trends' public "Trending now" feed,
// NCBI E-utilities, NewsAPI (with a key) and, if switched on, Ollama web search (trend search terms only).
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

/** A code point from an HTML entity, or a space if it isn't a valid character (String.fromCodePoint throws on those). */
function codePoint(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return " ";
  return String.fromCodePoint(n);
}

/** Only http(s) links are kept from feeds: "javascript:" and other schemes would run in the browser when clicked. */
export function safeLink(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
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
    .replace(/&#(\d{1,8});/g, (_, n: string) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,8});/gi, (_, n: string) => codePoint(parseInt(n, 16)))
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

// Feeds are a few hundred KB at most; anything far bigger is not a feed and isn't read into memory.
const MAX_FEED_BYTES = 5 * 1024 * 1024;

/** Reads a response body, stopping with an error once it passes the size limit. */
async function readLimited(res: Response, limit = MAX_FEED_BYTES): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > limit) throw new Error(`The feed is too large (over ${Math.round(limit / 1024 / 1024)} MB)`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`The feed is too large (over ${Math.round(limit / 1024 / 1024)} MB)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------- Feed address checks (no requests to this server or the private network) ----------------

function privateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast and reserved
  );
}

function privateIp(ip: string): boolean {
  if (isIP(ip) === 4) return privateIPv4(ip);
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateIPv4(mapped[1]);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff") || v6.startsWith("::ffff:");
}

/** True if the address is a public http(s) URL; otherwise a sentence saying why not. */
export async function isPublicFeedUrl(raw: string): Promise<true | string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Enter a full web address starting with https://";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http:// and https:// addresses can be used";
  if (u.username || u.password) return "Addresses with a user name or password can't be used";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    return "Addresses on this computer or the local network can't be used";
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      return "That web address couldn't be found";
    }
  }
  if (!addrs.length || addrs.some(privateIp)) return "Addresses on this computer or the local network can't be used";
  return true;
}

/**
 * Fetches a feed. Addresses typed in Settings (`checkHost`) are checked before every request, including each redirect,
 * so a feed can't point the server at itself, the local AI or other machines on the network.
 */
async function getText(url: string, headers: Record<string, string> = {}, checkHost = false): Promise<string> {
  let target = url;
  for (let hop = 0; hop < 5; hop++) {
    if (checkHost) {
      const ok = await isPublicFeedUrl(target);
      if (ok !== true) throw new Error(ok);
    }
    const res = await fetch(target, {
      headers: { "User-Agent": UA, ...headers },
      signal: AbortSignal.timeout(20_000),
      redirect: checkHost ? "manual" : "follow",
    });
    if (checkHost && res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      target = new URL(res.headers.get("location")!, target).toString();
      await res.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return readLimited(res);
  }
  throw new Error("Too many redirects");
}

export async function fetchRss(url: string, source: string): Promise<FeedItem[]> {
  const doc = xml.parse(await getText(url, { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, true));
  const rssItems = arr(doc?.rss?.channel?.item ?? doc?.["rdf:RDF"]?.item);
  const items: FeedItem[] = rssItems.map((i: Record<string, unknown>) => ({
    title: clean(txt(i.title)),
    summary: clean(txt(i.description ?? i["content:encoded"])).slice(0, 700),
    link: safeLink(txt(i.link)) || safeLink(txt(i.guid)),
    published: date(i.pubDate ?? i["dc:date"]),
    source,
  }));
  for (const e of arr(doc?.feed?.entry) as Record<string, unknown>[]) {
    const links = arr(e.link as Record<string, string> | Record<string, string>[]);
    const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
    items.push({
      title: clean(txt(e.title)),
      summary: clean(txt(e.summary ?? e.content)).slice(0, 700),
      link: safeLink(alt?.["@_href"]),
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
    link: safeLink(a.url),
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
      timeoutMs: AI_STEP_MS.topics,
      queueTimeoutMs: AI_QUEUE_MS,
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

// ---------------- Google Trends ("Trending now") ----------------

export interface GoogleTrend {
  term: string;
  /** Country code(s) it's trending in, e.g. "PH" or "PH, SG" */
  geo: string;
  traffic: string;
  trafficNum: number;
  published: string | null;
  news: { title: string; url: string; source: string }[];
  web?: { title: string; url: string }[];
  /** Picture for the card background (Google Trends' picture for a search; news stories have none) */
  image?: string;
  overview?: string;
  angle?: string;
  /**
   * How the item was judged health-related: by the AI, by keyword rules while the AI hasn't checked it,
   * or "news": not a search at all but a top story from Google News' Health section (the fallback).
   */
  matchedBy: "ai" | "keywords" | "news";
}

export interface GoogleBlock {
  /** Trending searches read in this scan (all topics) */
  scanned: number;
  /** Searches the AI has already sorted into health / not health (lower-case) */
  checked: string[];
  /** The health-related searches, or the Google News health stories when no search is about health */
  items: GoogleTrend[];
  /** Top Google News health stories, shown in place of searches when none of the trending searches are about health */
  news?: GoogleTrend[];
}

/** Google's trending searches have no health filter, so on most days none are about health. Show health news instead then. */
function applyNewsFallback(block: GoogleBlock) {
  if (!block.items.some((g) => g.matchedBy !== "news")) block.items = (block.news ?? []).slice(0, MAX_GOOGLE);
}

export interface LiveTrendSettings {
  webSearch: boolean;
}
export const DEFAULT_LIVE: LiveTrendSettings = { webSearch: false };
export const getLiveSettings = () => getSetting<LiveTrendSettings>("trends.live", DEFAULT_LIVE);

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
export function countryName(geo: string): string {
  try {
    return regionNames.of(geo) ?? geo;
  } catch {
    return geo;
  }
}

function trafficNum(t: string): number {
  const m = t.replace(/[,+\s]/g, "").match(/^(\d+(?:\.\d+)?)([KM]?)$/i);
  if (!m) return 0;
  const unit = m[2].toUpperCase();
  return Number(m[1]) * (unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1);
}

export async function fetchGoogleTrends(geo: string): Promise<GoogleTrend[]> {
  const doc = xml.parse(await getText(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`, { Accept: "application/rss+xml, application/xml" }));
  return arr(doc?.rss?.channel?.item as Record<string, unknown>[] | undefined)
    .map((i): GoogleTrend => {
      const traffic = clean(txt(i["ht:approx_traffic"]));
      const picture = txt(i["ht:picture"]);
      return {
        ...(/^https:\/\//.test(picture) ? { image: picture } : {}),
        term: clean(txt(i.title)),
        geo,
        traffic,
        trafficNum: trafficNum(traffic),
        published: date(i.pubDate)?.toISOString() ?? null,
        news: arr(i["ht:news_item"] as Record<string, unknown>[] | undefined)
          .slice(0, 3)
          .map((n) => ({ title: clean(txt(n["ht:news_item_title"])), url: safeLink(txt(n["ht:news_item_url"])), source: clean(txt(n["ht:news_item_source"])) }))
          .filter((n) => n.title && n.url),
        matchedBy: "keywords",
      };
    })
    .filter((t) => t.term);
}

/** Top stories from Google News' Health section for a country (public RSS). Stories that mention health words come first. */
export async function fetchGoogleNewsHealth(geo: string): Promise<GoogleTrend[]> {
  const g = encodeURIComponent(geo.toUpperCase());
  const doc = xml.parse(
    await getText(`https://news.google.com/rss/headlines/section/topic/HEALTH?hl=en-${g}&gl=${g}&ceid=${g}:en`, { Accept: "application/rss+xml, application/xml" }),
  );
  return arr(doc?.rss?.channel?.item as Record<string, unknown>[] | undefined)
    .map((i): GoogleTrend => {
      const source = clean(txt(i.source));
      let title = clean(txt(i.title));
      // Google News titles end with " - Publisher"
      if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
      const url = safeLink(txt(i.link));
      return {
        term: title,
        geo,
        traffic: "",
        trafficNum: 0,
        published: date(i.pubDate)?.toISOString() ?? null,
        news: url ? [{ title, url, source: source || "Google News" }] : [],
        matchedBy: "news",
      };
    })
    .filter((t) => t.term)
    .map((t, order) => ({ t, order, hit: healthHits(tokens(t.term)) > 0 ? 1 : 0 }))
    .sort((a, b) => b.hit - a.hit || a.order - b.order)
    .map((x) => x.t);
}

// Everyday health words people search for, on top of the oncology/pharma lexicon used for news.
const HEALTH_WORDS = new Set(
  (
    "health medicine medicines medical drugstore pharmacy pharmacist pharmaceutical doctor doctors hospital hospitals clinic doh fda vaccine vaccines vaccination " +
    "virus viral outbreak disease diseases infection infections symptoms symptom fever flu influenza covid covid-19 dengue measles mpox polio cholera leptospirosis " +
    "tuberculosis hiv aids hepatitis diabetes insulin hypertension stroke asthma allergy allergies antibiotic antibiotics paracetamol ibuprofen tablet tablets pill pills " +
    "prescription surgery philhealth epidemic pandemic vitamins vitamin supplement supplements cholesterol kidney dialysis pneumonia rabies typhoid malaria"
  ).split(/\s+/),
);
const healthHits = (words: string[]) =>
  new Set(words.filter((w) => HEALTH_WORDS.has(w) || LEX_SETS.oncology.has(w) || LEX_SETS.pharmaceutical.has(w) || (w.length > 6 && DRUG_SUFFIX.test(w)))).size;

/** Keyword guess, used until the AI has checked a search: the term is a health word, or its news clearly is. */
function looksHealthRelated(t: GoogleTrend): boolean {
  if (healthHits(tokens(t.term)) > 0) return true;
  return healthHits(tokens(t.news.map((n) => n.title).join(" "))) >= 2;
}

/** Ollama's hosted web search (needs OLLAMA_API_KEY). Only the trend search term is sent. */
async function webSearch(query: string): Promise<{ title: string; url: string; content: string }[]> {
  const res = await fetch("https://ollama.com/api/web_search", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: 3 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(res.status === 401 ? "Ollama rejected OLLAMA_API_KEY" : `Ollama web search returned HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? [])
    .map((r) => ({ title: clean(r.title ?? ""), url: safeLink(r.url), content: clean(r.content ?? "").slice(0, 400) }))
    .filter((r) => r.url);
}

const MAX_GOOGLE = 6;

// ---------------- Scan ----------------

// The background AI steps: topic summaries, sorting Google searches, then overviews. Each may wait for a free AI slot first.
const AI_STEP_MS = { topics: 360_000, sort: 240_000, overview: 360_000 };
const AI_QUEUE_MS = 5 * 60_000;
/** Longest the background AI steps can take altogether (plus a margin); older "pending" snapshots were interrupted. */
export const AI_STEPS_TIMEOUT_MINUTES = Math.ceil((AI_STEP_MS.topics + AI_STEP_MS.sort + AI_STEP_MS.overview + 3 * AI_QUEUE_MS + 60_000) / 60_000) + 5;

let summarising = false;
/** True while the AI is writing summaries in the background (the auto-refresh waits for it). */
export const isSummarising = () => summarising;

export async function refreshTrends(userId: number | null, opts: { days?: number; useAi?: boolean } = {}) {
  const days = opts.days ?? 7;
  const sources = await q<{ id: number; name: string; kind: string; url: string | null; query: string | null }>(
    "SELECT id, name, kind, url, query FROM trend_sources WHERE enabled ORDER BY id",
  );
  const errors: { source: string; error: string }[] = [];
  let ok = 0;
  const googleRaw: GoogleTrend[] = [];
  const newsRaw: GoogleTrend[] = [];
  const results = await Promise.all(
    sources.map(async (s) => {
      try {
        let items: FeedItem[] = [];
        if (s.kind === "rss" && s.url) items = await fetchRss(s.url, s.name);
        else if (s.kind === "pubmed" && s.query) items = await fetchPubmed(s.query, s.name, days);
        else if (s.kind === "newsapi" && s.query) items = await fetchNewsApi(s.query, s.name, days);
        else if (s.kind === "google_trends" && s.query) {
          const geo = s.query;
          const [searches, news] = await Promise.all([
            fetchGoogleTrends(geo),
            fetchGoogleNewsHealth(geo).catch((err) => {
              log.warn("Google News health feed failed", { geo, error: errMsg(err) });
              return [] as GoogleTrend[];
            }),
          ]);
          googleRaw.push(...searches);
          newsRaw.push(...news);
        }
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

  // The same search can trend in several countries: keep one entry with the biggest volume.
  const byTerm = new Map<string, GoogleTrend>();
  for (const g of googleRaw) {
    const k = g.term.toLowerCase();
    const cur = byTerm.get(k);
    if (!cur) byTerm.set(k, g);
    else {
      if (!cur.geo.split(", ").includes(g.geo)) cur.geo += `, ${g.geo}`;
      if (g.trafficNum > cur.trafficNum) Object.assign(cur, { traffic: g.traffic, trafficNum: g.trafficNum });
    }
  }
  const candidates = [...byTerm.values()].sort((a, b) => b.trafficNum - a.trafficNum);

  // Reuse what the AI already wrote for topics and searches that were in the last finished scan,
  // so a scan every 30 minutes only spends AI time on what's new.
  const prev = await one<{ topics: TrendTopic[]; google: GoogleBlock }>(
    "SELECT topics, google FROM trend_snapshots WHERE ai_status='done' ORDER BY created_at DESC LIMIT 1",
  );
  const prevTopics = new Map((prev?.topics ?? []).map((t) => [t.phrase, t]));
  for (const t of topics) {
    const p = prevTopics.get(t.phrase);
    if (p?.why) Object.assign(t, { label: p.label, why: p.why, angle: p.angle });
  }
  const prevChecked = new Set(prev?.google?.checked ?? []);
  const prevGoogle = new Map(
    [...(prev?.google?.items ?? []), ...(prev?.google?.news ?? [])]
      .filter((g) => g.matchedBy === "ai" || (g.matchedBy === "news" && g.overview))
      .map((g) => [`${g.matchedBy === "news" ? "news:" : ""}${g.term.toLowerCase()}`, g]),
  );
  const checked: string[] = [];
  const google: GoogleTrend[] = [];
  for (const c of candidates) {
    const k = c.term.toLowerCase();
    if (prevChecked.has(k)) {
      checked.push(k);
      const p = prevGoogle.get(k);
      if (p) google.push({ ...c, matchedBy: "ai", overview: p.overview, angle: p.angle, web: p.web });
    } else if (looksHealthRelated(c)) google.push({ ...c });
  }
  google.sort((a, b) => b.trafficNum - a.trafficNum);
  // Health news fallback: one entry per headline, reusing overviews the AI already wrote.
  const seenNews = new Set<string>();
  const news: GoogleTrend[] = [];
  for (const n of newsRaw) {
    const k = n.term.toLowerCase();
    if (seenNews.has(k)) continue;
    seenNews.add(k);
    const p = prevGoogle.get(`news:${k}`);
    // No image for news: Google News' feed has none, and its story pages only offer the Google News logo.
    news.push(p ? { ...n, overview: p.overview, angle: p.angle, web: p.web } : n);
    if (news.length >= MAX_GOOGLE) break;
  }
  const block: GoogleBlock = { scanned: candidates.length, checked, items: google.slice(0, MAX_GOOGLE), news };
  applyNewsFallback(block);

  const wantAi = opts.useAi !== false;
  const needAi = topics.some((t) => !t.why) || candidates.some((c) => !prevChecked.has(c.term.toLowerCase())) || block.items.some((g) => !g.overview);
  // Decide and claim the AI in one step (no await in between), so a manual and an automatic scan can't both start it.
  const runAi = wantAi && needAi && !summarising;
  if (runAi) summarising = true;
  const aiStatus = runAi ? "pending" : wantAi && !needAi && (topics.length || block.items.length) ? "done" : "off";
  let snap: Row;
  try {
    [snap] = await q(
      `INSERT INTO trend_snapshots (topics, google, items_scanned, sources_ok, source_errors, ai_enriched, ai_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [JSON.stringify(topics), JSON.stringify(block), items.length, ok, JSON.stringify(errors), aiStatus === "done", aiStatus, userId],
    );
  } catch (err) {
    if (runAi) summarising = false;
    throw err;
  }
  // The ranked topics are returned straight away; the AI summaries are written in the background
  // and saved onto the same snapshot (the Trends page checks back until they're in).
  if (runAi) void addAiSummaries(snap.id as number, topics, candidates, block);
  return snap;
}

/** Runs with `summarising` already claimed by refreshTrends; releases it when done. */
async function addAiSummaries(snapshotId: number, topics: TrendTopic[], candidates: GoogleTrend[], block: GoogleBlock) {
  try {
    const missing = topics.filter((t) => !t.why);
    const topicsOk = missing.length ? await enrichWithAi(missing) : true;
    const googleOk = await enrichGoogle(candidates, block);
    const ok = topicsOk && googleOk;
    await q("UPDATE trend_snapshots SET topics=$2, google=$3, ai_enriched=$4, ai_status=$5 WHERE id=$1", [
      snapshotId,
      JSON.stringify(topics),
      JSON.stringify(block),
      ok,
      ok ? "done" : "failed",
    ]);
  } catch (err) {
    log.error("Saving trend summaries failed", { error: errMsg(err) });
    await q("UPDATE trend_snapshots SET ai_status='failed' WHERE id=$1", [snapshotId]).catch(() => undefined);
  } finally {
    summarising = false;
  }
}

/** Sorts new Google searches into health / not health, optionally looks the health ones up on the web, and writes an overview of each. */
async function enrichGoogle(candidates: GoogleTrend[], block: GoogleBlock): Promise<boolean> {
  const done = new Set(block.checked);
  const fresh = candidates.filter((c) => !done.has(c.term.toLowerCase()));
  const context = new Map<GoogleTrend, string>();
  try {
    if (fresh.length) {
      const listing = fresh.map((c, i) => `${i + 1}. "${c.term}"${c.news[0] ? ` (news: ${c.news[0].title.slice(0, 110)})` : ""}`).join("\n");
      const out = await chatJson<{ health?: number[] }>({
        system:
          "You sort Google search trends for a pharmacy's marketing team. A trend counts only if it is about health: a disease or outbreak, " +
          "a medicine or vaccine, a health warning, a medical condition, healthcare services or health policy. " +
          "Sports, politics, celebrities and entertainment do not count, even if someone in the story is ill. Reply in JSON only.",
        prompt: `Which of these are about health?\n${listing}\n\nReply {"health":[numbers]}, or {"health":[]} if none are.`,
        temperature: 0,
        effort: "low",
        maxTokens: 120,
        timeoutMs: AI_STEP_MS.sort,
        queueTimeoutMs: AI_QUEUE_MS,
      });
      const health = new Set(
        (out.health ?? [])
          .map(Number)
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= fresh.length)
          .map((n) => fresh[n - 1].term.toLowerCase()),
      );
      // The AI's decision replaces the keyword guess for every search it has now sorted.
      const keep = block.items.filter((g) => g.matchedBy === "ai");
      const added = fresh.filter((c) => health.has(c.term.toLowerCase())).map((c): GoogleTrend => ({ ...c, matchedBy: "ai" }));
      block.items = [...keep, ...added].sort((a, b) => b.trafficNum - a.trafficNum).slice(0, MAX_GOOGLE);
      block.checked = [...done, ...fresh.map((c) => c.term.toLowerCase())];
      applyNewsFallback(block);
    }

    const todo = block.items.filter((g) => !g.overview);
    if (!todo.length) return true;

    const live = await getLiveSettings();
    if (live.webSearch && env.OLLAMA_API_KEY) {
      await Promise.all(
        todo.map(async (g) => {
          try {
            const r = await webSearch(`${g.term} ${countryName(g.geo.split(", ")[0])}`);
            g.web = r.map(({ title, url }) => ({ title, url }));
            context.set(g, r.map((x) => `${x.title}: ${x.content}`).join(" | ").slice(0, 900));
          } catch (err) {
            log.warn("Web search for a Google trend failed", { term: g.term, error: errMsg(err) });
          }
        }),
      );
    }

    const listing = todo
      .map((g, i) => {
        const ctx = context.get(g);
        const where = g.geo.split(", ").map(countryName).join(", ");
        return (
          (g.matchedBy === "news"
            ? `${i + 1}. "${g.term}" (a top health story on Google News in ${where})\n`
            : `${i + 1}. "${g.term}" (trending in ${where}, ${g.traffic || "unknown"} searches)\n`) +
          g.news.map((n) => `   - news: ${n.title.slice(0, 140)}`).join("\n") +
          (ctx ? `\n   - web: ${ctx}` : "")
        );
      })
      .join("\n");
    const out = await chatJson<{ items?: { index: number; overview?: string; angle?: string }[] }>({
      system:
        "You brief a pharmacy's marketing team on what people are searching for on Google right now. Be factual and cautious: " +
        "use only the news and web results given, and say so if they don't explain the trend. Never give medical advice. Reply in JSON only.",
      prompt:
        `Trending health searches and health stories:\n${listing}\n\n` +
        `For each, return {"items":[{"index":1,"overview":"2-3 sentences: what it is and why people are searching for it or talking about it now",` +
        `"angle":"one sentence: an educational, compliant post idea for the pharmacy"}]}`,
      temperature: 0.3,
      effort: "low",
      maxTokens: 900,
      timeoutMs: AI_STEP_MS.overview,
      queueTimeoutMs: AI_QUEUE_MS,
    });
    for (const it of out.items ?? []) {
      const g = todo[Number(it.index) - 1];
      if (!g) continue;
      if (it.overview) g.overview = String(it.overview).slice(0, 600);
      if (it.angle) g.angle = String(it.angle).slice(0, 300);
    }
    return true;
  } catch (err) {
    log.warn("Google trend AI step skipped", { error: errMsg(err) });
    return false;
  }
}
