// The bots' office: a wide isometric campus (original artwork). Each bot has its own glass-walled pod with a desk;
// its monitor faces us and the bot sits in front of it with its back to us, typing while it works. Bots with no work
// get up and wander: the coffee bar, the game lounge (TV and game pads), the arcade, the reading nook, the water
// cooler and the tennis court, where two bots rally a ball over the net. They face the way they walk: towards us,
// away from us, left or right.
// The view opens close up on the bots at their desks, then pulls back to the whole office; a button zooms in and out.
// Movement runs in JavaScript (not CSS), so the "Motion" switch pauses it. The bots are re-sorted by depth every
// frame, so they are mouse targets only (not focusable): keyboard and screen reader users pick a bot with the
// fixed-order bot buttons the page renders under the office.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BOT_ORDER, BOTS, BotFigure, isoFn, pts, Slab, type BotName, type BotView, type Mood, type P } from "./BotArt";

const W = 26; // along the back wall (x)
const D = 16; // along the left wall (y)
const H = 3.6; // wall height
const S = 34; // pixels per unit
const C30 = Math.cos(Math.PI / 6);
const OX = Math.round(D * S * C30 + 40);
const OY = Math.round(H * S + 96);
const iso = isoFn(OX, OY, S);
const VW = 1320;
const VH = 960;
const SCALE = 0.44; // bot size
const SPEED = 2.1; // units per second

// Walkways: Y1 runs in front of the back pods, X1 in front of the side pods, Y2 between the lounge and the court,
// and X2 joins Y1 and Y2 on the right.
const Y1 = 5.6;
const X1 = 5.7;
const Y2 = 11.5;
const X2 = 19.6;

// Maps flat wall coordinates (u along the wall, z up) onto a wall, so windows and posters can be drawn as plain rects.
function wall(w: "x" | "y") {
  const [ox, oy] = iso(0, 0, 0);
  return w === "y" ? `matrix(${C30 * S} ${0.5 * S} 0 ${-S} ${ox} ${oy})` : `matrix(${-C30 * S} ${0.5 * S} 0 ${-S} ${ox} ${oy})`;
}

/** Lighter version of a colour (amt 0..1 towards white). */
function tint(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * amt);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

// ---------------------------------------------------------------- the pods

/** "y": a pod along the back wall (monitor faces +y); "x": a pod along the left wall (monitor faces +x). */
interface Pod {
  axis: "x" | "y";
  desk: P; // centre of the desk
  floor: [number, number, number, number]; // x0, y0, x1, y1
}
const PODS: Record<BotName, Pod> = {
  caption: { axis: "y", desk: [2.5, 2.05], floor: [0, 0, 5, 4.9] },
  style: { axis: "y", desk: [7.5, 2.05], floor: [5, 0, 10, 4.9] },
  editor: { axis: "y", desk: [12.5, 2.05], floor: [10, 0, 15, 4.9] },
  scheduler: { axis: "y", desk: [17.5, 2.05], floor: [15, 0, 20, 4.9] },
  checker: { axis: "x", desk: [2.05, 8.65], floor: [0, 6.3, 5, 11.05] },
  posting: { axis: "x", desk: [2.05, 13.5], floor: [0, 11.05, 5, 15.9] },
};
const seatOf = (b: BotName): P => {
  const { axis, desk } = PODS[b];
  return axis === "y" ? [desk[0], desk[1] + 1.2] : [desk[0] + 1.2, desk[1]];
};
/** Where a bot steps onto the walkway from its pod. */
const exitOf = (b: BotName): P => {
  const { axis, desk } = PODS[b];
  return axis === "y" ? [desk[0], Y1] : [X1, desk[1]];
};

// ---------------------------------------------------------------- places to go

type Lane = "Y1" | "Y2";
interface Spot {
  id: string;
  label: string;
  mood: Mood;
  prop?: "mug" | "book" | "pad" | "racket";
  pos: P;
  lane: Lane;
  /** Waypoints from the walkway to the spot (the last one is the spot itself). */
  entry: P[];
  /** Seat height when the bot sits here. */
  sit?: number;
  facing: "front" | "back";
  turn: number;
  /** Hands busy at a game pad. */
  play?: boolean;
}

const straight = (x: number, y: number, lane: Lane): P[] => [[x, lane === "Y1" ? Y1 : Y2], [x, y]];
const SPOTS: Spot[] = [
  // coffee bar stools, facing the counter
  ...[21.8, 23.2, 24.6].map((x, i): Spot => ({ id: `stool${i}`, label: "Having a coffee", mood: i === 1 ? "wink" : "happy", prop: "mug", pos: [x, 3.0], lane: "Y1", entry: straight(x, 3.0, "Y1"), sit: 0.78, facing: "back", turn: 1 })),
  // game lounge: beanbags facing the TV
  ...[9.9, 11.5, 13.1].map((x, i): Spot => ({ id: `bean${i}`, label: "Playing a video game", mood: "focus", prop: "pad", pos: [x, 9.7], lane: "Y2", entry: straight(x, 9.7, "Y2"), sit: 0.34, facing: "back", turn: 1, play: true })),
  // arcade machines
  ...[16.85, 17.75].map((x, i): Spot => ({ id: `arcade${i}`, label: "Playing arcade", mood: "determined", pos: [x, 8.5], lane: "Y2", entry: straight(x, 8.5, "Y2"), facing: "back", turn: 1, play: true })),
  // tennis court, one player each side of the net
  { id: "tennisL", label: "Playing tennis", mood: "determined", prop: "racket", pos: [14.6, 14.0], lane: "Y2", entry: straight(14.6, 14.0, "Y2"), facing: "front", turn: 1 },
  { id: "tennisR", label: "Playing tennis", mood: "happy", prop: "racket", pos: [22.0, 14.0], lane: "Y2", entry: straight(22.0, 14.0, "Y2"), facing: "back", turn: -1 },
  // reading nook and water cooler
  { id: "books", label: "Choosing a book", mood: "neutral", pos: [7.3, 14.0], lane: "Y2", entry: straight(7.3, 14.0, "Y2"), facing: "back", turn: -1 },
  { id: "read", label: "Reading", mood: "happy", prop: "book", pos: [9.0, 14.5], lane: "Y2", entry: straight(9.0, 14.5, "Y2"), facing: "front", turn: -1 },
  { id: "water", label: "Getting water", mood: "wink", prop: "mug", pos: [10.6, 13.6], lane: "Y2", entry: straight(10.6, 13.6, "Y2"), facing: "front", turn: 1 },
];

/** Walkway route from a pod's exit to a spot's walkway point. */
function laneRoute(b: BotName, spot: Spot): P[] {
  const e = exitOf(b);
  const side = PODS[b].axis === "x";
  const target = spot.entry[0];
  if (spot.lane === "Y1") return side ? [e, [X1, Y1], target] : [e, target];
  if (side) return [e, [X1, Y2], target];
  // back pod to Y2: left via X1 or right via X2, whichever is shorter
  const viaLeft = Math.abs(e[0] - X1) + Math.abs(target[0] - X1);
  const viaRight = Math.abs(e[0] - X2) + Math.abs(target[0] - X2);
  return viaLeft <= viaRight ? [e, [X1, Y1], [X1, Y2], target] : [e, [X2, Y1], [X2, Y2], target];
}
function routeTo(b: BotName, spot: Spot): P[] {
  return [...laneRoute(b, spot), ...spot.entry.slice(1)];
}
function routeBack(b: BotName, spot: Spot): P[] {
  const r = routeTo(b, spot);
  r.pop(); // that's where we are now
  return [...r.reverse(), seatOf(b)];
}

