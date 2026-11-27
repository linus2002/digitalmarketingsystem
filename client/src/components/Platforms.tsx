import { useId } from "react";
import { api, useLoad } from "../lib/api";
import type { PlatformKey } from "../lib/platformRules";
import "../styles/platforms.css";

// The social platforms a post can go to: names, brand icons, the picker in the post editor and per-platform status.

export type { PlatformKey };
export const PLATFORM_KEYS: PlatformKey[] = ["facebook", "instagram", "twitter", "youtube", "tiktok", "linkedin"];
export const PLATFORM: Record<PlatformKey, { label: string; short: string; needs: string }> = {
  facebook: { label: "Facebook", short: "Facebook", needs: "Text, image, video or link" },
  instagram: { label: "Instagram", short: "Instagram", needs: "Image or video" },
  twitter: { label: "X (Twitter)", short: "X", needs: "Up to 280 characters, image optional" },
  youtube: { label: "YouTube", short: "YouTube", needs: "Video" },
  tiktok: { label: "TikTok", short: "TikTok", needs: "Video" },
  linkedin: { label: "LinkedIn", short: "LinkedIn", needs: "Text, image, video or link" },
};

export interface Target {
  platform: PlatformKey;
  status: "pending" | "publishing" | "published" | "failed";
  url: string | null;
  error: string | null;
  published_at: string | null;
  /** The post may already be live there (no answer, or interrupted): a person checks before it's sent again. */
  uncertain?: boolean;
}

/** Platforms of a post (older posts without any went to Facebook). */
export const platformsOf = (p: { targets?: Target[] | null }): PlatformKey[] => (p.targets?.length ? p.targets.map((t) => t.platform) : ["facebook"]);

/** Small round brand mark. Decorative unless a label is given. */
export function PlatformIcon({ p, size = 16, label }: { p: PlatformKey; size?: number; label?: string }) {
  const gid = `ig-${useId().replace(/:/g, "")}`;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg className="pf-ico" width={size} height={size} viewBox="0 0 24 24" {...a11y}>
      {label && <title>{label}</title>}
      {p === "facebook" && (
        <>
          <circle cx="12" cy="12" r="12" fill="#1877F2" />
          <path fill="#fff" d="M15.4 8.2h-1.7c-.7 0-.9.4-.9 1v1.6h2.5l-.4 2.6h-2.1V20h-2.7v-6.6H8.3v-2.6h1.8V9c0-2.2 1.2-3.4 3.2-3.4.9 0 1.7.1 2.1.1z" />
        </>
      )}
      {p === "instagram" && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#feda75" />
              <stop offset=".35" stopColor="#fa7e1e" />
              <stop offset=".6" stopColor="#d62976" />
              <stop offset="1" stopColor="#4f5bd5" />
            </linearGradient>
          </defs>
          <rect width="24" height="24" rx="7" fill={`url(#${gid})`} />
          <rect x="6" y="6" width="12" height="12" rx="3.6" fill="none" stroke="#fff" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="2.9" fill="none" stroke="#fff" strokeWidth="1.8" />
          <circle cx="15.6" cy="8.4" r=".95" fill="#fff" />
        </>
      )}
      {p === "twitter" && (
        <>
          <circle cx="12" cy="12" r="12" fill="#000" />
          <path fill="#fff" d="M6.8 6.6h3l2.6 3.7 3.1-3.7h1.6l-4 4.7 4.6 6.4h-3l-2.8-4-3.4 4H6.9l4.4-5.2z" />
        </>
      )}
      {p === "youtube" && (
        <>
          <rect y="3.5" width="24" height="17" rx="5" fill="#FF0000" />
          <path fill="#fff" d="M9.8 8.4v7.2l6.2-3.6z" />
        </>
      )}
      {p === "tiktok" && (
        <>
          <rect width="24" height="24" rx="7" fill="#111" />
          <path fill="#25F4EE" d="M13.9 5h2.2c.3 1.6 1.4 2.7 3 2.9v2.3c-1.1 0-2.2-.4-3-1v4.5a4.1 4.1 0 1 1-4.1-4.1h.5v2.3h-.5a1.8 1.8 0 1 0 1.9 1.8z" transform="translate(-.7 -.5)" />
          <path fill="#FE2C55" d="M13.9 5h2.2c.3 1.6 1.4 2.7 3 2.9v2.3c-1.1 0-2.2-.4-3-1v4.5a4.1 4.1 0 1 1-4.1-4.1h.5v2.3h-.5a1.8 1.8 0 1 0 1.9 1.8z" transform="translate(.7 .5)" />
          <path fill="#fff" d="M13.9 5h2.2c.3 1.6 1.4 2.7 3 2.9v2.3c-1.1 0-2.2-.4-3-1v4.5a4.1 4.1 0 1 1-4.1-4.1h.5v2.3h-.5a1.8 1.8 0 1 0 1.9 1.8z" />
        </>
      )}
      {p === "linkedin" && (
        <>
          <rect width="24" height="24" rx="5" fill="#0A66C2" />
          <rect x="5.6" y="9.6" width="2.8" height="8.6" fill="#fff" />
          <circle cx="7" cy="6.8" r="1.6" fill="#fff" />
          <path fill="#fff" d="M10.6 9.6h2.7v1.2c.4-.7 1.4-1.4 2.8-1.4 2.4 0 3 1.5 3 3.6v5.2h-2.8v-4.6c0-1.1-.3-1.8-1.3-1.8-1.1 0-1.6.8-1.6 1.9v4.5h-2.8z" />
        </>
      )}
    </svg>
  );
}

