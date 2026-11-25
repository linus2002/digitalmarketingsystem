// "How it flows" journey map: an isometric path down the middle with a station per step, and the
// step cards on both sides, each joined to its station by a leader line. Original artwork.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BOTS, BotFace, BotFigure, FLOW, isoFn, pts, Slab, type BotName, type Mood } from "./BotArt";

const S = 34;
const iso = isoFn(0, 0, S);
const VB = { x: -92, y: -64, w: 482, h: 650 };
const ZTOP = 2.75; // height of the top edge of the screens, in grid units
const PANEL_K = (2 * S) / 100; // local panel units -> pixels (a screen is 2 grid units wide)

type Kind = "add" | "style" | "caption" | "editor" | "schedule" | "check" | "handoff" | "publish";

/** Where each step stands (grid units), which way its lane runs, and where its card goes. */
const ST: { p: [number, number]; lane: "x" | "y"; side: "L" | "R"; row: number }[] = [
  { p: [1.4, 1.2], lane: "x", side: "L", row: 1 },
  { p: [4.4, 1.2], lane: "x", side: "L", row: 2 },
  { p: [7.4, 1.2], lane: "x", side: "R", row: 1 },
  { p: [10.4, 1.2], lane: "x", side: "R", row: 2 },
  { p: [11.2, 4.8], lane: "y", side: "R", row: 3 },
  { p: [13.2, 8.4], lane: "x", side: "L", row: 3 },
  { p: [16, 8.4], lane: "x", side: "R", row: 4 },
  { p: [16, 12], lane: "y", side: "L", row: 4 },
];

const LANES = [
  { x0: 0, y0: 0, x1: 12.4, y1: 2.4, top: "#e4ecfd", left: "#c3d4f8", right: "#b2c7f5", label: "Prepare", dir: "x" as const, at: 5.2 },
  { x0: 10, y0: 2.4, x1: 12.4, y1: 7.2, top: "#c4d5fa", left: "#9db8f3", right: "#8caaef", label: "Plan", dir: "y" as const, at: 3.5 },
  { x0: 10, y0: 7.2, x1: 17.2, y1: 9.6, top: "#8eaff3", left: "#5e87e5", right: "#4f7bdd", label: "Check", dir: "y" as const, at: 8.4 },
  { x0: 14.8, y0: 9.6, x1: 17.2, y1: 14, top: "#3b6ddb", left: "#2350b8", right: "#1c45a4", label: "Publish", dir: "y" as const, at: 11.8 },
];

const PLANTS: [number, number][] = [[0.45, 2.0], [6.0, 0.35], [12.05, 0.4], [10.45, 6.8], [14.2, 7.5], [15.15, 13.55]];

// ---------------------------------------------------------------- people

interface Look {
  skin: string;
  hair: string;
  hairStyle: "short" | "long" | "bun";
  shirt: string;
  pants: string;
  shoe: string;
}

const YOU: Look = { skin: "#f0c6a2", hair: "#3a2419", hairStyle: "long", shirt: "#1f5fd6", pants: "#27314d", shoe: "#2a2a30" };
const MANAGER_A: Look = { skin: "#c98f63", hair: "#1d1a1c", hairStyle: "short", shirt: "#1e9e57", pants: "#2b3550", shoe: "#3b2a22" };
const MANAGER_B: Look = { skin: "#e8b48c", hair: "#5a3624", hairStyle: "bun", shirt: "#24387f", pants: "#3a3f4f", shoe: "#26262b" };

/** Darken (f < 1) or lighten (f > 1) a #rrggbb color. */
function tone(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(f > 1 ? v + (255 - v) * (f - 1) : v * f));
  return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