// ---------------------------------------------------------------- moving the bots

interface Agent {
  pos: P;
  path: P[];
  phase: "seated" | "going" | "at" | "returning";
  spot: Spot | null;
  until: number;
  walk: number;
  facing: "front" | "back";
  turn: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function freeSpot(agents: Record<BotName, Agent>, me: BotName, filter: (s: Spot) => boolean): Spot | null {
  const taken = new Set(BOT_ORDER.filter((b) => b !== me && agents[b].spot).map((b) => agents[b].spot!.id));
  let options = SPOTS.filter((s) => filter(s) && !taken.has(s.id));
  // Someone already on the court? Join them, so there's a rally.
  const partner = options.find((s) => s.id.startsWith("tennis") && SPOTS.some((o) => o.id.startsWith("tennis") && o.id !== s.id && taken.has(o.id)));
  if (partner && Math.random() < 0.6) return partner;
  if (!options.length) return null;
  options = options.filter((s, i, all) => all.findIndex((o) => o.id.replace(/\d$/, "") === s.id.replace(/\d$/, "")) === i || Math.random() < 0.5);
  return options[Math.floor(Math.random() * options.length)] ?? null;
}

/** Facing from the direction of travel: moving down the screen faces us, up the screen shows the back. */
function faceFrom(dx: number, dy: number): { facing: "front" | "back"; turn: number } {
  const sx = dx - dy;
  const sy = dx + dy;
  return { facing: sy >= 0 ? "front" : "back", turn: sx >= 0 ? 1 : -1 };
}

/** Advances every bot by dt seconds. */
function step(agents: Record<BotName, Agent>, views: Record<BotName, BotView>, dt: number, now: number) {
  for (const b of BOT_ORDER) {
    const a = agents[b];
    const v = views[b];
    const mustSit = v.state === "working" || v.state === "attention";
    const sleepy = v.state === "off";

    // Work arrived while it was on its way somewhere: turn round now, back along the way it came.
    if (a.phase === "going" && a.spot && mustSit && a.path.length) {
      const full = routeTo(b, a.spot);
      const walked = full.slice(0, Math.max(0, full.length - a.path.length));
      a.path = [...walked.reverse(), seatOf(b)];
      a.phase = "returning";
    }
    if (a.path.length) {
      let left = SPEED * dt;
      while (left > 0 && a.path.length) {
        const [tx, ty] = a.path[0];
        const dx = tx - a.pos[0];
        const dy = ty - a.pos[1];
        const dist = Math.hypot(dx, dy);
        if (dist > 0.001) Object.assign(a, faceFrom(dx, dy));
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
          a.until = now + rand(8000, 15000);
        } else if (a.phase === "returning") {
          a.phase = "seated";
          a.spot = null;
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
    BOT_ORDER.map((b, i) => [
      b,
      { pos: seatOf(b), path: [], phase: "seated", spot: null, until: now + 3500 + i * 1500, walk: 0, facing: "back", turn: PODS[b].axis === "y" ? 1 : -1 } as Agent,
    ]),
  ) as Record<BotName, Agent>;
}

// ---------------------------------------------------------------- small pieces

function Plant({ x, y, size = 1 }: { x: number; y: number; size?: number }) {
  const [px, py] = iso(x, y, 0.5);
  const k = size * 0.75;
  return (
    <g>
      <Slab iso={iso} x0={x - 0.24} y0={y - 0.24} x1={x + 0.24} y1={y + 0.24} z={0.5} h={0.5} top="#e9e6f5" left="#d8d4ea" right="#c9c4df" />
      <ellipse cx={px - 11 * k} cy={py - 22 * k} rx={7 * k} ry={18 * k} fill="#1e9e57" transform={`rotate(-28 ${px - 11 * k} ${py - 22 * k})`} />
      <ellipse cx={px + 11 * k} cy={py - 22 * k} rx={7 * k} ry={18 * k} fill="#1e9e57" transform={`rotate(28 ${px + 11 * k} ${py - 22 * k})`} />
      <ellipse cx={px - 4 * k} cy={py - 30 * k} rx={7 * k} ry={21 * k} fill="#29b765" transform={`rotate(-8 ${px - 4 * k} ${py - 30 * k})`} />
      <ellipse cx={px + 5 * k} cy={py - 28 * k} rx={6 * k} ry={19 * k} fill="#5fcf8a" transform={`rotate(12 ${px + 5 * k} ${py - 28 * k})`} />
    </g>
  );
}

/** A flat rectangle lying on the floor (x0..x1, y0..y1). */
const floorRect = (x0: number, y0: number, x1: number, y1: number, z = 0) => pts(iso(x0, y0, z), iso(x1, y0, z), iso(x1, y1, z), iso(x0, y1, z));

/** Tile lines over a floor area. */
function tiles(x0: number, y0: number, x1: number, y1: number, color: string, step = 1, key = "") {
  const out: ReactNode[] = [];
  for (let x = x0 + step; x < x1 - 0.01; x += step) out.push(<line key={`${key}x${x}`} x1={iso(x, y0)[0]} y1={iso(x, y0)[1]} x2={iso(x, y1)[0]} y2={iso(x, y1)[1]} stroke={color} strokeWidth="1" />);
  for (let y = y0 + step; y < y1 - 0.01; y += step) out.push(<line key={`${key}y${y}`} x1={iso(x0, y)[0]} y1={iso(x0, y)[1]} x2={iso(x1, y)[0]} y2={iso(x1, y)[1]} stroke={color} strokeWidth="1" />);
  return out;
}

// ---------------------------------------------------------------- the floor and walls (static, drawn first)

/** Never changes, so it's drawn once (memo) instead of on every animation frame. */
const Floor = memo(function Floor() {
  return (
    <g>
      <Slab iso={iso} x0={0} y0={0} x1={W} y1={D} z={0} h={0.45} top="#f6dbe8" left="#d9b6c8" right="#c9a3b7" />
      {tiles(0, 0, W, D, "#efc8db", 1, "main")}
      {/* pod floors in each bot's colour */}
      {BOT_ORDER.map((b) => {
        const [x0, y0, x1, y1] = PODS[b].floor;
        return (
          <g key={b}>
            <polygon points={floorRect(x0, y0, x1, y1)} fill={tint(BOTS[b].color, 0.62)} />
            {tiles(x0, y0, x1, y1, tint(BOTS[b].color, 0.5), 0.5, b)}
          </g>
        );
      })}
      {/* coffee bar: wooden floor */}
      <polygon points={floorRect(20, 0, W, 4.9)} fill="#e9cfa8" />
      {tiles(20, 0, W, 4.9, "#dcbc8f", 0.5, "cafe")}
      {/* game lounge rug */}
      <polygon points={floorRect(8.6, 6.6, 14.6, 10.7)} fill="#3d3a6b" />
      <polygon points={floorRect(8.9, 6.9, 14.3, 10.4)} fill="none" stroke="#7c5cff" strokeWidth="2" />
      {/* arcade corner */}
      <polygon points={floorRect(16.2, 6.5, 18.6, 9.3)} fill="#2c2843" />
      {tiles(16.2, 6.5, 18.6, 9.3, "#3d3a55", 0.6, "arc")}
      {/* reading nook rug */}
      <polygon points={floorRect(6.4, 12.6, 11.6, 15.7)} fill="#fff4d4" />
      <polygon points={floorRect(6.7, 12.9, 11.3, 15.4)} fill="none" stroke="#f2b01e" strokeWidth="2" />
      {/* tennis court: green surround, blue court, white lines */}
      <polygon points={floorRect(11.9, 12.2, 25.6, 15.95)} fill="#1e9e57" />
      <polygon points={floorRect(12.6, 12.55, 24.9, 15.6)} fill="#1f5fd6" />
      <g fill="none" stroke="#fff" strokeWidth="2">
        <polygon points={floorRect(12.6, 12.55, 24.9, 15.6)} />
        <polygon points={floorRect(12.6, 12.95, 24.9, 15.2)} />
        <line x1={iso(15.4, 12.95)[0]} y1={iso(15.4, 12.95)[1]} x2={iso(15.4, 15.2)[0]} y2={iso(15.4, 15.2)[1]} />
        <line x1={iso(22.1, 12.95)[0]} y1={iso(22.1, 12.95)[1]} x2={iso(22.1, 15.2)[0]} y2={iso(22.1, 15.2)[1]} />
        <line x1={iso(15.4, 14.08)[0]} y1={iso(15.4, 14.08)[1]} x2={iso(22.1, 14.08)[0]} y2={iso(22.1, 14.08)[1]} />
      </g>
    </g>
  );
});

/** Re-renders only when its (coarse) time changes: the wall animations are slow, so 10 updates a second is plenty. */
const Walls = memo(function Walls({ t }: { t: number }) {
  const sign = 0.5 + 0.5 * Math.sin(t / 500);
  return (
    <g>
      <polygon points={pts(iso(0, 0, 0), iso(0, D, 0), iso(0, D, H), iso(0, 0, H))} fill="#3b3f6e" />
      <polygon points={pts(iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, H), iso(0, 0, H))} fill="#454a7d" />
      <polygon points={pts(iso(-0.25, -0.25, H), iso(W, -0.25, H), iso(W, 0, H), iso(0, 0, H), iso(0, D, H), iso(-0.25, D, H))} fill="#2a2d55" />
      <polygon points={pts(iso(W, 0, 0), iso(W, -0.25, 0), iso(W, -0.25, H), iso(W, 0, H))} fill="#23264a" />
      <polygon points={pts(iso(-0.25, D, 0), iso(0, D, 0), iso(0, D, H), iso(-0.25, D, H))} fill="#20233f" />

      {/* back wall: a window and a poster for each pod, the café shelves and sign, a clock */}
      <g transform={wall("y")}>
        <rect x="0" y="0" width={W} height="0.12" fill="#2a2d55" />
        {[2.5, 7.5, 12.5, 17.5].map((u, i) => (
          <g key={u}>
            <rect x={u - 2.0} y="2.15" width="0.9" height="1.0" fill="url(#sky)" stroke="#9aa3d6" strokeWidth="3" vectorEffect="non-scaling-stroke" />
            <rect x={u + 1.0} y="2.25" width="0.9" height="0.75" rx="0.05" fill={["#ffd06b", "#c6a8ff", "#b6e6e3", "#a9dcff"][i]} />
            <polyline points={`${u + 1.1},2.4 ${u + 1.35},2.7 ${u + 1.55},2.5 ${u + 1.8},2.85`} fill="none" stroke="#2a2740" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {/* café: menu board, shelves with jars, neon sign */}
        <rect x="20.6" y="1.4" width="5.0" height="0.08" fill="#c9a777" />
        <rect x="20.6" y="2.0" width="5.0" height="0.08" fill="#c9a777" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect key={`j${i}`} x={20.8 + i * 0.6} y={i % 2 ? 2.08 : 1.48} width="0.3" height="0.38" rx="0.06" fill={["#f2b01e", "#d93a32", "#1e9e57", "#7c5cff"][i % 4]} opacity=".85" />
        ))}
        <rect x="21.4" y="2.55" width="3.4" height="0.75" rx="0.12" fill="none" stroke={`rgba(255, 122, 200, ${0.55 + 0.45 * sign})`} strokeWidth="4" vectorEffect="non-scaling-stroke" />
        <text x="23.1" y="-2.78" transform="scale(1 -1)" textAnchor="middle" fontSize="0.42" fontWeight="700" fill={`rgba(255, 160, 215, ${0.6 + 0.4 * sign})`} fontFamily="Poppins, sans-serif">
          Bot Café
        </text>
        {/* clock */}
        <circle cx="20.0" cy="3.05" r="0.32" fill="#fff" stroke="#1d2433" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        <line x1="20.0" y1="3.05" x2={20.0 + 0.2 * Math.sin(t / 9000)} y2={3.05 + 0.2 * Math.cos(t / 9000)} stroke="#1d2433" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
        <line x1="20.0" y1="3.05" x2={20.0 + 0.13 * Math.sin(t / 60000)} y2={3.05 + 0.13 * Math.cos(t / 60000)} stroke="#7c5cff" strokeWidth="3" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      </g>

      {/* left wall: windows by the side pods, a big team dashboard near the front */}
      <g transform={wall("x")}>
        <rect x="0" y="0" width={D} height="0.12" fill="#20233f" />
        {[7.0, 9.6, 11.9, 14.4].map((u) => (
          <rect key={u} x={u} y="1.9" width="1.4" height="1.3" fill="url(#sky)" stroke="#9aa3d6" strokeWidth="3" vectorEffect="non-scaling-stroke" />
        ))}
        <rect x="1.2" y="1.7" width="3.0" height="1.6" rx="0.06" fill="#1e1b2e" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect key={`b${i}`} x={1.4 + i * 0.32} y="1.9" width="0.18" height={0.25 + 0.8 * Math.abs(Math.sin(i * 1.7 + t / 1600))} fill={i % 2 ? "#9a82ff" : "#45b8f5"} />
        ))}
      </g>
    </g>
  );
});

