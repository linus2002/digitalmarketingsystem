import { q } from "../lib/db.js";

// Best time to post: when the Page's own posts got the most engagement, by day of the week and time of day
// (Philippine time). Posts are compared by engagement rate (reactions, comments and shares per person reached) when
// Facebook reports reach, otherwise by raw engagement. Few posts in a slot can mislead, so each slot is blended with
// a general pattern for Philippine social media audiences until it has enough posts of its own.

/** Three-hour blocks from 6 AM to midnight. Night posts (midnight to 6 AM) aren't suggested. */
export const BLOCKS = [
  { from: 6, to: 9, hour: 8 },
  { from: 9, to: 12, hour: 11 },
  { from: 12, to: 15, hour: 12 },
  { from: 15, to: 18, hour: 17 },
  { from: 18, to: 21, hour: 19 },
  { from: 21, to: 24, hour: 21 },
] as const;

// General pattern (used alone with little data): lunch and early evening are strongest, weekend mornings weaker.
const BLOCK_PRIOR = [0.85, 0.95, 1.1, 0.9, 1.2, 1.0];
const DAY_PRIOR = [0.92, 1.0, 1.02, 1.04, 1.02, 0.97, 0.9]; // Sunday … Saturday
/** Posts a slot needs before its own results count as much as the general pattern. */
const PRIOR_WEIGHT = 3;
/** Fewer posts than this in total: only the general pattern is used. */
export const MIN_POSTS = 8;
const PH_MS = 8 * 3_600_000;

export interface Cell {
  dow: number;
  block: number;
  n: number;
  score: number;
  /** Percent above (or below) the average slot. */
  lift: number;
  /** The hour within the block that did best (or the block's usual hour). */
  hour: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

export async function bestTimes(opts: { days?: number; suggest?: number } = {}) {
  const days = opts.days ?? 180;
  const posts = await q<{ dow: number; hour: number; engagement: number; reach: number | null }>(
    `SELECT extract(dow FROM created_time AT TIME ZONE 'Asia/Manila')::int AS dow, extract(hour FROM created_time AT TIME ZONE 'Asia/Manila')::int AS hour,
            (reactions + comments + shares)::int AS engagement, reach
     FROM fb_page_posts WHERE created_time >= now() - ($1 || ' days')::interval AND created_time < now() - interval '1 day'`,
    [String(days)],
  );
  // Rate when most posts have reach; posts less than a day old are left out (their numbers are still growing).
  const withReach = posts.filter((p) => (p.reach ?? 0) > 0);
  const metric: "rate" | "engagement" = withReach.length >= Math.max(MIN_POSTS, posts.length * 0.6) ? "rate" : "engagement";
  const used = (metric === "rate" ? withReach : posts).filter((p) => p.hour >= 6);
  const values = used.map((p) => (metric === "rate" ? p.engagement / p.reach! : p.engagement));
  const mid = median(values) || values.reduce((s, v) => s + v, 0) / (values.length || 1) || 1;
  const basis: "your_posts" | "general" = used.length >= MIN_POSTS ? "your_posts" : "general";

  const sums = new Map<string, { n: number; sum: number; hours: Map<number, { n: number; sum: number }> }>();
  used.forEach((p, i) => {
    const block = Math.floor((p.hour - 6) / 3);
    const key = `${p.dow}:${block}`;
    const c = sums.get(key) ?? { n: 0, sum: 0, hours: new Map() };
    const v = values[i] / mid;
    c.n++;
    c.sum += v;
    const h = c.hours.get(p.hour) ?? { n: 0, sum: 0 };
    h.n++;
    h.sum += v;
    c.hours.set(p.hour, h);
    sums.set(key, c);
  });

  const raw: Omit<Cell, "lift">[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let block = 0; block < BLOCKS.length; block++) {
      const prior = BLOCK_PRIOR[block] * DAY_PRIOR[dow];
      const c = sums.get(`${dow}:${block}`);
      const n = c?.n ?? 0;
      const score = basis === "general" || !c ? prior : (c.sum + PRIOR_WEIGHT * prior) / (n + PRIOR_WEIGHT);
      // The hour that did best in this block, if any post was made in it; otherwise the block's usual hour.
      const hour = c && basis === "your_posts" ? [...c.hours.entries()].sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)[0][0] : BLOCKS[block].hour;
      raw.push({ dow, block, n, score, hour });
    }
  }
  const avg = raw.reduce((s, c) => s + c.score, 0) / raw.length;
  const grid: Cell[] = raw.map((c) => ({ ...c, lift: Math.round((c.score / avg - 1) * 100) }));
  const best = [...grid].sort((a, b) => b.score - a.score).slice(0, 3);

  return { basis, metric, sample: used.length, minPosts: MIN_POSTS, grid, best, next: await nextSlots(grid, opts.suggest ?? 4) };
}

/**
 * The next few good times to post (in the coming week), skipping times within an hour of a post that's already
 * planned. Sooner slots win a close call, so the list isn't all next week.
 */
async function nextSlots(grid: Cell[], count: number) {
  const now = Date.now();
  const planned = await q<{ at: Date }>(
    `SELECT scheduled_at AS at FROM posts WHERE scheduled_at BETWEEN now() - interval '1 hour' AND now() + interval '9 days'
     AND status IN ('in_review','approved','scheduled','publishing')`,
  );
  const clash = (t: number) => planned.some((p) => Math.abs(new Date(p.at).getTime() - t) < 60 * 60_000);
  const todayPh = new Date(now + PH_MS);
  const candidates: { at: number; score: number; lift: number }[] = [];
  for (let d = 0; d < 8; d++) {
    const day = new Date(Date.UTC(todayPh.getUTCFullYear(), todayPh.getUTCMonth(), todayPh.getUTCDate() + d));
    const dow = day.getUTCDay();
    for (const c of grid.filter((g) => g.dow === dow)) {
      const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), c.hour) - PH_MS;
      if (at < now + 30 * 60_000 || clash(at)) continue;
      candidates.push({ at, score: c.score * (1 - 0.015 * d), lift: c.lift });
    }
  }
  const picked: typeof candidates = [];
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    if (picked.length >= count) break;
    // Spread them out: at most two a day, and never within 2 hours of each other.
    const sameDay = picked.filter((p) => new Date(p.at + PH_MS).toISOString().slice(0, 10) === new Date(c.at + PH_MS).toISOString().slice(0, 10));
    if (sameDay.length >= 2 || picked.some((p) => Math.abs(p.at - c.at) < 2 * 3_600_000)) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.at - b.at).map((c) => ({ at: new Date(c.at).toISOString(), lift: c.lift }));
}
