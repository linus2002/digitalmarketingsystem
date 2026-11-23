// Original artwork for the AI bots (drawn for this app, no stock images): robot faces with a white helmet,
// dark visor and glowing eyes; an isometric office where each bot has a desk; and an isometric
// journey path showing how a batch moves from notes to a published Facebook post.


export type BotName = "caption" | "style" | "scheduler" | "checker" | "posting";
export type Mood = "neutral" | "happy" | "focus" | "alert" | "wink" | "sad" | "sleep" | "determined";

export const BOT_ORDER: BotName[] = ["caption", "style", "scheduler", "checker", "posting"];

export const BOTS: Record<BotName, { name: string; role: string; line: string; color: string; mood: Mood }> = {
  caption: { name: "Caption Bot", role: "Writes every caption with search keywords", line: "Give me your notes or the video's transcript. I'll write the caption.", color: "#1f5fd6", mood: "neutral" },
  style: { name: "Style Bot", role: "Learns how your team writes", line: "Show me captions you've written. I'll teach the Caption Bot your style.", color: "#7c5cff", mood: "happy" },
  scheduler: { name: "Scheduler Bot", role: "Picks the dates and times", line: "Tell me the days. I'll find times that don't clash.", color: "#1e9e57", mood: "wink" },
  checker: { name: "Checker Bot", role: "Checks everything, before and after", line: "I check every post before anything goes out, and follow up after.", color: "#f2b01e", mood: "determined" },
  posting: { name: "Posting Bot", role: "Hands posts to approval and the Page", line: "Hand them to me. I'll line them up for review and publishing.", color: "#d93a32", mood: "happy" },
};

const INK = "#1d2433";
const VISOR = "#1b2233";
const EYE = "#45b8f5";

function Eyes({ mood }: { mood: Mood }) {
  const L = 46;
  const R = 74;
  const Y = 50;
  const stroke = { stroke: EYE, strokeWidth: 4.5, strokeLinecap: "round" as const, fill: "none" };
  switch (mood) {
    case "happy":
      return (
        <g {...stroke}>
          <path d={`M${L - 8} ${Y + 4} Q${L} ${Y - 8} ${L + 8} ${Y + 4}`} />
          <path d={`M${R - 8} ${Y + 4} Q${R} ${Y - 8} ${R + 8} ${Y + 4}`} />
        </g>
      );
    case "focus":
      // Lower halves only: eyes narrowed in concentration
      return (
        <g fill={EYE}>
          <path d={`M${L - 9} ${Y - 1} h18 a9 7 0 0 1 -18 0z`} />
          <path d={`M${R - 9} ${Y - 1} h18 a9 7 0 0 1 -18 0z`} />
        </g>
      );
    case "determined":
      return (
        <g fill={EYE}>
          <path d={`M${L - 9} ${Y - 6} L${L + 9} ${Y - 1} L${L + 7} ${Y + 7} L${L - 7} ${Y + 7}z`} />
          <path d={`M${R + 9} ${Y - 6} L${R - 9} ${Y - 1} L${R - 7} ${Y + 7} L${R + 7} ${Y + 7}z`} />
        </g>
      );
    case "alert":
      return (
        <g fill={EYE}>
          <ellipse className="bot-eye" cx={L} cy={Y} rx="9" ry="12.5" />
          <ellipse className="bot-eye" cx={R} cy={Y} rx="9" ry="12.5" />
        </g>
      );
    case "wink":
      return (
        <g>
          <path d={`M${L - 8} ${Y + 1} Q${L} ${Y - 6} ${L + 8} ${Y + 1}`} {...stroke} />
          <ellipse className="bot-eye" cx={R} cy={Y} rx="7" ry="10" fill={EYE} />
        </g>
      );
    case "sad":
      return (
        <g {...stroke}>
          <path d={`M${L - 8} ${Y + 2} Q${L - 1} ${Y + 8} ${L + 8} ${Y + 6}`} />
          <path d={`M${R - 8} ${Y + 6} Q${R + 1} ${Y + 8} ${R + 8} ${Y + 2}`} />
          <path d={`M${L - 7} ${Y - 7} L${L + 6} ${Y - 4}M${R + 7} ${Y - 7} L${R - 6} ${Y - 4}`} strokeWidth={3} />
        </g>
      );
    case "sleep":
      return (
        <g {...stroke}>
          <path d={`M${L - 8} ${Y + 2} H${L + 8}M${R - 8} ${Y + 2} H${R + 8}`} />
        </g>
      );
    default:
      return (
        <g fill={EYE}>
          <ellipse className="bot-eye" cx={L} cy={Y} rx="7" ry="10" />
          <ellipse className="bot-eye" cx={R} cy={Y} rx="7" ry="10" />
        </g>
      );
  }
}