// ---------------------------------------------------------------- things sorted by depth with the bots

interface Drawable {
  key: number;
  id: string;
  el: ReactNode;
}

/** A see-through glass panel standing on the floor from a to b (split in 1-unit pieces so depth sorting stays right). */
function glass(id: string, a: P, b: P): Drawable[] {
  const out: Drawable[] = [];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(len));
  for (let i = 0; i < n; i++) {
    const p0: P = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
    const p1: P = [a[0] + ((b[0] - a[0]) * (i + 1)) / n, a[1] + ((b[1] - a[1]) * (i + 1)) / n];
    out.push({
      key: (p0[0] + p1[0]) / 2 + (p0[1] + p1[1]) / 2 + 0.02,
      id: `${id}-${i}`,
      el: (
        <g>
          <polygon points={pts(iso(p0[0], p0[1], 0), iso(p1[0], p1[1], 0), iso(p1[0], p1[1], 0.95), iso(p0[0], p0[1], 0.95))} fill="rgba(190, 225, 255, .28)" />
          <line x1={iso(p0[0], p0[1], 0.95)[0]} y1={iso(p0[0], p0[1], 0.95)[1]} x2={iso(p1[0], p1[1], 0.95)[0]} y2={iso(p1[0], p1[1], 0.95)[1]} stroke="rgba(255,255,255,.85)" strokeWidth="2.5" />
          <line x1={iso(p0[0], p0[1], 0)[0]} y1={iso(p0[0], p0[1], 0)[1]} x2={iso(p0[0], p0[1], 0.95)[0]} y2={iso(p0[0], p0[1], 0.95)[1]} stroke="rgba(255,255,255,.6)" strokeWidth="1.5" />
        </g>
      ),
    });
  }
  return out;
}

