import { useEffect, useState } from "react";

// Animated "AI is writing" illustration with step messages and an elapsed timer,
// so a slow local model doesn't look frozen.

const STEPS = ["Reading your brand guidelines", "Thinking about the topic", "Drafting", "Polishing the wording", "Checking for banned words", "Almost there"];

export function Generating({ what }: { what: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // Move through the steps over roughly the first minute, then stay on the last one.
  const step = STEPS[Math.min(STEPS.length - 1, Math.floor(secs / 10))];

  return (
    <div className="board gen" role="status" aria-live="polite">
      <svg className="gen-ill" width="220" height="170" viewBox="0 0 220 170" aria-hidden="true">
        <ellipse className="gen-shadow" cx="110" cy="158" rx="70" ry="6" fill="#d9e6fd" />
        <g className="gen-card">
          <rect x="45" y="18" width="130" height="122" rx="14" fill="#fff" stroke="#1f5fd6" strokeWidth="2" />
          <path d="M45 42h130" stroke="#1f5fd6" strokeWidth="2" />
          <circle cx="60" cy="30" r="3.5" fill="#d93a32" />
          <circle cx="71" cy="30" r="3.5" fill="#f2b01e" />
          <circle cx="82" cy="30" r="3.5" fill="#1e9e57" />
          <rect className="gen-line l1" x="60" y="58" width="100" height="7" rx="3.5" fill="#1f5fd6" />
          <rect className="gen-line l2" x="60" y="76" width="84" height="7" rx="3.5" fill="#6c9cf0" />
          <rect className="gen-line l3" x="60" y="94" width="96" height="7" rx="3.5" fill="#6c9cf0" />
          <rect className="gen-line l4" x="60" y="112" width="58" height="7" rx="3.5" fill="#d9e6fd" />
        </g>
        <g className="gen-pen">
          <path d="M0 0l22-22 6 6-22 22-8 2z" fill="#f2b01e" stroke="#141414" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M22-22l6 6" stroke="#141414" strokeWidth="1.5" />
          <path d="M-2 8l2-8 6 6z" fill="#141414" />
        </g>
        <g className="gen-spark s1" fill="#1e9e57">
          <path d="M0-7 2-2 7 0 2 2 0 7-2 2-7 0-2-2z" />
        </g>
        <g className="gen-spark s2" fill="#d93a32">
          <path d="M0-5 1.4-1.4 5 0 1.4 1.4 0 5-1.4 1.4-5 0-1.4-1.4z" />
        </g>
        <g className="gen-spark s3" fill="#1f5fd6">
          <path d="M0-6 1.7-1.7 6 0 1.7 1.7 0 6-1.7 1.7-6 0-1.7-1.7z" />
        </g>
      </svg>
      <h3 className="gen-title">Writing {what}…</h3>
      <p className="gen-step">
        {step}
        <span className="gen-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </p>
      <p className="note mt0">
        {secs}s · on this computer it usually takes under a minute or two. You can keep working in another tab.
      </p>
    </div>
  );
}
