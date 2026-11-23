// The bots' office: a wide isometric room (original artwork) where each bot has a desk.
// Bots with work stay at their desks and type; the others get up and wander: coffee, water, the bookshelf,
// the arcade machine, the windows and the sofa, then walk back. Movement runs in JavaScript (not CSS),
// so it can be paused with the "Motion" switch.
// The bots are re-sorted by depth every frame, so they are mouse targets only (not focusable): keyboard and screen
// reader users pick a bot with the fixed-order bot buttons the page renders under the office.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BOT_ORDER, BOTS, BotFigure, isoFn, pts, Slab, type BotName, type BotView, type Mood, type P } from "./BotArt";

const W = 16; // room length (along the window wall)
const D = 9; // room depth
const H = 4.2; // wall height
const S = 48; // pixels per unit
const iso = isoFn(404, 236, S);
const C30 = Math.cos(Math.PI / 6);
const SCALE = 0.6; // bot size
const SPEED = 1.7; // units per second
const AISLE = 5.0; // the walkway between the two rows of desks

// Maps flat wall coordinates (u along the wall, z up) onto a wall, so windows and screens can be drawn as plain rects.
function wall(w: "x" | "y") {
  const [ox, oy] = iso(0, 0, 0);
  return w === "y" ? `matrix(${C30 * S} ${0.5 * S} 0 ${-S} ${ox} ${oy})` : `matrix(${-C30 * S} ${0.5 * S} 0 ${-S} ${ox} ${oy})`;
}

const DESKS: Record<BotName, P> = {
  caption: [3, 3.2],
  style: [6.5, 3.2],
  scheduler: [10, 3.2],
  posting: [4.8, 6.6],
  checker: [8.3, 6.6],
};
const seatOf = (b: BotName): P => [DESKS[b][0], DESKS[b][1] - 0.95];

interface Spot {
  id: string;
  label: string;
  mood: Mood;
  prop?: "mug" | "book";
  pos: P;
  /** Waypoints from the aisle to the spot (the last one is the spot itself). */
  entry: P[];
  sit?: boolean;
}

const SPOTS: Spot[] = [
  { id: "coffee", label: "Getting coffee", mood: "happy", prop: "mug", pos: [13.6, 1.75], entry: [[13.6, AISLE], [13.6, 1.75]] },
  { id: "water", label: "Getting water", mood: "wink", prop: "mug", pos: [1.25, 4.3], entry: [[1.25, AISLE], [1.25, 4.3]] },
  { id: "books", label: "Reading", mood: "neutral", prop: "book", pos: [1.25, 2.0], entry: [[1.25, AISLE], [1.25, 2.0]] },
  { id: "arcade", label: "Playing a game", mood: "focus", pos: [1.85, 7.0], entry: [[1.85, AISLE], [1.85, 7.0]] },
  { id: "window1", label: "Looking outside", mood: "happy", pos: [10.2, 1.25], entry: [[11.8, AISLE], [11.8, 1.3], [10.2, 1.25]] },
  { id: "window2", label: "Looking outside", mood: "wink", pos: [7.0, 1.25], entry: [[11.8, AISLE], [11.8, 1.3], [7.0, 1.25]] },
  { id: "sofa1", label: "Taking a break", mood: "happy", pos: [13.3, 7.0], sit: true, entry: [[12.1, AISLE], [12.1, 7.6], [13.3, 7.6], [13.3, 7.0]] },
  { id: "sofa2", label: "Taking a break", mood: "happy", pos: [14.5, 7.0], sit: true, entry: [[12.1, AISLE], [12.1, 7.6], [14.5, 7.6], [14.5, 7.0]] },
];

