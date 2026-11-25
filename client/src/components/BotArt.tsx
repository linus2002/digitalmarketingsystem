// Original artwork for the AI bots (drawn for this app, no stock images): robot faces with a white helmet,
// dark visor and glowing eyes; an isometric office where each bot has a desk; and an isometric
// journey path showing how a batch moves from notes to a published Facebook post.


export type BotName = "caption" | "style" | "scheduler" | "checker" | "posting" | "editor";
export type Mood = "neutral" | "happy" | "focus" | "alert" | "wink" | "sad" | "sleep" | "determined";

export const BOT_ORDER: BotName[] = ["caption", "style", "editor", "scheduler", "checker", "posting"];

export const BOTS: Record<BotName, { name: string; role: string; line: string; color: string; mood: Mood }> = {
  caption: { name: "Caption Bot", role: "Writes every caption with search keywords", line: "Give me your notes or the video's transcript. I'll write the caption.", color: "#1f5fd6", mood: "neutral" },
  style: { name: "Style Bot", role: "Learns how your team writes", line: "Show me captions you've written. I'll teach the Caption Bot your style.", color: "#7c5cff", mood: "happy" },
  scheduler: { name: "Scheduler Bot", role: "Picks the dates and times", line: "Tell me the days. I'll find times that don't clash.", color: "#1e9e57", mood: "wink" },
  checker: { name: "Checker Bot", role: "Checks everything, before and after", line: "I check every post before anything goes out, and follow up after.", color: "#f2b01e", mood: "determined" },
  editor: { name: "Editor Bot", role: "Revises posts to meet your standards", line: "Tell me your standards. I'll revise every post until it meets them.", color: "#0e9f9a", mood: "determined" },
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

/**
 * The robot head, drawn in a 120 x 100 box.
 * turn: -1 looking to the viewer's left, 1 to the right (three-quarter view), 0 straight on.
 * back: seen from behind (no visor; a vent panel in the bot's colour instead).
 */
function HeadShapes({ mood, color, turn = 0, back = false }: { mood: Mood; color: string; turn?: number; back?: boolean }) {
  // In a three-quarter view the far ear tucks behind the helmet and the visor slides toward the turn.
  const shift = back ? -turn * 6 : turn * 9;
  const hideLeftEar = !back && turn > 0;
  const hideRightEar = !back && turn < 0;
  return (
    <>
      {/* ear pieces */}
      {!hideLeftEar && (
        <>
          <rect x={5 + Math.max(0, shift)} y="38" width="16" height="26" rx="8" fill="#dfe4ec" stroke={INK} strokeWidth="3.5" />
          <circle cx={13 + Math.max(0, shift)} cy="51" r="3" fill={color} />
        </>
      )}
      {!hideRightEar && (
        <>
          <rect x={99 + Math.min(0, shift)} y="38" width="16" height="26" rx="8" fill="#dfe4ec" stroke={INK} strokeWidth="3.5" />
          <circle cx={107 + Math.min(0, shift)} cy="51" r="3" fill={color} />
        </>
      )}
      {/* helmet */}
      <rect x="15" y="9" width="90" height="82" rx="41" fill="#fff" stroke={INK} strokeWidth="4" />
      <path d="M30 22 Q60 6 90 22" fill="none" stroke="#eef1f6" strokeWidth="5" strokeLinecap="round" />
      {back ? (
        // the back of the head: a strap in the bot's colour over the top, small vents low down, no visor
        <g transform={`translate(${shift} 0)`}>
          <path d="M22 50 Q60 30 98 50" fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" />
          {[50, 60, 70].map((x) => (
            <rect key={x} x={x - 2.5} y="66" width="5" height="12" rx="2.5" fill="#c9cddd" />
          ))}
        </g>
      ) : (
        <g transform={`translate(${shift} 0)`}>
          {/* visor */}
          <rect x="25" y="25" width="70" height="50" rx="24" fill={VISOR} />
          <path d="M33 33 Q40 28 50 28" fill="none" stroke="#ffffff" strokeOpacity=".18" strokeWidth="3" strokeLinecap="round" />
          <Eyes mood={mood} />
        </g>
      )}
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
  facing = "front",
  turn = 0,
  typing,
  swing = 0,
}: {
  bot: BotName;
  mood: Mood;
  x: number;
  y: number;
  scale: number;
  pose?: "stand" | "sit";
  /** Walking cycle in radians; feet step, arms swing and the body bounces. */
  walk?: number;
  /** Extra vertical offset in pixels (typing, breathing). */
  bob?: number;
  prop?: "mug" | "book" | "pad" | "racket" | null;
  /** "back": seen from behind (at a desk, walking away). */
  facing?: "front" | "back";
  /** Which way it's turned on screen: -1 left, 1 right, 0 straight on. */
  turn?: number;
  /** Typing cycle in radians: both hands reach forward and tap in turn (at a keyboard or a game pad). */
  typing?: number;
  /** Racket swing, 0 (ready) to 1 (hit). */
  swing?: number;
}) {
  const color = BOTS[bot].color;
  const back = facing === "back";
  const bottom = pose === "sit" ? 128 : 140;
  const bounce = walk !== undefined ? -Math.abs(Math.sin(walk)) * 5 : 0;
  const step = walk !== undefined ? Math.sin(walk) * 4 : 0;
  const arm = walk !== undefined ? Math.sin(walk) * 7 : 0;
  // Feet: walking side-on, the near foot leads; seen from behind, the feet are mostly hidden by the body.
  const footShift = turn * 5;
  const reach = typing !== undefined;
  const tapL = reach ? Math.max(0, Math.sin(typing!)) * 5 : 0;
  const tapR = reach ? Math.max(0, Math.sin(typing! + Math.PI)) * 5 : 0;

  const armsBehind = false;
  // Reaching forward: seen from behind the hands go out past the shoulders and up towards the desk;
  // from the front they come down in front of the body.
  const hand = (side: -1 | 1, tap: number): [number, number] => (back ? [60 + side * 50, 90 - tap] : [60 + side * 24, 114 - tap]);
  const armPath = (side: -1 | 1, tap: number) => {
    const [hx, hy] = hand(side, tap);
    const sx = 60 + side * 22;
    return `M${sx} 98 Q${60 + side * (back ? 46 : 36)} ${back ? 104 : 108} ${hx} ${hy}`;
  };
  const arms = reach ? (
    // reaching forward to a keyboard or game pad, hands tapping in turn
    <g strokeLinecap="round">
      {([-1, 1] as const).map((side) => {
        const tap = side < 0 ? tapL : tapR;
        const [hx, hy] = hand(side, tap);
        return (
          <g key={side}>
            <path d={armPath(side, tap)} fill="none" strokeWidth="12" stroke={INK} />
            <path d={armPath(side, tap)} fill="none" strokeWidth="5.5" stroke="#fff" />
            <circle cx={hx} cy={hy} r="6.5" fill="#fff" stroke={INK} strokeWidth="4" />
          </g>
        );
      })}
    </g>
  ) : (
    // hanging at the sides, swinging while walking
    <g fill="#fff" stroke={INK} strokeWidth="4">
      {!(turn > 0 && !back) && <rect x={24 + Math.max(0, turn) * 4} y={92 + arm} width="12" height="26" rx="6" />}
      {!(turn < 0 && !back) && <rect x={84 + Math.min(0, turn) * 4} y={92 - arm} width="12" height="26" rx="6" />}
    </g>
  );

  // The racket is held out to the side, tilted away from the head, and swings across on a hit.
  const racketAngle = turn >= 0 ? 35 - swing * 100 : -35 + swing * 100;
  const racketHand = turn >= 0 ? [104, 112] : [16, 112];

  return (
    <g transform={`translate(${(x - 60 * scale).toFixed(1)} ${(y - bottom * scale + bob + bounce * scale).toFixed(1)}) scale(${scale})`}>
      {pose === "stand" && (
        <g fill="#fff" stroke={INK} strokeWidth="4">
          <rect x={40 + footShift} y={124 - step} width="16" height="16" rx="7" />
          <rect x={64 + footShift} y={124 + step} width="16" height="16" rx="7" />
        </g>
      )}
      {armsBehind && arms}
      <rect x="34" y="84" width="52" height="44" rx="20" fill="#fff" stroke={INK} strokeWidth="4" />
      {back ? (
        <rect x="52" y="90" width="16" height="30" rx="6" fill={color} opacity=".85" />
      ) : (
        <circle cx={60 + turn * 8} cy="104" r="6" fill={color} />
      )}
      {!armsBehind && arms}
      <HeadShapes mood={mood} color={color} turn={turn} back={back} />
      {prop === "mug" && !back && (
        <g>
          <rect x="84" y="96" width="18" height="20" rx="4" fill="#fff" stroke={INK} strokeWidth="3.5" />
          <rect x="84" y="102" width="18" height="6" fill={color} />
          <path d="M102 101 q8 0 8 6 q0 6 -8 6" fill="none" stroke={INK} strokeWidth="3" />
        </g>
      )}
      {prop === "book" && !back && (
        <g>
          <rect x="30" y="92" width="60" height="30" rx="3" fill={color} stroke={INK} strokeWidth="3.5" />
          <path d="M60 92 v30" stroke="#fff" strokeWidth="3" />
        </g>
      )}
      {prop === "pad" && !back && (
        // a game pad held in both hands (seen from behind it's hidden in front of the bot)
        <g>
          <rect x="38" y="104" width="44" height="16" rx="8" fill="#2c2843" stroke={INK} strokeWidth="3" />
          <circle cx="48" cy="112" r="2.5" fill="#45b8f5" />
          <circle cx="72" cy="112" r="2.5" fill="#f2b01e" />
        </g>
      )}
      {prop === "racket" && (
        <g transform={`rotate(${racketAngle} ${racketHand[0]} ${racketHand[1]})`}>
          <line x1={racketHand[0]} y1={racketHand[1]} x2={racketHand[0]} y2={racketHand[1] - 26} stroke="#2c2843" strokeWidth="5" strokeLinecap="round" />
          <ellipse cx={racketHand[0]} cy={racketHand[1] - 42} rx="13" ry="17" fill="rgba(255,255,255,.55)" stroke={color} strokeWidth="4" />
          <path d={`M${racketHand[0] - 10} ${racketHand[1] - 42}h20M${racketHand[0]} ${racketHand[1] - 56}v28`} stroke="#c9cddd" strokeWidth="1.5" />
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
  { key: "editor", title: "Revise to your standards", lane: "Prepare", bot: "editor" },
  { key: "schedule", title: "Pick times", lane: "Plan", bot: "scheduler" },
  { key: "check", title: "Check everything", lane: "Check", bot: "checker" },
  { key: "handoff", title: "Hand off", lane: "Check", bot: "posting" },
  { key: "publish", title: "Approve and publish", lane: "Publish", bot: "team" },
];
