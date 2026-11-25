import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

interface ToastItem {
  id: number;
  title: string;
  detail?: string;
  bad?: boolean;
  /** A button in the toast, e.g. Undo. Pressing it closes the toast. */
  action?: { label: string; onClick: () => void };
  /** How long it stays, in ms. */
  ms?: number;
}

const Ctx = createContext<(t: Omit<ToastItem, "id">) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.ms ?? (t.bad ? 8000 : 4500));
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="toast">
            <span className={`tick ${t.bad ? "bad" : ""}`}>
              <Icon name={t.bad ? "alert" : "check"} size={14} />
            </span>
            <div className="t">
              {t.title}
              {t.detail && <span>{t.detail}</span>}
            </div>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action!.onClick();
                  setItems((xs) => xs.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
            <button aria-label="Dismiss" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** Stable across renders, so pages can list `toast` in effect dependencies. */
export function useToast() {
  const push = useContext(Ctx);
  return useMemo(
    () => ({
      ok: (title: string, detail?: string) => push({ title, detail }),
      err: (title: string, detail?: string) => push({ title, detail, bad: true }),
      /** A message with an Undo button, shown for `ms` (default 6 seconds). */
      undo: (title: string, onUndo: () => void, ms = 6000) => push({ title, action: { label: "Undo", onClick: onUndo }, ms }),
    }),
    [push],
  );
}
