// Original flat illustrations (drawn for this app, no stock artwork). Colours follow the brand tokens.

/** A clipboard with every item ticked off and a check badge: "you're all caught up". */
export function CaughtUpIllustration({ width = 220 }: { width?: number }) {
  const navy = "#1d2b4f";
  return (
    <svg viewBox="0 0 240 200" width={width} style={{ maxWidth: "100%", height: "auto" }} aria-hidden="true" focusable="false">
      {/* ground */}
      <ellipse cx="120" cy="184" rx="92" ry="8" fill="#d9e6fd" />

      {/* sparkles */}
      <g fill="#6c9cf0">
        <circle cx="34" cy="58" r="3" />
        <circle cx="210" cy="26" r="2.5" />
        <circle cx="24" cy="140" r="2.5" />
      </g>
      <path d="M48 24v12M42 30h12" stroke="#f2b01e" strokeWidth="3" strokeLinecap="round" />
      <path d="M214 120v10M209 125h10" stroke="#1f5fd6" strokeWidth="2.5" strokeLinecap="round" />

      {/* clipboard */}
      <rect x="66" y="30" width="104" height="146" rx="12" fill="#1f5fd6" />
      <rect x="76" y="42" width="84" height="124" rx="6" fill="#ffffff" />
      <rect x="96" y="22" width="44" height="18" rx="6" fill={navy} />
      <circle cx="118" cy="26" r="3" fill="#6c9cf0" />

      {/* ticked list */}
      {[64, 92, 120].map((y) => (
        <g key={y}>
          <rect x="86" y={y - 8} width="16" height="16" rx="4" fill="#e4f5ea" />
          <path d={`M89.5 ${y}l3.5 3.5 6-7`} fill="none" stroke="#1e9e57" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="108" y={y - 5} width="42" height="4" rx="2" fill="#c9d8f6" />
          <rect x="108" y={y + 2} width="28" height="4" rx="2" fill="#e2e9f7" />
        </g>
      ))}
      <rect x="86" y="142" width="64" height="4" rx="2" fill="#e2e9f7" />

      {/* check badge */}
      <circle cx="172" cy="140" r="30" fill="#f2b01e" />
      <circle cx="172" cy="140" r="30" fill="none" stroke="#ffffff" strokeOpacity=".4" strokeWidth="5" />
      <path d="M159 140l9 9 18-19" fill="none" stroke="#ffffff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />

      {/* plant */}
      <path d="M44 184v-28" stroke="#1e9e57" strokeWidth="3" strokeLinecap="round" />
      <path d="M44 168c-10-2-14-10-12-18 8 1 13 8 12 18zM44 162c9-3 15-11 13-20-9 2-14 10-13 20z" fill="#1e9e57" />
      <path d="M33 170h22l-3 15H36z" fill={navy} />
    </svg>
  );
}