/** Which platforms are connected (and whether Test mode is on). */
export function useConnectedPlatforms() {
  return useLoad(() => api<{ connected: Record<PlatformKey, boolean>; testMode: boolean }>("/platforms/connected"), []);
}

/** Tick the platforms a post goes to. Platforms it's already published on can't be removed. */
export function PlatformPicker({
  value,
  onChange,
  problems,
  locked = [],
  disabled,
}: {
  value: PlatformKey[];
  onChange: (v: PlatformKey[]) => void;
  /** Why the post can't go to a platform as it is. */
  problems: Partial<Record<PlatformKey, string | null>>;
  locked?: PlatformKey[];
  disabled?: boolean;
}) {
  const conn = useConnectedPlatforms();
  const connected = conn.data?.connected;
  const testMode = conn.data?.testMode ?? true;
  const toggle = (p: PlatformKey) => {
    if (locked.includes(p)) return;
    const next = value.includes(p) ? value.filter((x) => x !== p) : [...value, p];
    if (next.length) onChange(PLATFORM_KEYS.filter((k) => next.includes(k)));
  };
  return (
    <fieldset className="pf-pick" disabled={disabled}>
      <legend className="lab">Post to</legend>
      <div className="pf-grid">
        {PLATFORM_KEYS.map((p) => {
          const on = value.includes(p);
          const notConnected = connected ? !connected[p] : false;
          const problem = on ? problems[p] : null;
          return (
            <label key={p} className={`pf-opt ${on ? "on" : ""} ${problem ? "warn" : ""}`} title={PLATFORM[p].needs}>
              <input type="checkbox" checked={on} onChange={() => toggle(p)} disabled={locked.includes(p)} />
              <PlatformIcon p={p} size={22} />
              <span className="pf-name">
                {PLATFORM[p].label}
                <small>{locked.includes(p) ? "Already posted" : notConnected ? (testMode ? "Not connected (fine in Test mode)" : "Not connected") : PLATFORM[p].needs}</small>
              </span>
            </label>
          );
        })}
      </div>
      {value.some((p) => problems[p]) && (
        <ul className="pf-problems" role="alert">
          {value
            .filter((p) => problems[p])
            .map((p) => (
              <li key={p}>
                <PlatformIcon p={p} size={14} /> {problems[p]}
              </li>
            ))}
        </ul>
      )}
      {!testMode && connected && value.some((p) => !connected[p]) && (
        <p className="hint">
          {value
            .filter((p) => !connected[p])
            .map((p) => PLATFORM[p].short)
            .join(", ")}{" "}
          {value.filter((p) => !connected[p]).length === 1 ? "isn't" : "aren't"} connected yet. An admin can connect it in Settings → Social accounts before the post goes out.
        </p>
      )}
    </fieldset>
  );
}

const TARGET_LABEL: Record<Target["status"], string> = { pending: "Waiting", publishing: "Posting…", published: "Posted", failed: "Failed" };

/**
 * Where the post went (or is going), one row per platform. A platform whose post may already be live asks a
 * person to check it first ("Try again" skips it until then), so nothing is posted twice.
 */
export function TargetList({ targets, onCheck, busy }: { targets: Target[]; onCheck?: (p: PlatformKey, action: "posted" | "retry") => void; busy?: boolean }) {
  if (!targets.length) return null;
  return (
    <ul className="pf-targets">
      {targets.map((t) => {
        const check = t.status === "failed" && t.uncertain;
        return (
          <li key={t.platform} className={`pf-t-${t.status} ${check ? "pf-check" : ""}`}>
            <div className="pf-row-main">
              <PlatformIcon p={t.platform} size={20} />
              <span className="grow">
                <b>{PLATFORM[t.platform].label}</b>
                {t.error && t.status !== "published" && <span className="pf-err">{t.error}</span>}
              </span>
              {t.url ? (
                <a href={t.url} target="_blank" rel="noreferrer" className="pf-state">
                  {TARGET_LABEL[t.status]} ↗
                </a>
              ) : (
                <span className="pf-state">{check ? "Check it" : TARGET_LABEL[t.status]}</span>
              )}
            </div>
            {check && (
              <div className="pf-check-box">
                <span>It may have gone out anyway. Look on {PLATFORM[t.platform].short}, then say what you found. Try again skips it until you do.</span>
                {onCheck && (
                  <span className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={() => onCheck(t.platform, "posted")}>
                      It's there
                    </button>
                    <button type="button" className="btn btn-sm btn-quiet" disabled={busy} onClick={() => onCheck(t.platform, "retry")}>
                      It's not there, send again
                    </button>
                  </span>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