function podWalls(): Drawable[] {
  const out: Drawable[] = [];
  for (const b of BOT_ORDER) {
    const { axis, desk, floor } = PODS[b];
    const [x0, y0, x1, y1] = floor;
    if (axis === "y") {
      // front glass with a doorway in front of the desk, and a divider on the right
      out.push(...glass(`${b}-fl`, [x0 + 0.15, y1], [desk[0] - 0.65, y1]), ...glass(`${b}-fr`, [desk[0] + 0.65, y1], [x1 - 0.15, y1]));
      out.push(...glass(`${b}-side`, [x1, y0 + 0.3], [x1, y1]));
    } else {
      out.push(...glass(`${b}-fl`, [x1, y0 + 0.15], [x1, desk[1] - 0.65]), ...glass(`${b}-fr`, [x1, desk[1] + 0.65], [x1, y1 - 0.15]));
      out.push(...glass(`${b}-top`, [x0 + 0.3, y0], [x1, y0]));
    }
  }
  return out;
}

/** Code lines on a monitor, growing while the bot types. */
function screenLines(b: BotName, working: boolean, t: number) {
  const seed = BOT_ORDER.indexOf(b);
  const shown = working ? 3 + (Math.floor(t / 450) % 5) : 4;
  return Array.from({ length: 7 }, (_, i) => ({ w: 0.3 + (((i * 37 + seed * 11) % 9) / 9) * 0.6, on: i < shown, c: i % 3 === 0 ? BOTS[b].color : i % 3 === 1 ? "#1f5fd6" : "#8a93ad" }));
}

function deskItems(b: BotName, working: boolean, t: number): Drawable[] {
  const { axis, desk } = PODS[b];
  const [dx, dy] = desk;
  const [sx, sy] = seatOf(b);
  const color = BOTS[b].color;
  const lines = screenLines(b, working, t);
  // Everything is built for a back-wall pod and mirrored for side pods by swapping x and y.
  const P2 = (u: number, v: number, z = 0): P => (axis === "y" ? iso(dx + u, dy + v, z) : iso(dx + v, dy + u, z));
  const slab = (u0: number, v0: number, u1: number, v1: number, z: number, h: number, top: string, left: string, right: string) =>
    axis === "y" ? (
      <Slab iso={iso} x0={dx + u0} y0={dy + v0} x1={dx + u1} y1={dy + v1} z={z} h={h} top={top} left={left} right={right} />
    ) : (
      <Slab iso={iso} x0={dx + v0} y0={dy + u0} x1={dx + v1} y1={dy + u1} z={z} h={h} top={top} left={right} right={left} />
    );
  const quad = (u0: number, u1: number, v: number, z0: number, z1: number) => pts(P2(u0, v, z0), P2(u1, v, z0), P2(u1, v, z1), P2(u0, v, z1));
  const legs = [-1.0, 1.0].flatMap((u) => [-0.42, 0.42].map((v) => [u, v])).map(([u, v], i) => {
    const [ax, ay] = P2(u, v, 0.92);
    const [bx, by] = P2(u, v, 0);
    return <line key={i} x1={ax} y1={ay} x2={bx} y2={by} stroke="#2a2740" strokeWidth="2.5" />;
  });
  const glow = working ? 0.35 + 0.15 * Math.sin(t / 300) : 0;
  const holoY = 2.75 + 0.06 * Math.sin(t / 700 + BOT_ORDER.indexOf(b));

  return [
    {
      key: dx + dy,
      id: `desk-${b}`,
      el: (
        <g>
          <polygon points={pts(P2(-1.1, -0.5), P2(1.1, -0.5), P2(1.1, 0.5), P2(-1.1, 0.5))} fill="rgba(30,27,46,.1)" />
          {legs}
          {slab(-1.1, -0.5, 1.1, 0.5, 0.95, 0.07, "#ffffff", "#e7e5f0", "#d8d5e6")}
          {/* monitor stand, then the monitor with its screen facing us */}
          {slab(-0.08, -0.38, 0.08, -0.26, 1.25, 0.3, "#4a4666", "#3d3a55", "#34314a")}
          {slab(-0.66, -0.44, 0.66, -0.36, 1.95, 0.72, "#4a4666", "#2c2843", "#34314a")}
          {/* the lit screen: a code editor with a title bar in the bot's colour */}
          <polygon points={quad(-0.6, 0.6, -0.355, 1.29, 1.89)} fill={working ? "#f4f8ff" : "#dfe5f3"} />
          <polygon points={quad(-0.6, 0.6, -0.354, 1.8, 1.89)} fill={color} opacity={working ? 1 : 0.6} />
          {working && <polygon points={quad(-0.6, 0.6, -0.354, 1.29, 1.8)} fill={color} opacity={glow * 0.18} />}
          {lines.map((l, i) =>
            l.on ? <polygon key={i} points={quad(-0.52, -0.52 + l.w, -0.353, 1.7 - i * 0.06, 1.73 - i * 0.06)} fill={l.c} opacity={working ? 1 : 0.5} /> : null,
          )}
          {working &&
            Math.floor(t / 400) % 2 === 0 &&
            (() => {
              // blinking cursor after the last line being typed
              const n = Math.min(7, lines.filter((l) => l.on).length) - 1;
              const end = -0.52 + lines[n].w;
              return <polygon points={quad(end + 0.03, end + 0.08, -0.353, 1.7 - n * 0.06, 1.74 - n * 0.06)} fill="#1d2433" />;
            })()}
          {/* keyboard, mouse, mug, a little plant in the bot's colour */}
          {slab(-0.42, 0.18, 0.42, 0.34, 0.99, 0.03, "#d6d3e6", "#bfbbd6", "#b0abcb")}
          {working && <polygon points={pts(P2(-0.42, 0.18, 1.0), P2(0.42, 0.18, 1.0), P2(0.42, 0.34, 1.0), P2(-0.42, 0.34, 1.0))} fill={color} opacity={0.15 + 0.1 * Math.sin(t / 90)} />}
          {slab(0.55, 0.2, 0.67, 0.32, 0.99, 0.03, "#d6d3e6", "#bfbbd6", "#b0abcb")}
          {slab(0.78, -0.3, 0.95, -0.13, 1.12, 0.17, "#ffffff", color, color)}
          {slab(-0.98, -0.32, -0.78, -0.12, 1.1, 0.15, "#c9a777", "#b8946a", "#a8845b")}
          <ellipse cx={P2(-0.88, -0.22, 1.3)[0]} cy={P2(-0.88, -0.22, 1.3)[1]} rx="5" ry="8" fill="#29b765" />
          {/* floating task card above the desk */}
          <g opacity=".92">
            <polygon points={quad(-0.45, 0.45, -0.4, holoY, holoY + 0.45)} fill={tint(color, 0.15)} />
            <polygon points={quad(-0.35, 0.15, -0.399, holoY + 0.27, holoY + 0.33)} fill="#fff" />
            <polygon points={quad(-0.35, 0.3, -0.399, holoY + 0.12, holoY + 0.18)} fill="#fff" opacity=".7" />
          </g>
        </g>
      ),
    },
    {
      key: sx + sy - 0.3,
      id: `chair-${b}`,
      el: (
        <g>
          <ellipse cx={iso(sx, sy)[0]} cy={iso(sx, sy)[1]} rx="16" ry="7" fill="rgba(30,27,46,.14)" />
          <line x1={iso(sx, sy)[0]} y1={iso(sx, sy)[1]} x2={iso(sx, sy, 0.5)[0]} y2={iso(sx, sy, 0.5)[1]} stroke="#2a2740" strokeWidth="3" />
          {axis === "y" ? (
            <Slab iso={iso} x0={sx - 0.32} y0={sy - 0.3} x1={sx + 0.32} y1={sy + 0.3} z={0.58} h={0.09} top="#4a4666" left="#3d3a55" right="#34314a" />
          ) : (
            <Slab iso={iso} x0={sx - 0.3} y0={sy - 0.32} x1={sx + 0.3} y1={sy + 0.32} z={0.58} h={0.09} top="#4a4666" left="#3d3a55" right="#34314a" />
          )}
        </g>
      ),
    },
    {
      // the backrest is between us and the bot's back
      key: sx + sy + 0.5,
      id: `chairback-${b}`,
      el:
        axis === "y" ? (
          <Slab iso={iso} x0={sx - 0.32} y0={sy + 0.28} x1={sx + 0.32} y1={sy + 0.38} z={1.05} h={0.47} top="#5b5680" left={color} right="#34314a" />
        ) : (
          <Slab iso={iso} x0={sx + 0.28} y0={sy - 0.32} x1={sx + 0.38} y1={sy + 0.32} z={1.05} h={0.47} top="#5b5680" left="#3d3a55" right={color} />
        ),
    },
  ];
}

