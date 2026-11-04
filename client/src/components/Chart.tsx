// Small SVG charts in the sheet's palette; no chart library needed.
// CRM palette: blue first, then green, yellow, red
const COLORS = ["#1f5fd6", "#1e9e57", "#f2b01e", "#d93a32"];

export interface Series {
  label: string;
  points: { x: string; y: number }[];
}

export function LineChart({ series, height = 220 }: { series: Series[]; height?: number }) {
  const W = 720;
  const H = height;
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.y)));
  const nice = niceMax(max);
  const x = (i: number) => pad.l + (xs.length <= 1 ? 0 : (i / (xs.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / nice) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * nice);
  const step = Math.max(1, Math.ceil(xs.length / 7));

  if (!xs.length) return <p className="muted small">No data for this period yet.</p>;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.label).join(", ")}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#eeeeec" />
            <text className="axis" x={pad.l - 8} y={y(t) + 3} textAnchor="end">
              {compact(t)}
            </text>
          </g>
        ))}
        {xs.map((d, i) =>
          i % step === 0 ? (
            <text key={d} className="axis" x={x(i)} y={H - 8} textAnchor="middle">
              {d.slice(5).replace("-", "/")}
            </text>
          ) : null,
        )}
        {series.map((s, si) => {
          const map = new Map(s.points.map((p) => [p.x, p.y]));
          const pts = xs.map((d, i) => (map.has(d) ? `${x(i)},${y(map.get(d)!)}` : null)).filter(Boolean);
          const color = COLORS[si % COLORS.length];
          return (
            <g key={s.label}>
              {si === 0 && pts.length > 1 && (
                <polygon points={`${x(0)},${y(0)} ${pts.join(" ")} ${x(xs.length - 1)},${y(0)}`} fill="#edf3fe" opacity="0.8" />
              )}
              <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
      </svg>
      <div className="legend mt8">
        {series.map((s, i) => (
          <span key={s.label}>
            <i style={{ background: COLORS[i % COLORS.length] }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function BarChart({ data, height = 200, label }: { data: { x: string; y: number }[]; height?: number; label: string }) {
  const W = 720;
  const H = height;
  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const nice = niceMax(Math.max(1, ...data.map((d) => d.y)));
  const bw = (W - pad.l - pad.r) / Math.max(1, data.length);
  const y = (v: number) => pad.t + (1 - v / nice) * (H - pad.t - pad.b);
  if (!data.length) return <p className="muted small">No data for this period yet.</p>;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(f * nice)} y2={y(f * nice)} stroke="#eeeeec" />
            <text className="axis" x={pad.l - 8} y={y(f * nice) + 3} textAnchor="end">
              {compact(f * nice)}
            </text>
          </g>
        ))}
        {data.map((d, i) => (
          <g key={d.x}>
            <rect x={pad.l + i * bw + bw * 0.18} width={bw * 0.64} y={y(d.y)} height={Math.max(0, y(0) - y(d.y))} rx="5" fill="#1f5fd6" />
            <text className="axis" x={pad.l + i * bw + bw / 2} y={H - 8} textAnchor="middle">
              {d.x.slice(5).replace("-", "/")}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const compact = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