/** The robot head, drawn in a 120 x 100 box. */
function HeadShapes({ mood, color }: { mood: Mood; color: string }) {
  return (
    <>
      {/* ear pieces */}
      <rect x="5" y="38" width="16" height="26" rx="8" fill="#dfe4ec" stroke={INK} strokeWidth="3.5" />
      <rect x="99" y="38" width="16" height="26" rx="8" fill="#dfe4ec" stroke={INK} strokeWidth="3.5" />
      <circle cx="13" cy="51" r="3" fill={color} />
      <circle cx="107" cy="51" r="3" fill={color} />
      {/* helmet */}
      <rect x="15" y="9" width="90" height="82" rx="41" fill="#fff" stroke={INK} strokeWidth="4" />
      <path d="M30 22 Q60 6 90 22" fill="none" stroke="#eef1f6" strokeWidth="5" strokeLinecap="round" />
      {/* visor */}
      <rect x="25" y="25" width="70" height="50" rx="24" fill={VISOR} />
      <path d="M33 33 Q40 28 50 28" fill="none" stroke="#ffffff" strokeOpacity=".18" strokeWidth="3" strokeLinecap="round" />
      <Eyes mood={mood} />
      {mood === "sleep" && (
        <g fill={EYE} fontFamily="Poppins, sans-serif" fontWeight="700">
          <text x="96" y="20" fontSize="13">z</text>
          <text x="105" y="9" fontSize="9">z</text>
        </g>
      )}
    </>
  );
}

/** A bot face on its own (avatars, panels, activity feed). */
export function BotFace({ bot, mood, size = 56, title }: { bot: BotName; mood?: Mood; size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 120 100" width={size} height={(size * 100) / 120} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} className="bot-face">
      <HeadShapes mood={mood ?? BOTS[bot].mood} color={BOTS[bot].color} />
    </svg>
  );
}

/**
 * Head and body (and feet when standing), in head units: the head is 120 x 100, the body sits below it.
 * (x, y) is the point on the ground under the feet, or the chair seat when sitting.
 */
export function BotFigure({
  bot,
  mood,
  x,
  y,
  scale,
  pose = "stand",
  walk,
  bob = 0,
  prop,
}: {
  bot: BotName;
  mood: Mood;
  x: number;
  y: number;
  scale: number;
  pose?: "stand" | "sit";
  /** Walking cycle in radians; feet step and the body bounces. */
  walk?: number;
  /** Extra vertical offset in pixels (typing, breathing). */
  bob?: number;
  prop?: "mug" | "book" | null;
}) {
  const color = BOTS[bot].color;
  const bottom = pose === "sit" ? 128 : 140;
  const bounce = walk !== undefined ? -Math.abs(Math.sin(walk)) * 5 : 0;
  const step = walk !== undefined ? Math.sin(walk) * 4 : 0;
  return (
    <g transform={`translate(${(x - 60 * scale).toFixed(1)} ${(y - bottom * scale + bob + bounce * scale).toFixed(1)}) scale(${scale})`}>
      {pose === "stand" && (
        <g fill="#fff" stroke={INK} strokeWidth="4">
          <rect x="40" y={124 - step} width="16" height="16" rx="7" />
          <rect x="64" y={124 + step} width="16" height="16" rx="7" />
        </g>
      )}
      <rect x="34" y="84" width="52" height="44" rx="20" fill="#fff" stroke={INK} strokeWidth="4" />
      <circle cx="60" cy="104" r="6" fill={color} />
      <HeadShapes mood={mood} color={color} />
      {prop === "mug" && (
        <g>
          <rect x="84" y="96" width="18" height="20" rx="4" fill="#fff" stroke={INK} strokeWidth="3.5" />
          <rect x="84" y="102" width="18" height="6" fill={color} />
          <path d="M102 101 q8 0 8 6 q0 6 -8 6" fill="none" stroke={INK} strokeWidth="3" />
        </g>
      )}
      {prop === "book" && (
        <g>
          <rect x="30" y="92" width="60" height="30" rx="3" fill={color} stroke={INK} strokeWidth="3.5" />
          <path d="M60 92 v30" stroke="#fff" strokeWidth="3" />
        </g>
      )}
    </g>
  );
}