function furniture(t: number, rally: { ball: [number, number, number] | null }): Drawable[] {
  const items: Drawable[] = [];
  const blink = Math.floor(t / 600) % 4;

  // ---- coffee bar
  items.push({
    // A long counter is sorted by its front-left corner, so everyone on the stools in front of it is drawn after it.
    key: 20.8 + 2.1,
    id: "bar",
    el: (
      <g>
        <Slab iso={iso} x0={20.8} y0={1.25} x1={25.6} y1={2.1} z={1.05} h={1.05} top="#d9b27a" left="#b98a4e" right="#a5793f" />
        <Slab iso={iso} x0={20.8} y0={1.25} x1={25.6} y1={2.1} z={1.1} h={0.05} top="#f1d6ae" left="#e0bf8f" right="#d2b07f" />
        {/* espresso machine with steam */}
        <Slab iso={iso} x0={21.2} y0={1.35} x1={21.9} y1={1.85} z={1.75} h={0.65} top="#c9cddd" left="#a7adc2" right="#8f96ad" />
        <circle cx={iso(21.55, 1.85, 1.5)[0]} cy={iso(21.55, 1.85, 1.5)[1]} r="3" fill={blink % 2 ? "#1e9e57" : "#f2b01e"} />
        {[0, 1].map((i) => {
          const [x0, y0] = iso(21.55, 1.6, 1.8);
          const rise = (t / 40 + i * 18) % 34;
          return <path key={i} d={`M${x0 - 3 + i * 6} ${y0 - rise} q4 -6 0 -12`} fill="none" stroke="#e1e3ec" strokeWidth="2.5" strokeLinecap="round" opacity={1 - rise / 34} />;
        })}
        {[22.6, 23.3, 24.0, 24.7].map((x, i) => (
          <Slab key={x} iso={iso} x0={x} y0={1.6} x1={x + 0.16} y1={1.76} z={1.26} h={0.16} top="#fff" left={["#d93a32", "#1f5fd6", "#f2b01e", "#7c5cff"][i]} right="#c9cddd" />
        ))}
      </g>
    ),
  });
  for (const [i, x] of [21.8, 23.2, 24.6].entries())
    items.push({
      key: x + 3.0 - 0.12,
      id: `stool${i}`,
      el: (
        <g>
          <line x1={iso(x, 3.0)[0]} y1={iso(x, 3.0)[1]} x2={iso(x, 3.0, 0.75)[0]} y2={iso(x, 3.0, 0.75)[1]} stroke="#2a2740" strokeWidth="3" />
          <ellipse cx={iso(x, 3.0)[0]} cy={iso(x, 3.0)[1]} rx="9" ry="4" fill="#2a2740" />
          <ellipse cx={iso(x, 3.0, 0.78)[0]} cy={iso(x, 3.0, 0.78)[1]} rx="12" ry="6" fill="#d93a32" stroke="#a5281f" strokeWidth="1.5" />
        </g>
      ),
    });

  // ---- game lounge: TV on a stand facing the beanbags, game console and speakers
  const tvColors = ["#7c5cff", "#45b8f5", "#f2b01e", "#d93a32", "#1e9e57"];
  items.push({
    key: 11.5 + 7.6,
    id: "tv",
    el: (
      <g>
        <Slab iso={iso} x0={9.4} y0={7.3} x1={13.6} y1={7.85} z={0.5} h={0.5} top="#4a4666" left="#2c2843" right="#25223a" />
        <Slab iso={iso} x0={9.0} y0={7.3} x1={9.4} y1={7.75} z={1.2} h={1.2} top="#2c2843" left="#1e1b2e" right="#16142a" />
        <Slab iso={iso} x0={13.6} y0={7.3} x1={14.0} y1={7.75} z={1.2} h={1.2} top="#2c2843" left="#1e1b2e" right="#16142a" />
        <Slab iso={iso} x0={10.1} y0={7.45} x1={12.9} y1={7.55} z={2.35} h={1.65} top="#2c2843" left="#16142a" right="#1e1b2e" />
        {/* the game on screen: coloured blocks racing along */}
        <polygon points={pts(iso(10.2, 7.551, 0.8), iso(12.8, 7.551, 0.8), iso(12.8, 7.551, 2.25), iso(10.2, 7.551, 2.25))} fill="#1e1b4a" />
        {[0, 1, 2, 3].map((i) => {
          const u = 10.35 + ((t / 900 + i * 0.6) % 2.2);
          return <polygon key={i} points={pts(iso(u, 7.552, 1.0 + i * 0.3), iso(Math.min(12.7, u + 0.35), 7.552, 1.0 + i * 0.3), iso(Math.min(12.7, u + 0.35), 7.552, 1.22 + i * 0.3), iso(u, 7.552, 1.22 + i * 0.3))} fill={tvColors[(i + Math.floor(t / 2000)) % 5]} />;
        })}
        <Slab iso={iso} x0={11.2} y0={7.55} x1={11.8} y1={7.75} z={0.58} h={0.08} top="#e1e3ec" left="#c9cddd" right="#b0b6ca" />
      </g>
    ),
  });
  for (const [i, x] of [9.9, 11.5, 13.1].entries()) {
    const c = ["#f2b01e", "#45b8f5", "#d93a32"][i];
    const [bx, by] = iso(x, 9.75, 0.18);
    items.push({
      key: x + 9.7 - 0.12,
      id: `bean${i}`,
      el: (
        <g>
          <ellipse cx={bx} cy={by + 4} rx="26" ry="13" fill="rgba(0,0,0,.18)" />
          <ellipse cx={bx} cy={by} rx="24" ry="14" fill={c} />
          <ellipse cx={bx - 4} cy={by - 5} rx="14" ry="7" fill="#fff" opacity=".25" />
        </g>
      ),
    });
  }

  // ---- arcade machines
  for (const [i, x] of [16.5, 17.4].entries()) {
    const glowC = ["#7c5cff", "#45b8f5", "#f2b01e", "#d93a32"][(blink + i) % 4];
    items.push({
      key: x + 0.35 + 7.3,
      id: `arcade${i}`,
      el: (
        <g>
          <Slab iso={iso} x0={x} y0={6.95} x1={x + 0.7} y1={7.6} z={1.9} h={1.9} top="#3d2b99" left={i ? "#c2187c" : "#5b3fe0"} right={i ? "#9c1263" : "#4a32c4"} />
          <polygon points={pts(iso(x + 0.08, 7.601, 1.75), iso(x + 0.62, 7.601, 1.75), iso(x + 0.62, 7.601, 1.25), iso(x + 0.08, 7.601, 1.25))} fill={glowC} />
          <polygon points={pts(iso(x + 0.08, 7.601, 1.88), iso(x + 0.62, 7.601, 1.88), iso(x + 0.62, 7.601, 1.78), iso(x + 0.08, 7.601, 1.78))} fill="#ffe48a" />
          <Slab iso={iso} x0={x} y0={7.6} x1={x + 0.7} y1={7.85} z={1.05} h={0.12} top="#2c2843" left="#1e1b2e" right="#1e1b2e" />
        </g>
      ),
    });
  }

  // ---- reading nook: bookshelf (books face the walkway), armchair-free reading spot, water cooler
  items.push({
    key: 6.5 + 14.2,
    id: "shelf",
    el: (
      <g>
        <Slab iso={iso} x0={6.25} y0={12.8} x1={6.7} y1={15.5} z={2.0} h={2.0} top="#d9c7ae" left="#c9b393" right="#b89f7d" />
        {[0.35, 0.95, 1.5].map((z) =>
          [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => {
            const y0 = 12.95 + i * 0.28;
            const h = 0.36 + (i % 3) * 0.05;
            return <polygon key={`${z}-${i}`} points={pts(iso(6.701, y0, z), iso(6.701, y0 + 0.2, z), iso(6.701, y0 + 0.2, z + h), iso(6.701, y0, z + h))} fill={["#7c5cff", "#1f5fd6", "#f2b01e", "#d93a32", "#1e9e57", "#9a82ff", "#45b8f5"][(i + Math.round(z * 10)) % 7]} />;
          }),
        )}
      </g>
    ),
  });
  items.push({
    key: 11.55 + 13.5,
    id: "cooler",
    el: (
      <g>
        <Slab iso={iso} x0={11.3} y0={13.3} x1={11.8} y1={13.75} z={1.0} h={1.0} top="#eef0f6" left="#dfe2ec" right="#cfd3e0" />
        <Slab iso={iso} x0={11.37} y0={13.37} x1={11.73} y1={13.68} z={1.45} h={0.45} top="#a9dcff" left="#7cc6fb" right="#63b4ef" />
      </g>
    ),
  });

  // ---- tennis court: net posts and net (pieces, for depth), and the ball
  for (let i = 0; i < 4; i++) {
    const y0 = 12.4 + i * 0.9;
    const y1 = y0 + 0.9;
    items.push({
      key: 18.25 + (y0 + y1) / 2,
      id: `net${i}`,
      el: (
        <g>
          <polygon points={pts(iso(18.25, y0, 0), iso(18.25, y1, 0), iso(18.25, y1, 0.55), iso(18.25, y0, 0.55))} fill="rgba(255,255,255,.25)" stroke="rgba(255,255,255,.5)" strokeWidth="0.8" />
          <line x1={iso(18.25, y0, 0.55)[0]} y1={iso(18.25, y0, 0.55)[1]} x2={iso(18.25, y1, 0.55)[0]} y2={iso(18.25, y1, 0.55)[1]} stroke="#fff" strokeWidth="2.5" />
          {i === 0 && <line x1={iso(18.25, 12.4, 0)[0]} y1={iso(18.25, 12.4, 0)[1]} x2={iso(18.25, 12.4, 0.62)[0]} y2={iso(18.25, 12.4, 0.62)[1]} stroke="#2a2740" strokeWidth="3" />}
          {i === 3 && <line x1={iso(18.25, 16.0, 0)[0]} y1={iso(18.25, 16.0, 0)[1]} x2={iso(18.25, 16.0, 0.62)[0]} y2={iso(18.25, 16.0, 0.62)[1]} stroke="#2a2740" strokeWidth="3" />}
        </g>
      ),
    });
  }
  if (rally.ball) {
    const [bx, by, bz] = rally.ball;
    const [sx, sy] = iso(bx, by, 0);
    const [px, py] = iso(bx, by, bz);
    items.push({
      key: bx + by + 0.2,
      id: "ball",
      el: (
        <g>
          <ellipse cx={sx} cy={sy} rx="5" ry="2.5" fill="rgba(0,0,0,.25)" />
          <circle cx={px} cy={py} r="5" fill="#d7f55a" stroke="#9cbf1c" strokeWidth="1.5" />
        </g>
      ),
    });
  }

  // ---- plants
  for (const [id, x, y, s] of [
    ["p1", 0.5, 0.5, 1.1],
    ["p2", 25.4, 4.4, 1.2],
    ["p3", 15.3, 6.3, 1.0],
    ["p4", 25.5, 6.2, 1.1],
    ["p5", 11.8, 15.4, 0.9],
    ["p6", 0.5, 15.5, 1.1],
    ["p7", 19.0, 10.6, 1.0],
  ] as [string, number, number, number][])
    items.push({ key: x + y, id, el: <Plant x={x} y={y} size={s} /> });

  return items;
}