interface Agent {
  pos: P;
  path: P[];
  phase: "seated" | "going" | "at" | "returning";
  spot: Spot | null;
  carry: "mug" | "book" | null;
  until: number;
  walk: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function routeTo(b: BotName, spot: Spot): P[] {
  const sy = seatOf(b)[1];
  const side = DESKS[b][0] + 1.45; // the gap beside the desk
  return [[side, sy], [side, AISLE], ...spot.entry];
}

function routeBack(b: BotName, spot: Spot): P[] {
  const r = routeTo(b, spot);
  r.pop(); // that's where we are now
  return [...r.reverse(), seatOf(b)];
}

function freeSpot(agents: Record<BotName, Agent>, me: BotName, filter: (s: Spot) => boolean): Spot | null {
  const taken = new Set(BOT_ORDER.filter((b) => b !== me && agents[b].spot).map((b) => agents[b].spot!.id));
  const options = SPOTS.filter((s) => filter(s) && !taken.has(s.id));
  return options.length ? options[Math.floor(Math.random() * options.length)] : null;
}

/** Advances every bot by dt seconds. */
function step(agents: Record<BotName, Agent>, views: Record<BotName, BotView>, dt: number, now: number) {
  for (const b of BOT_ORDER) {
    const a = agents[b];
    const v = views[b];
    const mustSit = v.state === "working" || v.state === "attention";
    const sleepy = v.state === "off";

    if (a.path.length) {
      let left = SPEED * dt;
      while (left > 0 && a.path.length) {
        const [tx, ty] = a.path[0];
        const dx = tx - a.pos[0];
        const dy = ty - a.pos[1];
        const dist = Math.hypot(dx, dy);
        if (dist <= left) {
          a.pos = [tx, ty];
          a.path.shift();
          left -= dist;
        } else {
          a.pos = [a.pos[0] + (dx / dist) * left, a.pos[1] + (dy / dist) * left];
          left = 0;
        }
      }
      a.walk += dt * 11;
      if (!a.path.length) {
        if (a.phase === "going") {
          a.phase = "at";
          a.carry = a.spot?.prop ?? null;
          a.until = now + rand(6000, 11000);
        } else if (a.phase === "returning") {
          a.phase = "seated";
          a.spot = null;
          a.carry = null;
          a.until = now + rand(4000, 9000);
        }
      }
      continue;
    }

    if (a.phase === "at" && a.spot && (mustSit || (!sleepy && now > a.until) || (sleepy && !a.spot.sit))) {
      a.path = routeBack(b, a.spot);
      a.phase = "returning";
    } else if (a.phase === "seated" && !mustSit && (sleepy || now > a.until)) {
      const spot = freeSpot(agents, b, sleepy ? (s) => !!s.sit : () => true);
      if (spot) {
        a.spot = spot;
        a.path = routeTo(b, spot);
        a.phase = "going";
      } else a.until = now + 3000;
    }
  }
}

function initialAgents(): Record<BotName, Agent> {
  const now = performance.now();
  return Object.fromEntries(
    BOT_ORDER.map((b, i) => [b, { pos: seatOf(b), path: [], phase: "seated", spot: null, carry: null, until: now + 1200 + i * 1600, walk: 0 } as Agent]),
  ) as Record<BotName, Agent>;
}

// ---------------------------------------------------------------- the room (static parts)

function Plant({ x, y, size = 1 }: { x: number; y: number; size?: number }) {
  const [px, py] = iso(x, y, 0.55);
  const k = size;
  return (
    <g>
      <Slab iso={iso} x0={x - 0.28} y0={y - 0.28} x1={x + 0.28} y1={y + 0.28} z={0.55} h={0.55} top="#e9e6f5" left="#d8d4ea" right="#c9c4df" />
      <g>
        <ellipse cx={px - 11 * k} cy={py - 22 * k} rx={7 * k} ry={18 * k} fill="#6a4ee8" transform={`rotate(-28 ${px - 11 * k} ${py - 22 * k})`} />
        <ellipse cx={px + 11 * k} cy={py - 22 * k} rx={7 * k} ry={18 * k} fill="#6a4ee8" transform={`rotate(28 ${px + 11 * k} ${py - 22 * k})`} />
        <ellipse cx={px - 4 * k} cy={py - 30 * k} rx={7 * k} ry={21 * k} fill="#8b72ff" transform={`rotate(-8 ${px - 4 * k} ${py - 30 * k})`} />
        <ellipse cx={px + 5 * k} cy={py - 28 * k} rx={6 * k} ry={19 * k} fill="#a493ff" transform={`rotate(12 ${px + 5 * k} ${py - 28 * k})`} />
      </g>
    </g>
  );
}

function FloorLamp({ x, y }: { x: number; y: number }) {
  const [bx, by] = iso(x, y, 0);
  const [tx, ty] = iso(x, y, 2.1);
  return (
    <g>
      <ellipse cx={bx} cy={by} rx="12" ry="5" fill="#2a2740" />
      <line x1={bx} y1={by} x2={tx} y2={ty} stroke="#2a2740" strokeWidth="3" />
      <path d={`M${tx - 16} ${ty + 8} L${tx - 9} ${ty - 14} L${tx + 9} ${ty - 14} L${tx + 16} ${ty + 8}Z`} fill="#fff4d4" stroke="#f2b01e" strokeWidth="1.5" />
    </g>
  );
}

function Floor() {
  const planks: ReactNode[] = [];
  for (let y = 0.5; y < D; y += 0.5) {
    const [ax, ay] = iso(0, y);
    const [bx, by] = iso(W, y);
    planks.push(<line key={`p${y}`} x1={ax} y1={ay} x2={bx} y2={by} stroke="#e8dccb" strokeWidth="1" />);
  }
  // staggered plank joints
  for (let y = 0; y < D; y += 0.5) {
    for (let x = ((y * 4) % 3) + 1; x < W; x += 3) {
      const [ax, ay] = iso(x, y);
      const [bx, by] = iso(x, y + 0.5);
      planks.push(<line key={`j${x}-${y}`} x1={ax} y1={ay} x2={bx} y2={by} stroke="#e8dccb" strokeWidth="1" />);
    }
  }
  const carpet: ReactNode[] = [];
  for (let x = 1.5; x <= 11.5; x += 1) carpet.push(<line key={`cx${x}`} x1={iso(x, 1.6)[0]} y1={iso(x, 1.6)[1]} x2={iso(x, 8.4)[0]} y2={iso(x, 8.4)[1]} stroke="#d9ddea" strokeWidth="1" />);
  for (let y = 1.6; y <= 8.4; y += 1) carpet.push(<line key={`cy${y}`} x1={iso(1.5, y)[0]} y1={iso(1.5, y)[1]} x2={iso(11.5, y)[0]} y2={iso(11.5, y)[1]} stroke="#d9ddea" strokeWidth="1" />);
  return (
    <g>
      <Slab iso={iso} x0={0} y0={0} x1={W} y1={D} z={0} h={0.4} top="#f3ebe0" left="#ded3c4" right="#cfc3b2" />
      {planks}
      {/* carpet under the desks */}
      <polygon points={pts(iso(1.5, 1.6), iso(11.5, 1.6), iso(11.5, 8.4), iso(1.5, 8.4))} fill="#e6e9f2" />
      {carpet}
      {/* sunlight from the windows */}
      {[5.0, 7.3, 9.6].map((u) => (
        <polygon key={u} points={pts(iso(u + 0.5, 0.05), iso(u + 2.6, 0.05), iso(u + 1.9, 2.3), iso(u - 0.2, 2.3))} fill="rgba(255, 236, 190, .32)" />
      ))}
      {/* doormat by the door */}
      <polygon points={pts(iso(0.05, 7.85), iso(0.95, 7.85), iso(0.95, 8.85), iso(0.05, 8.85))} fill="#6b6480" />
      <polygon points={pts(iso(0.15, 7.95), iso(0.85, 7.95), iso(0.85, 8.75), iso(0.15, 8.75))} fill="none" stroke="#8c86a0" strokeWidth="1.5" />
      {/* lounge rug */}
      <polygon points={pts(iso(12.2, 6.0), iso(15.7, 6.0), iso(15.7, 8.8), iso(12.2, 8.8))} fill="#e3dcff" />
      <polygon points={pts(iso(12.45, 6.25), iso(15.45, 6.25), iso(15.45, 8.55), iso(12.45, 8.55))} fill="none" stroke="#c9bdfa" strokeWidth="2" />
    </g>
  );
}

function Skyline() {
  // Buildings seen through the windows, drawn in wall units (u along the wall, z up).
  const b: [number, number, number][] = [
    [5.1, 0.6, 2.2], [5.7, 0.5, 2.6], [6.2, 0.7, 1.9], [7.0, 0.4, 2.9], [7.5, 0.6, 2.3], [8.2, 0.5, 2.7],
    [8.8, 0.7, 2.0], [9.6, 0.5, 3.0], [10.1, 0.6, 2.4], [10.8, 0.7, 2.8], [11.4, 0.3, 2.1],
  ];
  return (
    <g>
      {b.map(([u, w, h], i) => (
        <rect key={i} x={u} y={1.2} width={w} height={h - 1.2 + 0.2} fill={i % 2 ? "#b8c7e4" : "#a9badb"} />
      ))}
    </g>
  );
}

function Clock() {
  const now = new Date();
  const m = now.getMinutes() + now.getSeconds() / 60;
  const h = (now.getHours() % 12) + m / 60;
  const hand = (turns: number, len: number) => {
    const a = turns * 2 * Math.PI;
    return [Math.sin(a) * len, Math.cos(a) * len];
  };
  const [hx, hy] = hand(h / 12, 0.18);
  const [mx, my] = hand(m / 60, 0.27);
  return (
    <g>
      <circle cx="14" cy="3.62" r="0.36" fill="#fff" stroke="#2a2740" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      <line x1="14" y1="3.62" x2={14 + hx} y2={3.62 + hy} stroke="#2a2740" strokeWidth="3" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      <line x1="14" y1="3.62" x2={14 + mx} y2={3.62 + my} stroke="#7c5cff" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
    </g>
  );
}

const NOTES: [number, number, string][] = [
  [1.95, 3.45, "#ffe48a"], [2.35, 3.48, "#c6a8ff"], [2.7, 3.42, "#a9dcff"],
  [1.98, 3.02, "#ffb3c7"], [2.38, 3.0, "#ffe48a"], [2.72, 3.05, "#b6f0c8"],
  [2.15, 2.62, "#a9dcff"], [2.6, 2.6, "#c6a8ff"],
];

function Walls({ t }: { t: number }) {
  return (
    <g>
      {/* wall faces */}
      <polygon points={pts(iso(0, 0, 0), iso(0, D, 0), iso(0, D, H), iso(0, 0, H))} fill="#e7e9f2" />
      <polygon points={pts(iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, H), iso(0, 0, H))} fill="#f2f3f8" />
      {/* wall tops and ends */}
      <polygon points={pts(iso(-0.25, -0.25, H), iso(W, -0.25, H), iso(W, 0, H), iso(0, 0, H), iso(0, D, H), iso(-0.25, D, H))} fill="#d6d9e6" />
      <polygon points={pts(iso(W, 0, 0), iso(W, -0.25, 0), iso(W, -0.25, H), iso(W, 0, H))} fill="#c9cddd" />
      <polygon points={pts(iso(-0.25, D, 0), iso(0, D, 0), iso(0, D, H), iso(-0.25, D, H))} fill="#c3c7d8" />

      {/* long wall: dashboard, windows, kitchen cabinets, clock */}
      <g transform={wall("y")}>
        <rect x="0" y="0" width={W} height="0.14" fill="#d9dce8" />
        {/* dashboard screen */}
        <rect x="0.7" y="1.5" width="3.6" height="2.2" rx="0.06" fill="#1e1b2e" />
        <rect x="0.9" y="2.65" width="1.5" height="0.85" fill="#2c2843" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <rect key={i} x={1.0 + i * 0.22} y={2.72} width="0.12" height={0.18 + (((i * 37) % 7) / 10) * (0.8 + 0.2 * Math.sin(t / 900 + i))} fill={i % 2 ? "#9a82ff" : "#45b8f5"} />
        ))}
        <rect x="2.6" y="2.65" width="1.5" height="0.85" fill="#2c2843" />
        <circle cx="3.35" cy="3.07" r="0.3" fill="none" stroke="#7c5cff" strokeWidth="6" vectorEffect="non-scaling-stroke" />
        <rect x="0.9" y="1.7" width="3.2" height="0.75" fill="#2c2843" />
        <rect x="1.0" y="2.1" width={1.6 + 0.4 * Math.sin(t / 1500)} height="0.12" fill="#7c5cff" />
        <rect x="1.0" y="1.85" width="1.1" height="0.12" fill="#45b8f5" />
        {/* windows */}
        {[5.0, 7.3, 9.6].map((u) => (
          <g key={u}>
            <rect x={u} y="1.15" width="2.1" height="2.5" fill="url(#sky)" />
          </g>
        ))}
        <g clipPath="url(#windows)">
          <Skyline />
        </g>
        {[5.0, 7.3, 9.6].map((u) => (
          // vector-effect isn't inherited, so each frame line sets it (otherwise the stroke scales with the wall: 5 units wide)
          <g key={`f${u}`} fill="none" stroke="#ffffff">
            <rect x={u} y="1.15" width="2.1" height="2.5" strokeWidth="6" vectorEffect="non-scaling-stroke" />
            <line x1={u + 1.05} y1="1.15" x2={u + 1.05} y2="3.65" strokeWidth="4" vectorEffect="non-scaling-stroke" />
            <line x1={u} y1="2.4" x2={u + 2.1} y2="2.4" strokeWidth="4" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {/* blinds, half down on the last window */}
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect key={`bl${i}`} x="9.6" y={3.6 - i * 0.11} width="2.1" height="0.07" fill="#e9ebf3" stroke="#d3d7e4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        <rect x="9.6" y="3.6" width="2.1" height="0.08" fill="#cfd3e0" />
        {[5.0, 7.3, 9.6].map((u) => (
          <rect key={`s${u}`} x={u - 0.08} y="1.05" width="2.26" height="0.1" fill="#d9dce8" />
        ))}
        {/* little plants on the window sills */}
        {[5.5, 8.4, 10.9].map((u, i) => (
          <g key={`sp${u}`}>
            <rect x={u} y="1.15" width="0.28" height="0.22" fill={["#f2b01e", "#d93a32", "#1f5fd6"][i]} />
            <ellipse cx={u + 0.08} cy="1.5" rx="0.07" ry="0.16" fill="#1e9e57" />
            <ellipse cx={u + 0.2} cy="1.52" rx="0.07" ry="0.18" fill="#29b765" />
          </g>
        ))}
        {/* air conditioner above the windows */}
        <rect x="7.6" y="3.76" width="1.7" height="0.34" rx="0.05" fill="#ffffff" stroke="#d3d7e4" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {[0, 1, 2].map((i) => (
          <rect key={`ac${i}`} x="7.7" y={3.8 + i * 0.07} width="1.5" height="0.025" fill="#c8cddc" />
        ))}
        <circle cx="9.15" cy="4.02" r="0.025" fill="#1e9e57" />
        {/* power outlets */}
        {[4.6, 12.1].map((u) => (
          <rect key={`o${u}`} x={u} y="0.3" width="0.18" height="0.14" fill="#fff" stroke="#c8cddc" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {/* kitchen upper cabinets */}
        <rect x="12.4" y="2.2" width="3.2" height="1.0" fill="#ffffff" stroke="#d6d9e6" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {[12.4, 13.47, 14.54].map((u) => (
          <g key={u}>
            <rect x={u + 0.05} y="2.25" width="0.97" height="0.9" fill="none" stroke="#e1e3ec" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            <rect x={u + 0.48} y="2.32" width="0.02" height="0.18" fill="#9aa0b4" />
          </g>
        ))}
        {/* backsplash */}
        <rect x="12.4" y="1.0" width="3.2" height="0.75" fill="#e3e6f0" />
        <Clock />
      </g>

      {/* short wall: big dashboard, framed art */}
      <g transform={wall("x")}>
        <rect x="0" y="0" width={D} height="0.14" fill="#cfd2df" />
        <rect x="3.4" y="2.1" width="4.0" height="1.8" rx="0.06" fill="#1e1b2e" />
        <rect x="3.6" y="2.3" width="1.7" height="1.4" fill="#2c2843" />
        <rect x="5.5" y="3.0" width="1.7" height="0.7" fill="#2c2843" />
        <rect x="5.5" y="2.3" width="1.7" height="0.55" fill="#7c5cff" />
        <polyline
          points={[0, 1, 2, 3, 4, 5, 6].map((i) => `${3.7 + i * 0.25},${2.45 + 0.35 * Math.abs(Math.sin(i * 1.3 + t / 2000))}`).join(" ")}
          fill="none"
          stroke="#45b8f5"
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
        <rect x="5.65" y="3.15" width={0.6 + 0.5 * Math.abs(Math.sin(t / 2200))} height="0.12" fill="#9a82ff" />
        <rect x="5.65" y="3.4" width="0.9" height="0.12" fill="#45b8f5" />
        {/* whiteboard with a plan and sticky notes */}
        <rect x="0.55" y="2.5" width="2.5" height="1.4" fill="#ffffff" stroke="#9aa0b4" strokeWidth="3" vectorEffect="non-scaling-stroke" />
        <rect x="0.7" y="2.45" width="2.2" height="0.07" fill="#9aa0b4" />
        <polyline points="0.75,3.5 1.05,3.62 1.35,3.42 1.6,3.68" fill="none" stroke="#1f5fd6" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <polyline points="0.75,3.2 1.5,3.2" fill="none" stroke="#2a2740" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <polyline points="0.75,3.05 1.3,3.05" fill="none" stroke="#2a2740" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <polyline points="0.75,2.85 1.6,2.85" fill="none" stroke="#d93a32" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {NOTES.map(([u, z, c], i) => (
          <rect key={`n${i}`} x={u} y={z} width="0.3" height="0.3" fill={c} />
        ))}
        {/* door, exit sign and light switch */}
        <rect x="7.8" y="0" width="1.1" height="2.45" fill="#b39a7c" />
        <rect x="7.86" y="0" width="0.98" height="2.38" fill="#c9b293" />
        <rect x="8.1" y="1.55" width="0.5" height="0.6" fill="#dbe9fb" />
        <circle cx="8.72" cy="1.15" r="0.05" fill="#4a4666" />
        <rect x="8.05" y="2.6" width="0.6" height="0.22" fill="#1e9e57" />
        <rect x="8.15" y="2.68" width="0.4" height="0.06" fill="#ffffff" />
        <rect x="7.45" y="1.25" width="0.14" height="0.2" fill="#fff" stroke="#c8cddc" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </g>

      {/* small floating holo cards above the walls, like the screens in a control room */}
      <g transform={wall("y")} opacity=".9">
        <rect x="2.0" y={4.45 + 0.05 * Math.sin(t / 700)} width="0.9" height="0.45" rx="0.05" fill="#7c5cff" />
        <rect x="6.4" y={4.55 + 0.05 * Math.sin(t / 800 + 1)} width="1.2" height="0.5" rx="0.05" fill="#2c2843" />
        <rect x="6.55" y={4.7 + 0.05 * Math.sin(t / 800 + 1)} width="0.7" height="0.1" fill="#9a82ff" />
        <rect x="11.6" y={4.4 + 0.05 * Math.sin(t / 650 + 2)} width="0.7" height="0.4" rx="0.05" fill="#9a82ff" />
      </g>
      <g transform={wall("x")} opacity=".9">
        <rect x="5.4" y={4.5 + 0.05 * Math.sin(t / 750 + 3)} width="1.0" height="0.45" rx="0.05" fill="#9a82ff" />
        <rect x="1.6" y={4.4 + 0.05 * Math.sin(t / 900 + 4)} width="0.8" height="0.4" rx="0.05" fill="#2c2843" />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------- furniture (sorted by depth with the bots)

interface Drawable {
  key: number;
  id: string;
  el: ReactNode;
}

function deskItems(b: BotName, working: boolean, resting: boolean): Drawable[] {
  const [dx, dy] = DESKS[b];
  const lamp = BOT_ORDER.indexOf(b) % 2 === 0;
  const [sx, sy] = seatOf(b);
  const color = BOTS[b].color;
  const legs = [
    [dx - 1.0, dy + 0.45],
    [dx + 1.0, dy + 0.45],
    [dx + 1.0, dy - 0.45],
    [dx - 1.0, dy - 0.45],
  ].map(([lx, ly], i) => {
    const [ax, ay] = iso(lx, ly, 0.9);
    const [bx, by] = iso(lx, ly, 0);
    return <line key={i} x1={ax} y1={ay} x2={bx} y2={by} stroke="#2a2740" strokeWidth="3" />;
  });
  const chairBase = iso(sx, sy, 0);
  const chairTop = iso(sx, sy, 0.48);
  return [
    {
      key: sx + sy - 0.3,
      id: `chair-${b}`,
      el: (
        <g>
          <ellipse cx={chairBase[0]} cy={chairBase[1]} rx="22" ry="9" fill="rgba(30,27,46,.12)" />
          <line x1={chairBase[0]} y1={chairBase[1]} x2={chairTop[0]} y2={chairTop[1]} stroke="#2a2740" strokeWidth="4" />
          <line x1={chairBase[0] - 16} y1={chairBase[1] + 2} x2={chairBase[0] + 16} y2={chairBase[1] - 2} stroke="#2a2740" strokeWidth="3" />
          <Slab iso={iso} x0={sx - 0.38} y0={sy - 0.62} x1={sx + 0.38} y1={sy - 0.5} z={1.35} h={0.75} top="#4a4666" left="#3d3a55" right="#34314a" />
          <Slab iso={iso} x0={sx - 0.38} y0={sy - 0.38} x1={sx + 0.38} y1={sy + 0.38} z={0.58} h={0.1} top="#4a4666" left="#3d3a55" right="#34314a" />
        </g>
      ),
    },
    {
      key: dx + dy,
      id: `desk-${b}`,
      el: (
        <g>
          <polygon points={pts(iso(dx - 1.1, dy - 0.55), iso(dx + 1.1, dy - 0.55), iso(dx + 1.1, dy + 0.55), iso(dx - 1.1, dy + 0.55))} fill="rgba(30,27,46,.08)" />
          {legs}
          <Slab iso={iso} x0={dx - 1.1} y0={dy - 0.55} x1={dx + 1.1} y1={dy + 0.55} z={0.95} h={0.07} top="#ffffff" left="#e7e5f0" right="#d8d5e6" stroke="#e1def0" />
          {/* monitor (we see its back) and stand */}
          <Slab iso={iso} x0={dx - 0.08} y0={dy - 0.3} x1={dx + 0.08} y1={dy - 0.18} z={1.25} h={0.3} top="#4a4666" left="#3d3a55" right="#34314a" />
          <Slab iso={iso} x0={dx - 0.62} y0={dy - 0.36} x1={dx + 0.62} y1={dy - 0.3} z={1.85} h={0.65} top="#4a4666" left={working ? "#5b3fe0" : "#3d3a55"} right="#34314a" />
          {working && <polygon points={pts(iso(dx - 0.62, dy - 0.36, 1.86), iso(dx + 0.62, dy - 0.36, 1.86), iso(dx + 0.62, dy - 0.36, 2.0), iso(dx - 0.62, dy - 0.36, 2.0))} fill="#9a82ff" opacity=".5" />}
          {/* papers, mug and a small light in the bot's colour */}
          <Slab iso={iso} x0={dx - 0.95} y0={dy + 0.05} x1={dx - 0.45} y1={dy + 0.42} z={0.98} h={0.02} top="#f6f6fb" left="#e4e4ee" right="#e4e4ee" />
          {resting && <Slab iso={iso} x0={dx + 0.6} y0={dy + 0.1} x1={dx + 0.78} y1={dy + 0.28} z={1.15} h={0.18} top="#fff" left={color} right={color} />}
          <Slab iso={iso} x0={dx + 0.75} y0={dy - 0.4} x1={dx + 0.95} y1={dy - 0.2} z={1.02} h={0.06} top={color} left={color} right={color} />
          {/* keyboard and mouse on the bot side of the monitor */}
          <Slab iso={iso} x0={dx - 0.42} y0={dy - 0.52} x1={dx + 0.42} y1={dy - 0.4} z={0.99} h={0.03} top="#d6d3e6" left="#bfbbd6" right="#b0abcb" />
          <Slab iso={iso} x0={dx + 0.5} y0={dy - 0.52} x1={dx + 0.6} y1={dy - 0.42} z={0.99} h={0.03} top="#d6d3e6" left="#bfbbd6" right="#b0abcb" />
          {lamp ? (
            <g>
              <line x1={iso(dx - 0.85, dy - 0.3, 0.96)[0]} y1={iso(dx - 0.85, dy - 0.3, 0.96)[1]} x2={iso(dx - 0.85, dy - 0.3, 1.55)[0]} y2={iso(dx - 0.85, dy - 0.3, 1.55)[1]} stroke="#2a2740" strokeWidth="2.5" />
              <line x1={iso(dx - 0.85, dy - 0.3, 1.55)[0]} y1={iso(dx - 0.85, dy - 0.3, 1.55)[1]} x2={iso(dx - 0.6, dy - 0.3, 1.45)[0]} y2={iso(dx - 0.6, dy - 0.3, 1.45)[1]} stroke="#2a2740" strokeWidth="2.5" />
              <ellipse cx={iso(dx - 0.6, dy - 0.3, 1.42)[0]} cy={iso(dx - 0.6, dy - 0.3, 1.42)[1]} rx="9" ry="5" fill={color} />
              <ellipse cx={iso(dx - 0.85, dy - 0.3, 0.97)[0]} cy={iso(dx - 0.85, dy - 0.3, 0.97)[1]} rx="8" ry="4" fill="#2a2740" />
            </g>
          ) : (
            <g>
              <Slab iso={iso} x0={dx - 0.9} y0={dy - 0.4} x1={dx - 0.75} y1={dy - 0.25} z={1.15} h={0.18} top="#3d3a55" left="#4a4666" right="#34314a" />
              {[0, 1, 2].map((i) => {
                const [px, py] = iso(dx - 0.82 + i * 0.03, dy - 0.33, 1.15);
                return <line key={i} x1={px} y1={py} x2={px - 2 + i * 3} y2={py - 10} stroke={["#d93a32", "#1f5fd6", "#f2b01e"][i]} strokeWidth="2" />;
              })}
            </g>
          )}
          {/* the bot colour along the desk front */}
          <polygon points={pts(iso(dx - 1.1, dy + 0.55, 0.9), iso(dx - 0.5, dy + 0.55, 0.9), iso(dx - 0.5, dy + 0.55, 0.88), iso(dx - 1.1, dy + 0.55, 0.88))} fill={color} stroke={color} strokeWidth="2" />
        </g>
      ),
    },
    {
      key: dx - 1.3 + dy + 0.3,
      id: `bin-${b}`,
      el: <Slab iso={iso} x0={dx - 1.42} y0={dy + 0.18} x1={dx - 1.18} y1={dy + 0.42} z={0.38} h={0.38} top="#4a4666" left="#8c86a0" right="#77718d" />,
    },
  ];
}

function furniture(t: number): Drawable[] {
  const arcadeGlow = ["#7c5cff", "#45b8f5", "#f2b01e", "#1e9e57"][Math.floor(t / 600) % 4];
  const machineOn = Math.floor(t / 900) % 2 === 0;
  return [
    {
      key: 0.2 + 2.0,
      id: "bookshelf",
      el: (
        <g>
          <Slab iso={iso} x0={0.05} y0={1.0} x1={0.5} y1={3.0} z={2.3} h={2.3} top="#d9c7ae" left="#c9b393" right="#b89f7d" />
          {[0.5, 1.05, 1.6].map((z) =>
            [0, 1, 2, 3, 4, 5, 6].map((i) => {
              const y0 = 1.12 + i * 0.26;
              return (
                <polygon
                  key={`${z}-${i}`}
                  points={pts(iso(0.5, y0, z), iso(0.5, y0 + 0.18, z), iso(0.5, y0 + 0.18, z + 0.36 + (i % 3) * 0.05), iso(0.5, y0, z + 0.36 + (i % 3) * 0.05))}
                  fill={["#7c5cff", "#1f5fd6", "#f2b01e", "#d93a32", "#1e9e57", "#9a82ff", "#45b8f5"][(i + z * 10) % 7]}
                />
              );
            }),
          )}
        </g>
      ),
    },
    {
      key: 0.4 + 4.25,
      id: "cooler",
      el: (
        <g>
          <Slab iso={iso} x0={0.2} y0={4.0} x1={0.65} y1={4.5} z={1.0} h={1.0} top="#eef0f6" left="#dfe2ec" right="#cfd3e0" />
          <Slab iso={iso} x0={0.27} y0={4.07} x1={0.58} y1={4.43} z={1.45} h={0.45} top="#a9dcff" left="#7cc6fb" right="#63b4ef" />
        </g>
      ),
    },
    {
      key: 0.6 + 7.0,
      id: "arcade",
      el: (
        <g>
          <Slab iso={iso} x0={0.2} y0={6.6} x1={1.0} y1={7.4} z={1.95} h={1.95} top="#3d2b99" left="#5b3fe0" right="#4a32c4" />
          <polygon points={pts(iso(1.0, 6.72, 1.75), iso(1.0, 7.28, 1.75), iso(1.0, 7.28, 1.25), iso(1.0, 6.72, 1.25))} fill={arcadeGlow} />
          <polygon points={pts(iso(1.0, 6.72, 1.92), iso(1.0, 7.28, 1.92), iso(1.0, 7.28, 1.8), iso(1.0, 6.72, 1.8))} fill="#f2b01e" />
          <Slab iso={iso} x0={1.0} y0={6.65} x1={1.25} y1={7.35} z={1.0} h={0.15} top="#2c2843" left="#2c2843" right="#1e1b2e" />
        </g>
      ),
    },
    {
      key: 12.4 + 1.1,
      id: "kitchen",
      el: (
        <g>
          <Slab iso={iso} x0={12.4} y0={0.1} x1={15.6} y1={1.1} z={1.0} h={1.0} top="#f4f4f8" left="#ffffff" right="#e2e4ee" stroke="#e1e3ec" />
          {[12.4, 13.47, 14.54].map((x) => (
            <line key={x} x1={iso(x + 1.07, 1.1, 0.95)[0]} y1={iso(x + 1.07, 1.1, 0.95)[1]} x2={iso(x + 1.07, 1.1, 0.05)[0]} y2={iso(x + 1.07, 1.1, 0.05)[1]} stroke="#e1e3ec" strokeWidth="1.5" />
          ))}
          {/* coffee machine */}
          <Slab iso={iso} x0={13.25} y0={0.25} x1={13.85} y1={0.8} z={1.75} h={0.75} top="#3d3a55" left="#2c2843" right="#25223a" />
          <circle cx={iso(13.55, 0.8, 1.55)[0]} cy={iso(13.55, 0.8, 1.55)[1]} r="3.5" fill={machineOn ? "#7c5cff" : "#45b8f5"} />
          {/* mugs and a fruit bowl */}
          <Slab iso={iso} x0={14.2} y0={0.6} x1={14.38} y1={0.78} z={1.17} h={0.17} top="#fff" left="#d93a32" right="#b8261f" />
          <Slab iso={iso} x0={14.5} y0={0.6} x1={14.68} y1={0.78} z={1.17} h={0.17} top="#fff" left="#1f5fd6" right="#153f91" />
          <ellipse cx={iso(12.8, 0.6, 1.06)[0]} cy={iso(12.8, 0.6, 1.06)[1]} rx="15" ry="6.5" fill="#f2b01e" />
          <circle cx={iso(12.72, 0.55, 1.12)[0]} cy={iso(12.72, 0.55, 1.12)[1]} r="4.5" fill="#d93a32" />
          <circle cx={iso(12.9, 0.62, 1.12)[0]} cy={iso(12.9, 0.62, 1.12)[1]} r="4.5" fill="#1e9e57" />
          {/* microwave */}
          <Slab iso={iso} x0={14.85} y0={0.2} x1={15.5} y1={0.8} z={1.42} h={0.42} top="#e2e4ee" left="#f4f4f8" right="#cfd3e0" />
          <polygon points={pts(iso(14.92, 0.8, 1.36), iso(15.3, 0.8, 1.36), iso(15.3, 0.8, 1.08), iso(14.92, 0.8, 1.08))} fill="#2c2843" />
          <circle cx={iso(15.42, 0.8, 1.25)[0]} cy={iso(15.42, 0.8, 1.25)[1]} r="2.5" fill="#1e9e57" />
          {/* steam from the coffee machine */}
          {[0, 1].map((i) => {
            const [sx0, sy0] = iso(13.55, 0.55, 1.8);
            const rise = (t / 40 + i * 18) % 36;
            return <path key={i} d={`M${sx0 - 3 + i * 6} ${sy0 - rise} q4 -6 0 -12`} fill="none" stroke="#b8bfd3" strokeWidth="2.5" strokeLinecap="round" opacity={1 - rise / 36} />;
          })}
        </g>
      ),
    },
    {
      key: 12.6 + 6.4,
      id: "sofa",
      el: (
        <g>
          <polygon points={pts(iso(12.6, 6.4), iso(15.3, 6.4), iso(15.3, 7.35), iso(12.6, 7.35))} fill="rgba(30,27,46,.1)" />
          <Slab iso={iso} x0={12.6} y0={6.4} x1={15.3} y1={6.72} z={1.15} h={1.15} top="#6a4ee8" left="#5b3fe0" right="#4a32c4" />
          <Slab iso={iso} x0={12.6} y0={6.72} x1={15.3} y1={7.35} z={0.48} h={0.48} top="#8b72ff" left="#6a4ee8" right="#5b3fe0" />
          <Slab iso={iso} x0={12.95} y0={6.72} x1={13.4} y1={6.85} z={0.9} h={0.4} top="#f2b01e" left="#e09f12" right="#c98d0b" />
          <Slab iso={iso} x0={14.55} y0={6.72} x1={15.0} y1={6.85} z={0.9} h={0.4} top="#45b8f5" left="#2fa3e3" right="#1f8fce" />
          <Slab iso={iso} x0={12.45} y0={6.4} x1={12.7} y1={7.35} z={0.8} h={0.8} top="#6a4ee8" left="#5b3fe0" right="#4a32c4" />
          <Slab iso={iso} x0={15.2} y0={6.4} x1={15.45} y1={7.35} z={0.8} h={0.8} top="#6a4ee8" left="#5b3fe0" right="#4a32c4" />
        </g>
      ),
    },
    {
      key: 13.5 + 8.3 + 0.5,
      id: "table",
      el: (
        <g>
          <Slab iso={iso} x0={13.55} y0={7.85} x1={14.35} y1={8.4} z={0.42} h={0.08} top="#ffffff" left="#e7e5f0" right="#d8d5e6" stroke="#e1def0" />
          <line x1={iso(13.95, 8.12, 0.34)[0]} y1={iso(13.95, 8.12, 0.34)[1]} x2={iso(13.95, 8.12, 0)[0]} y2={iso(13.95, 8.12, 0)[1]} stroke="#2a2740" strokeWidth="3" />
          <Slab iso={iso} x0={13.7} y0={7.95} x1={13.88} y1={8.13} z={0.6} h={0.17} top="#fff" left="#1e9e57" right="#157a43" />
          <Slab iso={iso} x0={13.98} y0={8.0} x1={14.28} y1={8.32} z={0.44} h={0.02} top="#c6a8ff" left="#9a82ff" right="#9a82ff" />
        </g>
      ),
    },
    { key: 11.9 + 0.6, id: "plant1", el: <Plant x={11.9} y={0.6} size={1.2} /> },
    { key: 0.55 + 5.75, id: "plant2", el: <Plant x={0.55} y={5.75} size={1.2} /> },
    {
      key: 15.0 + 4.3 + 0.4,
      id: "printer",
      el: (
        <g>
          <Slab iso={iso} x0={15.0} y0={4.3} x1={15.7} y1={5.0} z={0.75} h={0.75} top="#e2e4ee" left="#f4f4f8" right="#cfd3e0" stroke="#e1e3ec" />
          <Slab iso={iso} x0={15.05} y0={4.35} x1={15.65} y1={4.95} z={1.15} h={0.4} top="#f4f4f8" left="#e2e4ee" right="#c9cddd" />
          <Slab iso={iso} x0={15.15} y0={4.4} x1={15.55} y1={4.75} z={1.17} h={0.02} top="#ffffff" left="#ffffff" right="#ffffff" />
          <polygon points={pts(iso(15.08, 4.95, 0.95), iso(15.5, 4.95, 0.95), iso(15.5, 4.95, 0.88), iso(15.08, 4.95, 0.88))} fill="#2c2843" />
          <circle cx={iso(15.6, 4.95, 1.05)[0]} cy={iso(15.6, 4.95, 1.05)[1]} r="2.5" fill={Math.floor(t / 1200) % 2 ? "#1e9e57" : "#45b8f5"} />
        </g>
      ),
    },
    {
      key: 15.7 + 6.0,
      id: "floorlamp",
      el: <FloorLamp x={15.7} y={6.0} />,
    },
    { key: 15.4 + 3.0, id: "plant3", el: <Plant x={15.4} y={3.0} size={1.1} /> },
    { key: 11.3 + 8.5, id: "plant4", el: <Plant x={11.3} y={8.5} size={1.0} /> },
    { key: 4.5 + 0.6, id: "plant5", el: <Plant x={4.5} y={0.6} size={0.9} /> },
  ];
}

// ---------------------------------------------------------------- the scene

function trim(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function BotOffice({ views, selected, onSelect, motion }: { views: Record<BotName, BotView>; selected: BotName; onSelect: (b: BotName) => void; motion: boolean }) {
  const agents = useRef<Record<BotName, Agent>>(initialAgents());
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const [t, setT] = useState(() => performance.now());

  useEffect(() => {
    if (!motion) return;
    let raf = 0;
    let last = performance.now();
    let drawn = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      step(agents.current, viewsRef.current, dt, now);
      if (now - drawn > 33) {
        drawn = now;
        setT(now);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [motion]);

  // Without motion, bots that must work still go straight to their desks.
  useEffect(() => {
    if (motion) return;
    for (const b of BOT_ORDER) {
      const v = views[b];
      if (v.state === "working" || v.state === "attention") Object.assign(agents.current[b], { pos: seatOf(b), path: [], phase: "seated", spot: null, carry: null });
    }
    setT(performance.now());
  }, [motion, views]);

  const items: Drawable[] = [...furniture(t)];
  const labels: { b: BotName; x: number; y: number; text: string; tone: string }[] = [];

  for (const b of BOT_ORDER) {
    const a = agents.current[b];
    const v = views[b];
    const seated = a.phase === "seated" && !a.path.length;
    const sofa = a.phase === "at" && !!a.spot?.sit && !a.path.length;
    const walking = a.path.length > 0;
    items.push(...deskItems(b, v.state === "working" && seated, seated && (v.state === "idle" || v.state === "done")));

    const [x, y] = seated ? iso(a.pos[0], a.pos[1], 0.6) : sofa ? iso(a.pos[0], a.pos[1], 0.5) : iso(a.pos[0], a.pos[1], 0);
    const [gx, gy] = iso(a.pos[0], a.pos[1], 0);
    const mood: Mood =
      v.state === "off" && (sofa || seated)
        ? "sleep"
        : seated
          ? v.state === "working"
            ? "focus"
            : v.mood
          : walking
            ? v.state === "off"
              ? "sleep"
              : "neutral"
            : a.spot?.mood ?? v.mood;
    const bob = seated && v.state === "working" ? Math.sin(t / 70) * 1.5 : (seated || sofa) ? Math.sin(t / 600 + BOT_ORDER.indexOf(b)) * 1.2 : 0;
    const sel = selected === b;
    items.push({
      key: a.pos[0] + a.pos[1] + (seated ? 0.05 : 0),
      id: `bot-${b}`,
      el: (
        <g className="office-bot" aria-hidden="true" onClick={() => onSelect(b)}>
          {sel && <ellipse cx={gx} cy={gy} rx="40" ry="20" fill="rgba(124,92,255,.14)" stroke="#7c5cff" strokeWidth="2" strokeDasharray="6 5" />}
          {!seated && !sofa && <ellipse cx={gx} cy={gy} rx="20" ry="8" fill="rgba(30,27,46,.16)" />}
          <BotFigure bot={b} mood={mood} x={x} y={y} scale={SCALE} pose={seated || sofa ? "sit" : "stand"} walk={walking ? a.walk : undefined} bob={bob} prop={a.carry} />
        </g>
      ),
    });

    const top = y - (seated || sofa ? 119 : 131) * SCALE + bob;
    const text =
      v.state === "off" || v.state === "working" || v.state === "attention" || seated
        ? v.task
        : a.phase === "returning"
          ? "Back to my desk"
          : a.spot?.label ?? v.task;
    const tone = v.state === "attention" ? "#d93a32" : v.state === "working" ? "url(#holo)" : v.state === "off" ? "#8c8aa0" : "#2c2843";
    labels.push({ b, x, y: top - 14, text, tone });
  }
  items.sort((p, q) => p.key - q.key);
  labels.sort((p, q) => p.y - q.y);

  return (
    <svg viewBox="0 0 1100 870" className="office-svg" role="img" aria-label={`The bots' office. ${BOT_ORDER.map((b) => `${BOTS[b].name}: ${views[b].task}`).join(". ")}. Use the bot buttons below to open a bot's panel.`}>
      <defs>
        <linearGradient id="holo" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9a82ff" stopOpacity=".95" />
          <stop offset="1" stopColor="#7c5cff" stopOpacity=".8" />
        </linearGradient>
        {/* The wall transform flips the y axis, so the sky gradient runs bottom (pale) to top (blue). */}
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f4f8ff" />
          <stop offset="1" stopColor="#bcd5fb" />
        </linearGradient>
        <clipPath id="windows" clipPathUnits="userSpaceOnUse">
          {[5.0, 7.3, 9.6].map((u) => (
            <rect key={u} x={u} y="1.15" width="2.1" height="2.5" />
          ))}
        </clipPath>
      </defs>
      <Floor />
      <Walls t={t} />
      {items.map((d) => (
        <g key={d.id}>{d.el}</g>
      ))}
      {labels.map(({ b, x, y, text, tone }) => {
        const label = trim(text, 30);
        const w = Math.max(96, label.length * 6.4 + 22);
        const nameW = BOTS[b].name.length * 7 + 34;
        const sel = selected === b;
        return (
          <g key={`label-${b}`} className="office-bot" onClick={() => onSelect(b)} aria-hidden="true">
            <rect x={x - nameW / 2} y={y - 50} width={nameW} height="22" rx="11" fill="#fff" stroke={sel ? "#7c5cff" : "#e1def0"} strokeWidth="1.5" />
            <circle cx={x - nameW / 2 + 13} cy={y - 39} r="4" fill={BOTS[b].color} />
            <text x={x + 6} y={y - 34.5} textAnchor="middle" className="office-name">{BOTS[b].name}</text>
            <rect x={x - w / 2} y={y - 24} width={w} height="24" rx="8" fill={tone} />
            <path d={`M${x - 5} ${y} L${x} ${y + 6} L${x + 5} ${y}z`} fill={tone === "url(#holo)" ? "#7c5cff" : tone} />
            <text x={x} y={y - 7.5} textAnchor="middle" className="office-holo">{label}</text>
          </g>
        );
      })}
    </svg>
  );
}