// ---------------------------------------------------------------- isometric helpers

const C30 = Math.cos(Math.PI / 6);
export type P = [number, number];
export type Iso = (x: number, y: number, z?: number) => P;
export function isoFn(ox: number, oy: number, s: number): Iso {
  return (x: number, y: number, z = 0): P => [ox + (x - y) * s * C30, oy + (x + y) * s * 0.5 - z * s];
}
export const pts = (...p: P[]) => p.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");

/** A box with its top and the two visible sides (top surface at height z, h deep). */
export function Slab({ iso, x0, y0, x1, y1, z, h, top, left, right, stroke }: { iso: Iso; x0: number; y0: number; x1: number; y1: number; z: number; h: number; top: string; left: string; right: string; stroke?: string }) {
  return (
    <g stroke={stroke} strokeWidth={stroke ? 1 : 0} strokeLinejoin="round">
      <polygon points={pts(iso(x0, y1, z), iso(x1, y1, z), iso(x1, y1, z - h), iso(x0, y1, z - h))} fill={left} />
      <polygon points={pts(iso(x1, y0, z), iso(x1, y1, z), iso(x1, y1, z - h), iso(x1, y0, z - h))} fill={right} />
      <polygon points={pts(iso(x0, y0, z), iso(x1, y0, z), iso(x1, y1, z), iso(x0, y1, z))} fill={top} />
    </g>
  );
}

export interface BotView {
  mood: Mood;
  state: "working" | "attention" | "idle" | "done" | "off";
  task: string;
}

// ---------------------------------------------------------------- the journey path

export interface FlowStage {
  key: string;
  title: string;
  lane: string; // the label written along the path
  bot: BotName | "you" | "team";
}

export const FLOW: FlowStage[] = [
  { key: "add", title: "Add posts", lane: "Prepare", bot: "you" },
  { key: "style", title: "Learn the style", lane: "Prepare", bot: "style" },
  { key: "caption", title: "Write captions", lane: "Prepare", bot: "caption" },
  { key: "schedule", title: "Pick times", lane: "Plan", bot: "scheduler" },
  { key: "check", title: "Check everything", lane: "Check", bot: "checker" },
  { key: "handoff", title: "Hand off", lane: "Check", bot: "posting" },
  { key: "publish", title: "Approve and publish", lane: "Publish", bot: "team" },
];

function Person({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g>
      <ellipse cx={x} cy={y} rx="16" ry="6" fill="rgba(20,30,60,.15)" />
      <rect x={x - 9} y={y - 40} width="18" height="38" rx="9" fill={color} />
      <circle cx={x} cy={y - 50} r="10" fill="#f2c9a5" />
      <path d={`M${x - 11} ${y - 52} q11 -16 22 0`} fill={color} />
    </g>
  );
}