/** A standing person, about 90 units tall, feet at (0, 0), turned slightly toward the viewer's left. */
function HumanShapes({ look, prop }: { look: Look; prop?: "tablet" | "phone" | null }) {
  const sk = look.skin;
  const skD = tone(sk, 0.82);
  const sh = look.shirt;
  const shD = tone(sh, 0.76);
  const pa = look.pants;
  const paD = tone(pa, 0.72);
  const hairD = tone(look.hair, 0.8);
  const holding = prop === "tablet" || prop === "phone";
  return (
    <>
      {look.hairStyle === "long" && <path d="M-8.4,-81 Q-10.2,-68 -8.2,-60.5 Q0,-58 8.2,-60.5 Q10.2,-68 8.4,-81 Z" fill={hairD} />}
      {/* back leg and shoe */}
      <path d="M0.5,-40 L9.6,-40 L8.7,-5.6 L3.3,-5.6 Z" fill={paD} />
      <path d="M2.7,-6.3 L9,-6.3 Q12.7,-5.9 13,-2.7 Q13,-0.6 11,-0.4 L2.7,-0.4 Z" fill={look.shoe} />
      {/* front leg and shoe */}
      <path d="M-9.9,-40 L1.7,-40 L-0.3,-4.5 L-7.5,-4.5 Z" fill={pa} />
      <path d="M-3,-37 Q-2.2,-22 -1.6,-7" stroke={paD} strokeWidth="0.9" fill="none" opacity=".7" />
      <path d="M-8,-5.3 L-0.2,-5.3 Q4.7,-4.9 5.1,-1.6 Q5.1,0.6 2.9,0.8 L-8.3,0.8 Q-9,-2.2 -8,-5.3 Z" fill={look.shoe} />
      <path d="M-8.4,0.2 H4.5" stroke="#ffffff" strokeOpacity=".55" strokeWidth="1" />
      {/* back arm */}
      <path d="M8.5,-64 Q14.1,-62.5 14.7,-55 L14.3,-49.8 L8.6,-49.8 Z" fill={shD} />
      <path d="M9.4,-50.4 L14.1,-50.4 L14.5,-39 Q14.3,-35.5 11.9,-35.5 Q9.4,-35.5 9.4,-38.6 Z" fill={skD} />
      {/* torso */}
      <path d="M-11,-63.5 Q-12.9,-52 -10.7,-38.5 L10.5,-38.5 Q12.4,-52 11,-63.5 Q6,-67.6 0,-67.6 Q-6,-67.6 -11,-63.5 Z" fill={sh} />
      <path d="M3.4,-67.2 Q9,-66.7 11,-63.5 Q12.4,-52 10.5,-38.5 L4.6,-38.5 Q6.5,-52 3.4,-67.2 Z" fill="#000" opacity=".14" />
      <path d="M-10.2,-62 Q-11.8,-52 -9.9,-41 L-8,-41 Q-9.7,-52 -8.4,-62.7 Z" fill="#fff" opacity=".17" />
      <path d="M0,-61.5 V-39" stroke="#000" strokeOpacity=".16" strokeWidth=".8" />
      <g fill="#000" opacity=".28">
        <circle cx="0.9" cy="-56.5" r=".6" />
        <circle cx="0.9" cy="-50.5" r=".6" />
        <circle cx="0.9" cy="-44.5" r=".6" />
      </g>
      <rect x="-10.8" y="-40.7" width="21.3" height="2.9" fill={tone(pa, 0.55)} />
      <rect x="-1.7" y="-41" width="3.4" height="3.4" rx=".7" fill="#cdb47a" />
      {/* neck and collar */}
      <path d="M-3.1,-71.6 L3.1,-71.6 L3.3,-65.4 Q0,-63.4 -3.3,-65.4 Z" fill={sk} />
      <path d="M0.7,-71.6 L3.1,-71.6 L3.3,-65.4 Q1.9,-64.5 0.7,-64.5 Z" fill={skD} />
      <path d="M-4.8,-67.8 L0,-62.2 L-1,-66.4 Z M4.8,-67.8 L0,-62.2 L1,-66.4 Z" fill={tone(sh, 1.25)} />
      {/* front arm */}
      <path d="M-11,-63.5 Q-16.6,-62 -17.3,-54.5 L-16.7,-49.4 L-10.6,-49.4 Z" fill={sh} />
      <path d="M-15.8,-61 Q-16.8,-57 -16.6,-51" stroke="#fff" strokeOpacity=".2" strokeWidth="1.2" fill="none" />
      {holding ? (
        <path d="M-16.7,-50.2 L-11.3,-50.2 L-4.4,-49.4 Q-2.4,-47 -4.6,-45.2 L-14.6,-45.6 Q-17.6,-46.4 -16.7,-50.2 Z" fill={sk} />
      ) : (
        <>
          <path d="M-16.7,-50 L-11.4,-50 L-12,-38.6 Q-12.6,-35.3 -15,-35.3 Q-17.4,-35.5 -17.1,-38.8 Z" fill={sk} />
          <path d="M-12.3,-49 L-11.4,-49.6 L-12,-38.6 Q-12.3,-37 -13,-36.4 Z" fill={skD} />
        </>
      )}
      {prop === "tablet" && (
        <g>
          <polygon points="-11,-60 6.5,-56.6 5.8,-44.6 -11.6,-48.4" fill="#1d2433" />
          <polygon points="-9.8,-58.6 5.2,-55.6 4.6,-46 -10.3,-49.3" fill="#8fc0ff" />
          <polygon points="-9.8,-58.6 -1,-56.8 -1.6,-47.6 -10.3,-49.3" fill="#fff" opacity=".25" />
          <ellipse cx="-4.4" cy="-47" rx="2.6" ry="2.1" fill={sk} />
        </g>
      )}
      {prop === "phone" && (
        <g>
          <rect x="-8.4" y="-55" width="5" height="8.6" rx="1.1" fill="#1d2433" transform="rotate(-8 -6 -50)" />
          <rect x="-7.7" y="-54" width="3.6" height="6.4" rx=".6" fill="#8fc0ff" transform="rotate(-8 -6 -50)" />
          <ellipse cx="-4.6" cy="-47" rx="2.4" ry="2" fill={sk} />
        </g>
      )}
      {!holding && <ellipse cx="-14.6" cy="-35.6" rx="2.5" ry="2.8" fill={sk} />}
      {/* head */}
      <ellipse cx="0" cy="-79" rx="7.5" ry="8.9" fill={sk} />
      <path d="M2.6,-87.5 Q7.7,-85 7.5,-79 Q7.3,-72.3 1.6,-70.3 Q5.2,-75 2.6,-87.5 Z" fill="#000" opacity=".1" />
      <ellipse cx="6.7" cy="-78.4" rx="1.5" ry="2.4" fill={skD} />
      {/* face */}
      <g fill="#2b211c">
        <ellipse cx="-3.4" cy="-79.3" rx=".95" ry="1.1" />
        <ellipse cx="2" cy="-79.3" rx=".9" ry="1.05" />
      </g>
      <g fill="#fff">
        <circle cx="-3.1" cy="-79.7" r=".3" />
        <circle cx="2.3" cy="-79.7" r=".3" />
      </g>
      <path d="M-5,-82 q1.6,-1 3.2,-.2 M0.5,-82.2 q1.6,-.8 3.2,.1" stroke={look.hair} strokeWidth="1" strokeLinecap="round" fill="none" />
      <path d="M-0.5,-78.4 q-1.3,2.9 .8,3.1" stroke={skD} strokeWidth=".9" strokeLinecap="round" fill="none" />
      <path d="M-2.7,-73.8 q1.6,1.2 3.3,0" stroke="#a5584f" strokeWidth="1" strokeLinecap="round" fill="none" />
      <circle cx="-4.4" cy="-75.8" r="1.5" fill="#e7837a" opacity=".2" />
      <circle cx="3.4" cy="-75.8" r="1.3" fill="#e7837a" opacity=".16" />
      {/* hair */}
      {look.hairStyle === "short" && (
        <>
          <path d="M-7.8,-80.6 Q-8.8,-89.8 0.4,-89.6 Q8.6,-89.4 8,-80 Q7.1,-84.8 3.6,-85.4 Q-1.6,-83.6 -5.7,-84.6 Q-7.1,-82.7 -7.8,-80.6 Z" fill={look.hair} />
          <path d="M-4.6,-87.6 Q-0.5,-89 3.8,-87.6" stroke="#fff" strokeOpacity=".22" strokeWidth="1" fill="none" strokeLinecap="round" />
        </>
      )}
      {look.hairStyle === "long" && (
        <>
          <path d="M-8,-79 Q-9.4,-90.4 0.4,-89.8 Q9.2,-89.6 8.4,-79 L8.8,-66 Q7,-69 6.7,-76 Q6.6,-83.4 2.6,-85 Q-2.2,-83 -5.6,-84 Q-6.8,-80 -6.7,-74 L-9.2,-66 Q-8.3,-72 -8,-79 Z" fill={look.hair} />
          <path d="M-4.8,-87.8 Q-0.5,-89.4 4,-87.8" stroke="#fff" strokeOpacity=".22" strokeWidth="1" fill="none" strokeLinecap="round" />
        </>
      )}
      {look.hairStyle === "bun" && (
        <>
          <circle cx="2.5" cy="-90.2" r="3.6" fill={hairD} />
          <path d="M-7.8,-80.2 Q-8.8,-89.8 0.4,-89.6 Q8.6,-89.4 8,-79.6 Q7.4,-84.4 3.4,-85.6 Q-2.4,-84.2 -5.8,-84.8 Q-7.2,-82.6 -7.8,-80.2 Z" fill={look.hair} />
          <path d="M-4.6,-87.6 Q-0.5,-89 3.8,-87.6" stroke="#fff" strokeOpacity=".22" strokeWidth="1" fill="none" strokeLinecap="round" />
        </>
      )}
    </>
  );
}