// ---------------------------------------------------------------- the camera

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const FULL: Box = { x: 0, y: 0, w: VW, h: VH };
/** A box around the bots' desks, at the scene's aspect ratio. */
function desksBox(): Box {
  const ps = BOT_ORDER.map((b) => iso(...seatOf(b), 1));
  const xs = ps.map((p) => p[0]);
  const ys = ps.map((p) => p[1]);
  const pad = 70;
  let x = Math.min(...xs) - pad;
  let y = Math.min(...ys) - pad - 70;
  let w = Math.max(...xs) - x + pad;
  let h = Math.max(...ys) - y + pad;
  // keep the aspect ratio
  const ratio = VW / VH;
  if (w / h > ratio) {
    const nh = w / ratio;
    y -= (nh - h) / 2;
    h = nh;
  } else {
    const nw = h * ratio;
    x -= (nw - w) / 2;
    w = nw;
  }
  return { x, y, w, h };
}
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const lerpBox = (a: Box, b: Box, k: number): Box => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });

// ---------------------------------------------------------------- the scene

function trim(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Furniture that animates; everything else is built once and reused, so React skips it on every frame.
const ANIMATED_FURNITURE = new Set(["bar", "tv", "arcade0", "arcade1", "ball"]);
// Desk screens update about 15 times a second (typing lines, cursor, glow): enough to look alive, far fewer redraws.
const DESK_TICK = 66;

export function BotOffice({ views, selected, onSelect, motion }: { views: Record<BotName, BotView>; selected: BotName; onSelect: (b: BotName) => void; motion: boolean }) {
  const agents = useRef<Record<BotName, Agent>>(initialAgents());
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const [t, setT] = useState(() => performance.now());
  const close = useRef(desksBox());
  // Camera: starts close on the desks, holds, then pulls back to the whole office.
  const cam = useRef<{ from: Box; to: Box; start: number; dur: number }>({ from: close.current, to: FULL, start: performance.now() + 1600, dur: 2600 });
  const [zoomed, setZoomed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The glass walls and still furniture never change: built once.
  const walls = useMemo(() => podWalls(), []);
  const stillFurniture = useMemo(() => furniture(0, { ball: null }).filter((d) => !ANIMATED_FURNITURE.has(d.id)), []);
  const deskCache = useRef<Partial<Record<BotName, { k: string; items: Drawable[] }>>>({});
  // Labels glide to a new height instead of jumping when they make room for each other.
  const labelLift = useRef<Partial<Record<BotName, number>>>({});
  const lastFrame = useRef(t);

  useEffect(() => {
    if (!motion) {
      cam.current = { from: FULL, to: FULL, start: 0, dur: 1 };
      return;
    }
    let raf = 0;
    let last = performance.now();
    let drawn = 0;
    // Paused while the office is scrolled out of view or the tab is in the background: nothing to see, no CPU spent.
    let visible = true;
    const io = typeof IntersectionObserver !== "undefined" && wrapRef.current ? new IntersectionObserver(([e]) => (visible = e.isIntersecting)) : null;
    if (io && wrapRef.current) io.observe(wrapRef.current);
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (visible && document.visibilityState === "visible") {
        step(agents.current, viewsRef.current, dt, now);
        // Up to 60 frames a second (not more on fast screens): each frame is cheap because still things are reused.
        if (now - drawn > 15) {
          drawn = now;
          setT(now);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [motion]);

  // Without motion, bots that must work still go straight to their desks.
  useEffect(() => {
    if (motion) return;
    for (const b of BOT_ORDER) {
      const v = views[b];
      if (v.state === "working" || v.state === "attention")
        Object.assign(agents.current[b], { pos: seatOf(b), path: [], phase: "seated", spot: null, facing: "back", turn: PODS[b].axis === "y" ? 1 : -1 });
    }
    setT(performance.now());
  }, [motion, views]);

  const camNow = (now: number): Box => {
    const c = cam.current;
    const k = Math.max(0, Math.min(1, (now - c.start) / c.dur));
    return lerpBox(c.from, c.to, ease(k));
  };
  const toggleZoom = () => {
    const now = performance.now();
    const from = camNow(now);
    const to = zoomed ? FULL : desksBox();
    cam.current = motion ? { from, to, start: now, dur: 1200 } : { from: to, to, start: 0, dur: 1 };
    setZoomed(!zoomed);
    if (!motion) setT(now);
  };
  const view = motion ? camNow(t) : cam.current.to;

  // Tennis: with both players on court the ball goes back and forth over the net; one player practises bouncing it.
  const onCourt = BOT_ORDER.filter((b) => {
    const a = agents.current[b];
    return a.phase === "at" && !a.path.length && a.spot?.id.startsWith("tennis");
  });
  const left = onCourt.find((b) => agents.current[b].spot!.id === "tennisL");
  const right = onCourt.find((b) => agents.current[b].spot!.id === "tennisR");
  let ball: [number, number, number] | null = null;
  const swingOf: Partial<Record<BotName, number>> = {};
  if (left && right) {
    const period = 1700;
    const k = (t % (2 * period)) / period; // 0..2
    const goingRight = k < 1;
    const f = goingRight ? k : k - 1;
    const a = agents.current[left].pos;
    const b = agents.current[right].pos;
    const [from, to] = goingRight ? [a, b] : [b, a];
    ball = [from[0] + (to[0] - from[0]) * f + (goingRight ? 0.4 : -0.4), from[1] + (to[1] - from[1]) * f - 0.1, 0.9 + Math.sin(f * Math.PI) * 1.4 - (f > 0.8 ? (f - 0.8) * 2 : 0)];
    swingOf[left] = goingRight ? Math.max(0, 1 - f * 5) : Math.max(0, (f - 0.8) * 5);
    swingOf[right] = goingRight ? Math.max(0, (f - 0.8) * 5) : Math.max(0, 1 - f * 5);
  } else if (onCourt.length === 1) {
    const me = agents.current[onCourt[0]];
    const f = (t % 900) / 900;
    ball = [me.pos[0] + (me.spot!.id === "tennisL" ? 0.4 : -0.4), me.pos[1] + 0.2, 0.15 + Math.abs(Math.sin(f * Math.PI)) * 1.0];
    swingOf[onCourt[0]] = f < 0.15 ? 1 - f / 0.15 : 0;
  }

  const items: Drawable[] = [...stillFurniture, ...furniture(t, { ball }).filter((d) => ANIMATED_FURNITURE.has(d.id)), ...walls];
  const labels: { b: BotName; x: number; base: number; y: number; text: string; tone: string; compact: boolean }[] = [];

  for (const b of BOT_ORDER) {
    const a = agents.current[b];
    const v = views[b];
    const seated = a.phase === "seated" && !a.path.length;
    const atSpot = a.phase === "at" && !a.path.length && a.spot;
    const sitting = seated || (atSpot && a.spot!.sit !== undefined);
    const walking = a.path.length > 0;
    const working = v.state === "working" && seated;
    const tick = Math.floor(t / DESK_TICK);
    const dk = `${working ? 1 : 0}|${tick}`;
    let desk = deskCache.current[b];
    if (!desk || desk.k !== dk) {
      desk = { k: dk, items: deskItems(b, working, tick * DESK_TICK) };
      deskCache.current[b] = desk;
    }
    items.push(...desk.items);

    const z = seated ? 0.62 : atSpot && a.spot!.sit !== undefined ? a.spot!.sit : 0;
    const [x, y] = iso(a.pos[0], a.pos[1], z);
    const [gx, gy] = iso(a.pos[0], a.pos[1], 0);
    const facing = seated ? "back" : atSpot ? a.spot!.facing : a.facing;
    const turn = seated ? (PODS[b].axis === "y" ? 1 : -1) : atSpot ? a.spot!.turn : a.turn;
    const mood: Mood =
      v.state === "off" && sitting ? "sleep" : seated ? (v.state === "working" ? "focus" : v.mood) : walking ? (v.state === "off" ? "sleep" : "neutral") : (a.spot?.mood ?? v.mood);
    const playing = !!(atSpot && a.spot!.play);
    // Typing at the desk while working; a gentle tap while idle at the desk; thumbs busy at a game.
    const typing = seated ? (v.state === "working" ? t / 55 : v.state === "attention" ? t / 140 : undefined) : playing ? t / 75 : undefined;
    const bob = seated && v.state === "working" ? Math.sin(t / 110) * 1.0 : sitting ? Math.sin(t / 600 + BOT_ORDER.indexOf(b)) * 1.0 : 0;
    const prop = walking ? (a.phase === "returning" && a.spot?.prop === "mug" ? "mug" : null) : atSpot ? (a.spot!.prop ?? null) : null;
    const sel = selected === b;
    items.push({
      key: a.pos[0] + a.pos[1] + (seated ? 0.05 : 0.01),
      id: `bot-${b}`,
      el: (
        <g className="office-bot" aria-hidden="true" onClick={() => onSelect(b)}>
          {sel && <ellipse cx={gx} cy={gy} rx="30" ry="15" fill="rgba(124,92,255,.16)" stroke="#7c5cff" strokeWidth="2" strokeDasharray="6 5" />}
          {!sitting && <ellipse cx={gx} cy={gy} rx="15" ry="6" fill="rgba(30,27,46,.18)" />}
          <BotFigure
            bot={b}
            mood={mood}
            x={x}
            y={y}
            scale={SCALE}
            pose={sitting ? "sit" : "stand"}
            walk={walking ? a.walk : undefined}
            bob={bob}
            prop={prop}
            facing={facing}
            turn={turn}
            typing={typing}
            swing={swingOf[b] ?? 0}
          />
        </g>
      ),
    });

    // At the desk the label sits above the monitor, so it never covers the screen.
    const top = y - (sitting ? 119 : 131) * SCALE + bob - (seated ? 40 : 0);
    const text =
      v.state === "off" || v.state === "working" || v.state === "attention" || seated ? v.task : a.phase === "returning" ? "Back to my desk" : walking ? "On my way" : (a.spot?.label ?? v.task);
    const tone = v.state === "attention" ? "#d93a32" : v.state === "working" ? "url(#holo)" : v.state === "off" ? "#8c8aa0" : "#2c2843";
    // A walking bot shows just its name: "On my way" adds little and the smaller tag crowds the others less.
    labels.push({ b, x, base: top - 10, y: top - 10, text, tone, compact: walking && v.state !== "attention" });
  }
  items.sort((p, q) => p.key - q.key);
  // Place the front-most labels first, right above their bots; labels further back move up to clear them.
  labels.sort((p, q) => q.base - p.base);
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  for (const l of labels) {
    const nameW = BOTS[l.b].name.length * 6.2 + 30;
    const w = l.compact ? nameW : Math.max(84, trim(l.text, 28).length * 5.6 + 20, nameW);
    const h = l.compact ? 24 : 48;
    for (let guard = 0; guard < 8; guard++) {
      const hit = placed.find((o) => Math.abs(o.x - l.x) < (o.w + w) / 2 + 6 && l.y - h < o.y + 4 && o.y - o.h < l.y + 4);
      if (!hit) break;
      l.y = hit.y - hit.h - 4;
    }
    placed.push({ x: l.x, y: l.y, w, h });
  }
  // Ease each label's lift toward where it should be, so labels glide rather than jump while bots walk past each other.
  const dt = Math.min(0.1, Math.max(0, (t - lastFrame.current) / 1000));
  lastFrame.current = t;
  for (const l of labels) {
    const target = l.base - l.y;
    const cur = labelLift.current[l.b];
    const next = !motion || cur === undefined ? target : cur + (target - cur) * Math.min(1, dt * 9);
    labelLift.current[l.b] = next;
    l.y = l.base - next;
  }

  return (
    <div className="office-wrap" ref={wrapRef}>
      <svg
        viewBox={`${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`}
        className="office-svg"
        role="img"
        aria-label={`The bots' office. ${BOT_ORDER.map((b) => `${BOTS[b].name}: ${views[b].task}`).join(". ")}. Use the bot buttons below to open a bot's panel.`}
      >
        <defs>
          <linearGradient id="holo" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9a82ff" stopOpacity=".95" />
            <stop offset="1" stopColor="#7c5cff" stopOpacity=".8" />
          </linearGradient>
          {/* The wall transform flips the y axis, so the sky gradient runs bottom (pale) to top (blue). */}
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffd9b0" />
            <stop offset="1" stopColor="#7fa7ef" />
          </linearGradient>
        </defs>
        <Floor />
        <Walls t={Math.floor(t / 100) * 100} />
        {items.map((d) => (
          <g key={d.id}>{d.el}</g>
        ))}
        {labels.map(({ b, x, y, base, text, tone, compact }) => {
          const label = trim(text, 28);
          const w = Math.max(84, label.length * 5.6 + 20);
          const nameW = BOTS[b].name.length * 6.2 + 30;
          const sel = selected === b;
          // When a label had to move up to make room, a thin line still ties it to its bot.
          const leader = base - y > 8 && <line x1={x} y1={y + 4} x2={x} y2={base + 2} stroke="#8c8aa0" strokeWidth="1.2" strokeDasharray="3 3" />;
          if (compact)
            return (
              <g key={`label-${b}`} className="office-bot" onClick={() => onSelect(b)} aria-hidden="true">
                {leader}
                <rect x={x - nameW / 2} y={y - 20} width={nameW} height="20" rx="10" fill="#fff" stroke={sel ? "#7c5cff" : "#e1def0"} strokeWidth="1.5" />
                <path d={`M${x - 5} ${y - 0.8} L${x} ${y + 4} L${x + 5} ${y - 0.8}z`} fill="#fff" />
                <circle cx={x - nameW / 2 + 11} cy={y - 10} r="3.5" fill={BOTS[b].color} />
                <text x={x + 5} y={y - 6} textAnchor="middle" className="office-name" style={{ fontSize: 11 }}>
                  {BOTS[b].name}
                </text>
              </g>
            );
          return (
            <g key={`label-${b}`} className="office-bot" onClick={() => onSelect(b)} aria-hidden="true">
              {leader}
              <rect x={x - nameW / 2} y={y - 44} width={nameW} height="19" rx="9.5" fill="#fff" stroke={sel ? "#7c5cff" : "#e1def0"} strokeWidth="1.5" />
              <circle cx={x - nameW / 2 + 11} cy={y - 34.5} r="3.5" fill={BOTS[b].color} />
              <text x={x + 5} y={y - 30.5} textAnchor="middle" className="office-name" style={{ fontSize: 11 }}>
                {BOTS[b].name}
              </text>
              <rect x={x - w / 2} y={y - 21} width={w} height="21" rx="7" fill={tone} />
              <path d={`M${x - 5} ${y} L${x} ${y + 5} L${x + 5} ${y}z`} fill={tone === "url(#holo)" ? "#7c5cff" : tone} />
              <text x={x} y={y - 6.5} textAnchor="middle" className="office-holo" style={{ fontSize: 10.5 }}>
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      <button type="button" className="btn btn-sm btn-secondary office-zoom" onClick={toggleZoom}>
        {zoomed ? "Show the whole office" : "Zoom in on the desks"}
      </button>
    </div>
  );
}