/** Stations along a zig-zag path, in the style of a customer journey map. `current` highlights the stage the batch is at. */
export function BotFlow({ current, done }: { current: number; done: number }) {
  const iso = isoFn(250, 40, 30);
  // Path: along x (stations 0-2), down a connector along y (3), then back along -x (4-6).
  const stations: [number, number][] = [
    [1.2, 1], [4.4, 1], [7.6, 1], [8.0, 4.0], [7.0, 7], [4.2, 7], [1.4, 7],
  ];
  const lanes: { x0: number; y0: number; x1: number; y1: number; top: string; left: string; right: string; label: string; lx: number; ly: number }[] = [
    { x0: 0, y0: 0, x1: 9, y1: 2, top: "#dbe6fd", left: "#b9cdf8", right: "#a9c1f6", label: "Prepare", lx: 4.5, ly: 2.15 },
    { x0: 7, y0: 2, x1: 9, y1: 6, top: "#b9cdf8", left: "#94b2f2", right: "#83a5ef", label: "Plan", lx: 9.15, ly: 4 },
    { x0: 0, y0: 6, x1: 9, y1: 8, top: "#6c9cf0", left: "#3f73d9", right: "#3567cc", label: "Check", lx: 6.2, ly: 8.15 },
  ];
  const path = stations.map((s) => iso(s[0], s[1], 0));
  return (
    <svg viewBox="0 0 520 350" className="flow-svg" role="img" aria-label={`How a batch moves through the bots. Current step: ${FLOW[current]?.title ?? "finished"}.`}>
      {lanes.map((l, i) => (
        <Slab key={i} iso={iso} x0={l.x0} y0={l.y0} x1={l.x1} y1={l.y1} z={0} h={0.7} top={l.top} left={l.left} right={l.right} />
      ))}
      {/* the final "publish" step is a darker landing */}
      <Slab iso={iso} x0={0} y0={6} x1={2.6} y1={8} z={0.001} h={0.7} top="#1f5fd6" left="#153f91" right="#174bad" />
      {lanes.map((l, i) => {
        const [x, y] = iso(l.lx, l.ly, -0.38);
        const angle = i === 1 ? -30 : 30;
        return (
          <text key={`t${i}`} x={x} y={y} textAnchor="middle" className="flow-lane" transform={`rotate(${angle} ${x} ${y})`}>
            {l.label}
          </text>
        );
      })}
      {(() => {
        const [x, y] = iso(1.3, 8.15, -0.38);
        return (
          <text x={x} y={y} textAnchor="middle" className="flow-lane" transform={`rotate(30 ${x} ${y})`}>
            Publish
          </text>
        );
      })()}
      <polyline points={pts(...path)} fill="none" stroke="#ffffff" strokeWidth="2.5" strokeDasharray="7 6" strokeLinecap="round" />
      {stations.map((s, i) => {
        const [x, y] = iso(s[0], s[1], 0);
        const st = FLOW[i];
        const isNow = i === current;
        const isDone = i < done;
        return (
          <g key={st.key}>
            <ellipse cx={x} cy={y} rx="22" ry="11" fill={isNow ? "rgba(124,92,255,.35)" : "rgba(255,255,255,.55)"} stroke={isNow ? "#7c5cff" : "none"} strokeWidth="2" className={isNow ? "flow-now" : undefined} />
            {st.bot === "you" ? (
              <Person x={x} y={y - 2} color="#1f5fd6" />
            ) : st.bot === "team" ? (
              <>
                <Person x={x - 12} y={y - 2} color="#1e9e57" />
                <Person x={x + 12} y={y + 2} color="#153f91" />
              </>
            ) : (
              <BotFigure bot={st.bot} mood={isNow ? "focus" : isDone ? "happy" : BOTS[st.bot].mood} x={x} y={y + 2} scale={0.36} />
            )}
            <g transform={`translate(${x + 22} ${st.bot === "you" || st.bot === "team" ? y - 64 : y - 52})`}>
              <circle r="11" fill={isDone ? "#1e9e57" : isNow ? "#7c5cff" : "#ffffff"} stroke={isDone || isNow ? "none" : "#8a8a8a"} strokeWidth="1.5" />
              <text y="4" textAnchor="middle" className="flow-num" fill={isDone || isNow ? "#fff" : "#3b3b3b"}>
                {isDone ? "✓" : i + 1}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
