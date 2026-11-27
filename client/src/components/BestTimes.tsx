import { api, useLoad } from "../lib/api";
import { BUSINESS_TZ, toBizInput } from "../lib/format";
import { Icon } from "./Icons";

// Best time to post (server: services/bestTimes.ts). Times are Philippine time.

export interface BestTimes {
  basis: "your_posts" | "general";
  metric: "rate" | "engagement";
  sample: number;
  minPosts: number;
  grid: { dow: number; block: number; n: number; score: number; lift: number; hour: number }[];
  best: { dow: number; block: number; n: number; lift: number; hour: number }[];
  next: { at: string; lift: number }[];
}

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const BLOCK_LABELS = ["6–9 AM", "9 AM–12", "12–3 PM", "3–6 PM", "6–9 PM", "9 PM–12"];
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? " AM" : " PM"}`;

export const useBestTimes = () => useLoad(() => api<BestTimes>("/analytics/best-times"), []);

const slotLabel = (iso: string) =>
  new Intl.DateTimeFormat("en-PH", { timeZone: BUSINESS_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

const basisNote = (d: BestTimes) =>
  d.basis === "your_posts"
    ? `From ${d.sample} of your Facebook posts (${d.metric === "rate" ? "engagement per person reached" : "engagement"}).`
    : `General pattern for audiences in the Philippines: you have ${d.sample} synced post${d.sample === 1 ? "" : "s"}, and your own results are used from ${d.minPosts}.`;

/**
 * The next good times to post, as buttons that fill a date-time field (value in the field's Philippine-time format).
 * `selected` is the field's current value, so the chosen time shows as picked.
 */
export function SuggestedTimes({ onPick, selected, disabled }: { onPick: (bizInput: string) => void; selected?: string; disabled?: boolean }) {
  const { data } = useBestTimes();
  if (!data?.next.length) return null;
  return (
    <div className="bt-suggest">
      <span className="bt-suggest-label">
        <Icon name="clock" size={14} />
        Good times
      </span>
      <div className="bt-chips">
        {data.next.map((s) => {
          const v = toBizInput(s.at);
          return (
            <button
              key={s.at}
              type="button"
              className={`bt-chip${selected === v ? " on" : ""}`}
              disabled={disabled}
              aria-pressed={selected === v}
              onClick={() => onPick(v)}
              title={s.lift > 0 ? `About ${s.lift}% more engagement than your average slot` : "A typical slot"}
            >
              {slotLabel(s.at)}
              {s.lift > 0 && <small>+{s.lift}%</small>}
            </button>
          );
        })}
      </div>
      <p className="note mt0">{basisNote(data)} Times already planned for another post are skipped.</p>
    </div>
  );
}

/** Heatmap of days × times of day, for Analytics. */
export function BestTimesBoard() {
  const { data, error } = useBestTimes();
  if (error) return null;
  if (!data) return <div className="board"><p className="muted small">Working out the best times to post…</p></div>;
  const max = Math.max(...data.grid.map((c) => c.score));
  const min = Math.min(...data.grid.map((c) => c.score));
  const level = (s: number) => (max === min ? 0.5 : (s - min) / (max - min));
  const cell = (dow: number, block: number) => data.grid.find((c) => c.dow === dow && c.block === block)!;
  // Monday first, like the calendar.
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="board">
      <div className="spread" style={{ marginBottom: 6 }}>
        <h2 className="section">Best time to post</h2>
        <span className={`tag ${data.basis === "your_posts" ? "tag-good" : "tag-mute"}`}>{data.basis === "your_posts" ? "From your posts" : "General guidance"}</span>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {basisNote(data)} Philippine time.
      </p>
      <div className="bt-best">
        {data.best.map((b, i) => (
          <div key={`${b.dow}-${b.block}`} className="bt-best-item">
            <span className="bt-rank">{i + 1}</span>
            <div>
              <b>
                {DAYS_LONG[b.dow]}, {hourLabel(b.hour)}
              </b>
              <span className="sub">{b.lift > 0 ? `+${b.lift}% vs. your average slot` : "About average"}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="bt-heat-scroll">
        <table className="bt-heat" aria-label="Engagement by day and time of day">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Day</span>
              </th>
              {BLOCK_LABELS.map((l) => (
                <th key={l} scope="col">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {order.map((dow) => (
              <tr key={dow}>
                <th scope="row">{DAYS[dow]}</th>
                {BLOCK_LABELS.map((l, block) => {
                  const c = cell(dow, block);
                  const lv = level(c.score);
                  return (
                    <td key={l}>
                      <span
                        className={`bt-cell${lv > 0.6 ? " hi" : ""}`}
                        style={{ ["--lv" as string]: lv.toFixed(2) }}
                        title={`${DAYS_LONG[dow]} ${l}: ${c.lift > 0 ? "+" : ""}${c.lift}%${data.basis === "your_posts" ? ` · ${c.n} post${c.n === 1 ? "" : "s"}` : ""}`}
                      >
                        {c.lift > 0 ? `+${c.lift}` : c.lift}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">Numbers are % above or below your average slot. Darker is better. Slots with few posts lean on the general pattern.</p>
    </div>
  );
}
