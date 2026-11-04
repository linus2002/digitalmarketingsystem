import { useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Link } from "react-router-dom";
import { Icon, type IconName } from "./Icons";
import { initials, type Tone } from "../lib/format";

// ---------------- Buttons ----------------
type BtnVariant = "primary" | "secondary" | "soft" | "quiet" | "danger";

export function Button({
  variant = "secondary",
  size,
  icon,
  loading,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm"; icon?: IconName; loading?: boolean }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${className}`}
      disabled={loading || rest.disabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spin" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function LinkButton({ to, variant = "secondary", size, icon, children }: { to: string; variant?: BtnVariant; size?: "sm"; icon?: IconName; children: ReactNode }) {
  return (
    <Link to={to} className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""}`}>
      {icon && <Icon name={icon} />}
      {children}
    </Link>
  );
}

export function IconButton({ icon, label, danger, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; danger?: boolean }) {
  return (
    <span className="tip">
      <button type="button" className={`btn btn-icon ${danger ? "danger" : ""}`} aria-label={label} {...rest}>
        <Icon name={icon} />
      </button>
      <span className="bubble">{label}</span>
    </span>
  );
}

// ---------------- Fields ----------------
interface FieldProps {
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
}

function FieldShell({ label, optional, hint, error, className = "", children }: FieldProps & { children: ReactNode }) {
  return (
    <label className={`field ${error ? "error" : ""} ${className}`}>
      <span className="lab">
        {label} {optional && <em>(optional)</em>}
      </span>
      {children}
      {(error || hint) && <span className="hint">{error || hint}</span>}
    </label>
  );
}

export function TextField({ label, optional, hint, error, className, ...rest }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  if (rest.type === "password") {
    // Password fields get a show/hide eye button
    return (
      <FieldShell {...{ label, optional, hint, error, className }}>
        <span className="pw-wrap">
          <input className="input" aria-invalid={!!error || undefined} {...rest} type={shown ? "text" : "password"} />
          <button
            type="button"
            className="pw-eye"
            aria-label={shown ? "Hide password" : "Show password"}
            aria-pressed={shown}
            title={shown ? "Hide password" : "Show password"}
            onClick={(e) => {
              e.preventDefault();
              setShown((s) => !s);
            }}
          >
            <Icon name={shown ? "eye-off" : "eye"} />
          </button>
        </span>
      </FieldShell>
    );
  }
  return (
    <FieldShell {...{ label, optional, hint, error, className }}>
      <input className="input" aria-invalid={!!error || undefined} {...rest} />
    </FieldShell>
  );
}

export function TextArea({ label, optional, hint, error, className, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <FieldShell {...{ label, optional, hint, error, className }}>
      <textarea className="textarea" aria-invalid={!!error || undefined} {...rest} />
    </FieldShell>
  );
}

export function SelectField({
  label,
  optional,
  hint,
  error,
  className,
  options,
  ...rest
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string | number; label: string }[] }) {
  return (
    <FieldShell {...{ label, optional, hint, error, className }}>
      <select className="select" {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="with-icon">
      <Icon name="search" />
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </div>
  );
}

export function Check({ label, checked, onChange, type = "checkbox", name }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; type?: "checkbox" | "radio"; name?: string }) {
  return (
    <label className="check">
      <input type={type} name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} /> <span>{label}</span>
    </label>
  );
}

export function Switch({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

export function Seg<T extends string>({
  value,
  onChange,
  options,
  label,
  grid,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; n?: number }[];
  label: string;
  grid?: boolean;
}) {
  return (
    <div className={`seg ${grid ? "seg-grid" : ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.n !== undefined && <span className="n">{o.n}</span>}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string; n?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" type="button" aria-selected={value === t.value} onClick={() => onChange(t.value)}>
          {t.label}
          {t.n !== undefined && <span className="n">{t.n}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------- Tags ----------------
export function Tag({ tone = "mute", dot, children, title }: { tone?: Tone; dot?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`tag tag-${tone}`} title={title}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function StatusTag({ map, value }: { map: Record<string, { label: string; tone: Tone }>; value: string }) {
  const s = map[value] ?? { label: value, tone: "mute" as Tone };
  return (
    <Tag tone={s.tone} dot>
      {s.label}
    </Tag>
  );
}

// ---------------- Cards ----------------
export function Ring({ pct }: { pct: number }) {
  const c = 2 * Math.PI * 17;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <svg className="ring" viewBox="0 0 44 44" role="img" aria-label={`${Math.round(p)}%`}>
      <circle cx="22" cy="22" r="17" fill="none" stroke="#d9e6fd" strokeWidth="5" />
      <circle cx="22" cy="22" r="17" fill="none" stroke="#1f5fd6" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(p / 100) * c} ${c}`} transform="rotate(-90 22 22)" />
      <text x="22" y="25.5" textAnchor="middle" fontSize="10" fontWeight="600" fill="#141414" fontFamily="Poppins">
        {Math.round(p)}%
      </text>
    </svg>
  );
}

export function KpiCard({
  title,
  sub,
  value,
  ring,
  bar,
  behind,
  note,
  tag,
  strong,
  to,
}: {
  title: string;
  sub?: string;
  value: ReactNode;
  ring?: number;
  bar?: number;
  behind?: boolean;
  note?: ReactNode;
  tag?: ReactNode;
  strong?: boolean;
  to?: string;
}) {
  const body = (
    <>
      <div className="kpi">
        <div>
          <h3>{title}</h3>
          {sub && <p>{sub}</p>}
        </div>
        {ring !== undefined && <Ring pct={ring} />}
      </div>
      <div className="big">{value}</div>
      {bar !== undefined && (
        <div className={`bar ${behind ? "behind" : ""}`}>
          <i style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} />
        </div>
      )}
      {tag && <div style={{ marginTop: 10 }}>{tag}</div>}
      {note && <p className="note">{note}</p>}
    </>
  );
  const cls = `card ${strong ? "" : "soft"} ${to ? "clickable" : ""}`;
  return to ? (
    <Link to={to} className={cls} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Overview card with a soft colour wash, frosted icon, big number and label. */
export function GlowCard({
  tone,
  icon,
  value,
  title,
  sub,
  note,
  tag,
  to,
}: {
  tone: "blue" | "green" | "yellow" | "red";
  icon: IconName;
  value: ReactNode;
  title: string;
  sub?: string;
  note?: ReactNode;
  tag?: ReactNode;
  to?: string;
}) {
  const body = (
    <>
      <span className="chip-ico">
        <Icon name={icon} />
      </span>
      <div className="glow-value">{value}</div>
      <div className="glow-title">{title}</div>
      {sub && <div className="glow-sub">{sub}</div>}
      {tag && <div style={{ marginTop: 10 }}>{tag}</div>}
      {note && <p className="note">{note}</p>}
    </>
  );
  return to ? (
    <Link to={to} className={`glow glow-${tone}`}>
      {body}
    </Link>
  ) : (
    <div className={`glow glow-${tone}`}>{body}</div>
  );
}

export function Avatar({ name, white, size }: { name?: string | null; white?: boolean; size?: "sm" | "lg" }) {
  return <span className={`av ${white ? "w" : ""} ${size ?? ""}`}>{initials(name)}</span>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <svg width="120" height="92" viewBox="0 0 120 92" aria-hidden="true">
        <ellipse cx="60" cy="84" rx="44" ry="5" fill="#d9e6fd" />
        <rect x="26" y="18" width="68" height="60" rx="8" fill="#fff" stroke="#1f5fd6" strokeWidth="2" />
        <path d="M26 32h68" stroke="#1f5fd6" strokeWidth="2" />
        <path d="M40 12v12M80 12v12" stroke="#1f5fd6" strokeWidth="2" strokeLinecap="round" />
        <circle cx="60" cy="54" r="11" fill="#1f5fd6" />
        <path d="M60 49v10M55 54h10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <circle cx="38" cy="25" r="2.5" fill="#d93a32" />
        <circle cx="46" cy="25" r="2.5" fill="#f2b01e" />
        <circle cx="54" cy="25" r="2.5" fill="#1e9e57" />
        <path d="M100 30c8 4 10 14 4 20" fill="none" stroke="#6c9cf0" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 5" />
      </svg>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Alert({ tone = "info", title, children, icon }: { tone?: "info" | "warn" | "bad" | "good"; title?: ReactNode; children?: ReactNode; icon?: IconName }) {
  return (
    <div className={`alert ${tone}`} role={tone === "bad" ? "alert" : undefined}>
      <Icon name={icon ?? (tone === "info" ? "info" : tone === "good" ? "check" : "alert")} />
      <div>
        {title && <b>{title}</b>}
        {children}
      </div>
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stackv" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="row" style={{ gap: 10 }}>
          <span className="skel" style={{ width: 36, height: 36, borderRadius: "50%" }} />
          <div style={{ flex: 1, display: "grid", gap: 6 }}>
            <span className="skel" style={{ height: 12, width: `${60 - i * 8}%` }} />
            <span className="skel" style={{ height: 10, width: "35%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function LoadError({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <Alert tone="bad" title="This couldn't be loaded">
      {error}{" "}
      {retry && (
        <button className="btn btn-quiet btn-sm" onClick={retry} style={{ marginLeft: 6 }}>
          Try again
        </button>
      )}
    </Alert>
  );
}

// ---------------- Layout ----------------
export function PageHead({ title, sub, crumbs, actions }: { title: ReactNode; sub?: ReactNode; crumbs?: { to?: string; label: string }[]; actions?: ReactNode }) {
  // Name the browser tab after the page, so several open tabs can be told apart
  useEffect(() => {
    if (typeof title === "string" && title) document.title = `${title} · Digital Marketing`;
  }, [title]);
  return (
    <>
      {crumbs && (
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i} className="row" style={{ gap: 8 }}>
              {i > 0 && <span>›</span>}
              {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
            </span>
          ))}
        </div>
      )}
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {sub && <p>{sub}</p>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
    </>
  );
}

export function Steps({ steps, current, failed, vertical }: { steps: string[]; current: number; failed?: boolean; vertical?: boolean }) {
  return (
    <div className={`steps ${vertical ? "vertical" : ""}`}>
      {steps.map((s, i) => (
        <span key={s} className={`step ${i < current ? "done" : i === current ? (failed ? "fail" : "now") : ""}`}>
          <i>{i < current ? "✓" : failed && i === current ? "!" : i + 1}</i>
          {s}
        </span>
      ))}
    </div>
  );
}

// ---------------- Dialogs ----------------
export function Modal({ title, onClose, children, actions, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <h3 id={id}>{title}</h3>
          <button className="btn btn-icon" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}

/** For actions that can't be undone: the person types a word to confirm (as in the components sheet). */
export function ConfirmModal({
  title,
  warning = "This can't be undone.",
  children,
  confirmWord,
  confirmLabel,
  onConfirm,
  onClose,
  busy,
}: {
  title: string;
  warning?: string;
  children?: ReactNode;
  confirmWord?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const ok = !confirmWord || typed.trim().toLowerCase() === confirmWord;
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!ok} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="warn-line">{warning}</p>
      {children}
      {confirmWord && (
        <TextField
          label={
            <>
              Type <b>{confirmWord}</b> to confirm
            </>
          }
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={confirmWord}
          autoFocus
        />
      )}
    </Modal>
  );
}