function Human({ x, y, look, prop, s = 1 }: { x: number; y: number; look: Look; prop?: "tablet" | "phone" | null; s?: number }) {
  return (
    <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s})`}>
      <ellipse cx="2" cy="0" rx="17" ry="5.6" fill="rgba(20,30,70,.22)" />
      <HumanShapes look={look} prop={prop} />
    </g>
  );
}

/** Head and shoulders in a circle, for the cards. */
function HumanAvatar({ look, size = 34 }: { look: Look; size?: number }) {
  return (
    <span className="jm-ava" style={{ width: size, height: size }}>
      <svg viewBox="-15 -96 30 30" width={size} height={size} aria-hidden="true">
        <HumanShapes look={look} />
      </svg>
    </span>
  );
}

// ---------------------------------------------------------------- screens, plants

function PanelArt({ kind }: { kind: Kind }) {
  const navy = "#1b2a6b";
  const line = "#c9d6f3";
  const label = (t: string, x = 11, y = 15) => (
    <text x={x} y={y} fontSize="7" fontWeight="700" fill={navy} fontFamily="Poppins, system-ui, sans-serif" letterSpacing=".4">
      {t}
    </text>
  );
  switch (kind) {
    case "add":
      return (
        <g>
          {label("NEW POST")}
          <rect x="11" y="21" width="44" height="4" rx="2" fill={line} />
          <rect x="11" y="29" width="50" height="4" rx="2" fill={line} />
          <rect x="11" y="37" width="34" height="4" rx="2" fill={line} />
          <rect x="62" y="19" width="26" height="22" rx="3" fill="#dbe6fd" />
          <path d="M64 39 l7-9 5 6 4-4 6 7z" fill="#7fa6f2" />
          <circle cx="82" cy="24" r="2.4" fill="#f2b01e" />
          <circle cx="18" cy="50" r="5.5" fill="#1f5fd6" />
          <path d="M18 47v6M15 50h6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
          <rect x="28" y="47" width="30" height="6" rx="3" fill="#e7edfb" />
        </g>
      );
    case "style":
      return (
        <g>
          {label("YOUR VOICE")}
          <text x="11" y="47" fontSize="27" fontWeight="700" fill={navy} fontFamily="Georgia, serif">Aa</text>
          {["#7c5cff", "#1f5fd6", "#1e9e57", "#f2b01e"].map((c, i) => (
            <circle key={c} cx={58 + i * 9} cy="24" r="3.6" fill={c} />
          ))}
          <rect x="54" y="33" width="34" height="4" rx="2" fill={line} />
          <rect x="54" y="41" width="26" height="4" rx="2" fill={line} />
          <rect x="54" y="49" width="30" height="4" rx="2" fill={line} />
        </g>
      );
    case "caption":
      return (
        <g>
          {label("CAPTION")}
          <rect x="11" y="21" width="72" height="4" rx="2" fill={line} />
          <rect x="11" y="29" width="62" height="4" rx="2" fill={line} />
          <rect x="11" y="37" width="36" height="9" rx="4.5" fill="#1f5fd6" />
          <text x="15" y="43.6" fontSize="5.6" fontWeight="700" fill="#fff" fontFamily="Poppins, system-ui, sans-serif">#keywords</text>
          <rect x="50" y="39" width="30" height="4" rx="2" fill={line} />
          <rect x="11" y="50" width="48" height="4" rx="2" fill={line} />
          <path d="M84 44 l1.6 3.6 3.6 1.6 -3.6 1.6 -1.6 3.6 -1.6 -3.6 -3.6 -1.6 3.6 -1.6z" fill="#7c5cff" />
        </g>
      );
    case "editor":
      return (
        <g>
          {label("REVISION")}
          <rect x="11" y="21" width="56" height="7" rx="2" fill="#fbd5d2" />
          <path d="M13 24.5h52" stroke="#d93a32" strokeWidth="1.2" />
          <rect x="11" y="31" width="66" height="7" rx="2" fill="#cdf0db" />
          <rect x="14" y="33.5" width="52" height="2" rx="1" fill="#1e9e57" />
          <rect x="11" y="42" width="50" height="4" rx="2" fill={line} />
          <rect x="11" y="50" width="40" height="4" rx="2" fill={line} />
          <g transform="rotate(-35 80 44)">
            <rect x="74" y="40" width="20" height="6" rx="1" fill="#f2b01e" />
            <polygon points="74,40 74,46 68,43" fill="#f3d9b1" />
            <rect x="90" y="40" width="4" height="6" fill="#d93a32" />
          </g>
        </g>
      );
    case "schedule":
      return (
        <g>
          <rect x="10" y="10" width="54" height="9" rx="2" fill="#1e9e57" />
          <text x="14" y="17" fontSize="6.4" fontWeight="700" fill="#fff" fontFamily="Poppins, system-ui, sans-serif">THIS WEEK</text>
          {Array.from({ length: 21 }, (_, i) => (
            <rect key={i} x={10 + (i % 7) * 7.8} y={23 + Math.floor(i / 7) * 10.5} width="6.3" height="8.5" rx="1.2" fill={i === 9 ? "#7c5cff" : i === 3 || i === 16 ? "#9fd9b8" : "#e4ebf8"} />
          ))}
          <circle cx="80" cy="36" r="12" fill="#fff" stroke={navy} strokeWidth="2.4" />
          <path d="M80 29v7l5 3" stroke={navy} strokeWidth="2" strokeLinecap="round" fill="none" />
        </g>
      );
    case "check":
      return (
        <g>
          {label("CHECKLIST")}
          {[0, 1, 2].map((r) => (
            <g key={r} transform={`translate(0 ${r * 11})`}>
              <rect x="11" y="20" width="8" height="8" rx="2" fill={r === 2 ? "#fde7b0" : "#cdf0db"} />
              {r < 2 ? <path d="M12.8 24l2 2 3.2-3.6" stroke="#1e9e57" strokeWidth="1.5" fill="none" strokeLinecap="round" /> : <path d="M15 21.6v3M15 26.2v.4" stroke="#b07d00" strokeWidth="1.5" strokeLinecap="round" />}
              <rect x="23" y="22" width={r === 1 ? 30 : 38} height="4" rx="2" fill={line} />
            </g>
          ))}
          <circle cx="76" cy="34" r="9" fill="#eaf2ff" stroke={navy} strokeWidth="2.6" />
          <path d="M82.5 40.5l7 7" stroke={navy} strokeWidth="3.4" strokeLinecap="round" />
        </g>
      );
    case "handoff":
      return (
        <g>
          {label("TO REVIEW")}
          <path d="M14 42 Q32 26 52 34" stroke="#9fb4e6" strokeWidth="1.4" strokeDasharray="3 3" fill="none" />
          <polygon points="52,24 78,34 58,38 56,48 50,38 40,34" fill="#d93a32" />
          <polygon points="58,38 56,48 62,40" fill="#a82822" />
          <rect x="66" y="44" width="22" height="10" rx="3" fill="#e7edfb" />
          <path d="M70 49h14" stroke={navy} strokeWidth="1.4" strokeLinecap="round" />
        </g>
      );
    case "publish":
      return (
        <g>
          {label("PUBLISHED")}
          <rect x="11" y="20" width="44" height="34" rx="3" fill="#e7edfb" />
          <circle cx="18" cy="27" r="3.4" fill="#1f5fd6" />
          <rect x="24" y="25" width="24" height="4" rx="2" fill={line} />
          <rect x="15" y="33" width="36" height="13" rx="2" fill="#bcd0f7" />
          <rect x="15" y="48" width="18" height="3" rx="1.5" fill={line} />
          <circle cx="76" cy="36" r="13" fill="#1e9e57" />
          <path d="M69.5 36.5l4.6 4.6 8.4-9" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
  }
}

/** A screen on legs standing on the path. It faces +y (lanes along x) or +x (lanes along y). */
function Panel({ kind, at, lane }: { kind: Kind; at: [number, number]; lane: "x" | "y" }) {
  const k = PANEL_K;
  const legLen = (ZTOP * S) / k - 64;
  let o: [number, number];
  let m: string;
  let back: string;
  if (lane === "x") {
    o = iso(at[0] - 0.4, at[1] - 0.95, ZTOP);
    m = `matrix(${0.866 * k} ${0.5 * k} 0 ${k} ${o[0]} ${o[1]})`;
    back = "translate(3.6 -2.1)";
  } else {
    o = iso(at[0] - 0.95, at[1] + 1.6, ZTOP);
    m = `matrix(${0.866 * k} ${-0.5 * k} 0 ${k} ${o[0]} ${o[1]})`;
    back = "translate(-3.6 -2.1)";
  }
  return (
    <g>
      <g transform={m}>
        <g fill="#2c3550">
          <rect x="22" y="60" width="3.2" height={legLen} />
          <rect x="75" y="60" width="3.2" height={legLen} />
        </g>
      </g>
      <g transform={back}>
        <g transform={m}>
          <rect x="0" y="0" width="100" height="64" rx="6" fill="#0f1a4a" />
        </g>
      </g>
      <g transform={m}>
        <rect x="0" y="0" width="100" height="64" rx="6" fill="#1b2a6b" />
        <rect x="5" y="5" width="90" height="54" rx="3" fill="#f6f9ff" />
        <PanelArt kind={kind} />
        <path d="M8 6 L40 6 L22 58 L8 58 Z" fill="#fff" opacity=".07" />
      </g>
    </g>
  );
}

function Plant({ at }: { at: [number, number] }) {
  const [x, y] = iso(at[0], at[1], 0);
  return (
    <g>
      <ellipse cx={x + 1} cy={y} rx="9" ry="3.6" fill="rgba(20,30,70,.18)" />
      <path d={`M${x - 6.5} ${y - 10} L${x + 6.5} ${y - 10} L${x + 4.8} ${y} L${x - 4.8} ${y} Z`} fill="#f2f5fc" />
      <path d={`M${x + 1.5} ${y - 10} L${x + 6.5} ${y - 10} L${x + 4.8} ${y} L${x + 1} ${y} Z`} fill="#d7def0" />
      <ellipse cx={x} cy={y - 10} rx="6.5" ry="2.2" fill="#e3e9f6" />
      <g>
        <path d={`M${x} ${y - 10} Q${x - 14} ${y - 18} ${x - 11} ${y - 30} Q${x - 4} ${y - 22} ${x} ${y - 10} Z`} fill="#2f8f4e" />
        <path d={`M${x} ${y - 10} Q${x + 13} ${y - 17} ${x + 12} ${y - 29} Q${x + 4} ${y - 22} ${x} ${y - 10} Z`} fill="#3aa860" />
        <path d={`M${x} ${y - 10} Q${x - 4} ${y - 26} ${x + 1} ${y - 37} Q${x + 5} ${y - 24} ${x} ${y - 10} Z`} fill="#47b96d" />
        <path d={`M${x} ${y - 10} Q${x - 9} ${y - 13} ${x - 15} ${y - 19} Q${x - 6} ${y - 18} ${x} ${y - 10} Z`} fill="#3aa860" />
        <path d={`M${x} ${y - 10} Q${x + 9} ${y - 12} ${x + 15} ${y - 17} Q${x + 6} ${y - 17} ${x} ${y - 10} Z`} fill="#2f8f4e" />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------- the illustration

const isPerson = (i: number) => FLOW[i].bot === "you" || FLOW[i].bot === "team";
/** The point above each station's figure where its number badge sits (and its card's line ends). */
function badgeAt(i: number): [number, number] {
  const [x, y] = iso(ST[i].p[0], ST[i].p[1], 0);
  return [x - 21, y - (isPerson(i) ? 96 : 80)];
}

function MapArt({ stage }: { stage: number }) {
  const path = [
    ...ST.slice(0, 4).map((s) => s.p),
    [11.2, 1.2] as [number, number],
    ST[4].p,
    [11.2, 8.4] as [number, number],
    ST[5].p,
    ST[6].p,
    ST[7].p,
  ].map((p) => iso(p[0], p[1], 0));

  type Item = { depth: number; key: string; node: ReactNode };
  const items: Item[] = [];
  PLANTS.forEach((p, i) => items.push({ depth: p[0] + p[1], key: `plant${i}`, node: <Plant at={p} /> }));
  ST.forEach((s, i) => {
    const f = FLOW[i];
    const [x, y] = iso(s.p[0], s.p[1], 0);
    const d = s.p[0] + s.p[1];
    items.push({ depth: d - 0.3, key: `panel${i}`, node: <Panel kind={f.key as Kind} at={s.p} lane={s.lane} /> });
    const isNow = i === stage;
    const isDone = i < stage;
    let fig: ReactNode;
    if (f.bot === "you") fig = <Human x={x} y={y} look={YOU} prop="tablet" />;
    else if (f.bot === "team")
      fig = (
        <g>
          <Human x={x + 11} y={y - 6} look={MANAGER_B} prop="tablet" s={0.97} />
          <Human x={x - 11} y={y + 5} look={MANAGER_A} prop="phone" />
        </g>
      );
    else {
      const bot = f.bot as BotName;
      const mood: Mood = isNow ? "focus" : isDone ? "happy" : BOTS[bot].mood;
      fig = <BotFigure bot={bot} mood={mood} x={x} y={y} scale={0.5} />;
    }
    items.push({ depth: d, key: `fig${i}`, node: fig });
  });
  items.sort((a, b) => a.depth - b.depth);

  return (
    <svg viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`} className="jm-svg" role="img" aria-label={`How a batch moves through the bots. Current step: ${FLOW[stage]?.title ?? "finished"}.`}>
      {LANES.map((l, i) => (
        <Slab key={i} iso={iso} x0={l.x0} y0={l.y0} x1={l.x1} y1={l.y1} z={0} h={0.75} top={l.top} left={l.left} right={l.right} />
      ))}
      {LANES.map((l, i) => {
        // Painted on the front side of each lane, in that side's plane.
        const [x, y] = l.dir === "x" ? iso(l.at, l.y1, -0.52) : iso(l.x1, l.at, -0.52);
        const m = l.dir === "x" ? `matrix(0.866 0.5 0 1 ${x} ${y})` : `matrix(0.866 -0.5 0 1 ${x} ${y})`;
        return (
          <text key={`l${i}`} transform={m} textAnchor="middle" className="jm-lane">
            {l.label}
          </text>
        );
      })}
      <polyline points={pts(...path)} fill="none" stroke="#ffffff" strokeWidth="2.4" strokeDasharray="7 6" strokeLinecap="round" strokeLinejoin="round" opacity=".95" />
      {ST.map((s, i) => {
        const [x, y] = iso(s.p[0], s.p[1], 0);
        const isNow = i === stage;
        return (
          <ellipse key={`ring${i}`} cx={x} cy={y} rx={isPerson(i) && FLOW[i].bot === "team" ? 34 : 24} ry={isPerson(i) && FLOW[i].bot === "team" ? 17 : 12} fill={isNow ? "rgba(124,92,255,.32)" : "rgba(255,255,255,.6)"} stroke={isNow ? "#7c5cff" : "rgba(27,42,107,.18)"} strokeWidth={isNow ? 2 : 1} className={isNow ? "flow-now" : undefined} />
        );
      })}
      {items.map((it) => (
        <g key={it.key}>{it.node}</g>
      ))}
      {ST.map((_, i) => {
        const [bx, by] = badgeAt(i);
        const isNow = i === stage;
        const isDone = i < stage;
        return (
          <g key={`b${i}`} transform={`translate(${bx} ${by})`}>
            <circle r="11.5" fill={isDone ? "#1e9e57" : isNow ? "#7c5cff" : "var(--canvas)"} stroke={isDone || isNow ? "#fff" : "var(--line-ink)"} strokeWidth="1.6" />
            <text y="4" textAnchor="middle" className="flow-num" fill={isDone || isNow ? "#fff" : "var(--line-ink)"}>
              {isDone ? "✓" : i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- the whole map with cards and leader lines

type Line = { x1: number; y1: number; x2: number; y2: number; side: "L" | "R"; now: boolean };

export function FlowMap({ stage, onPick, text }: { stage: number; onPick: (b: BotName) => void; text: Record<string, string> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const art = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLElement | null)[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = wrap.current;
    const a = art.current;
    if (!el || !a) return;
    const measure = () => {
      const b = el.getBoundingClientRect();
      setBox({ w: b.width, h: b.height });
      const sv = a.getBoundingClientRect();
      // Stacked layout (not enough room): the cards sit under the art, so no leader lines.
      const first = cards.current[0]?.getBoundingClientRect();
      if (!first || first.top >= sv.bottom - 1) return setLines([]);
      const sc = sv.width / VB.w;
      setLines(
        ST.map((s, i) => {
          const c = cards.current[i]?.getBoundingClientRect();
          const [ax, ay] = badgeAt(i);
          const x2 = sv.left - b.left + (ax - VB.x) * sc + (s.side === "L" ? -12 : 12) * sc;
          const y2 = sv.top - b.top + (ay - VB.y) * sc;
          const x1 = c ? (s.side === "L" ? c.right : c.left) - b.left : x2;
          const y1 = c ? c.top - b.top + 24 : y2;
          return { x1, y1, x2, y2, side: s.side, now: i === stage };
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stage]);

  return (
    <div className="jm-host">
    <div className="jm" ref={wrap}>
      <h3 className="jm-title">How a batch flows</h3>
      <div className="jm-art" ref={art}>
        <MapArt stage={stage} />
      </div>
      {box.w > 0 && lines.length > 0 && (
        <svg className="jm-lines" width={box.w} height={box.h} aria-hidden="true">
          {lines.map((l, i) => {
            const out = l.side === "L" ? 14 : -14;
            return (
              <g key={i} className={l.now ? "now" : undefined}>
                <polyline points={`${l.x1},${l.y1} ${l.x1 + out},${l.y1} ${l.x2},${l.y2}`} fill="none" />
                <circle cx={l.x1} cy={l.y1} r="4" />
              </g>
            );
          })}
        </svg>
      )}
      {FLOW.map((f, i) => {
        const s = ST[i];
        const b = f.bot !== "you" && f.bot !== "team" ? (f.bot as BotName) : null;
        const state = i === stage ? "now" : i < stage ? "done" : "";
        const who = (
          <>
            {b ? (
              <BotFace bot={b} size={34} />
            ) : f.bot === "you" ? (
              <HumanAvatar look={YOU} />
            ) : (
              <span className="jm-pair">
                <HumanAvatar look={MANAGER_A} size={30} />
                <HumanAvatar look={MANAGER_B} size={30} />
              </span>
            )}
            <span className="jm-role">
              <b>{b ? BOTS[b].name : f.bot === "you" ? "You" : "Another marketing manager"}</b>
              <span>{b ? BOTS[b].role : f.bot === "you" ? "Adds the notes, the media and the batch" : "Approves each post before it goes out"}</span>
            </span>
          </>
        );
        return (
          <article
            key={f.key}
            ref={(el) => {
              cards.current[i] = el;
            }}
            className={`jm-card ${state}`}
            style={{ gridColumn: s.side === "L" ? 1 : 3, gridRow: s.row + 1, order: i + 1 }}
          >
            <header>
              <span className="jm-n">{i < stage ? "✓" : i + 1}</span>
              <h4>{f.title}</h4>
              {i === stage && <span className="jm-now">Now</span>}
            </header>
            <p>{text[f.key]}</p>
            {b ? (
              <button type="button" className="jm-who" onClick={() => onPick(b)} title={`Open the ${BOTS[b].name}`}>
                {who}
              </button>
            ) : (
              <div className="jm-who">{who}</div>
            )}
          </article>
        );
      })}
    </div>
    </div>
  );
}
