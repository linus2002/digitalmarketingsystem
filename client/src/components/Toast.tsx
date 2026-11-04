import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

interface ToastItem {
  id: number;
  title: string;
  detail?: string;
  bad?: boolean;
}

const Ctx = createContext<(t: Omit<ToastItem, "id">) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.bad ? 8000 : 4500);
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
            <button aria-label="Dismiss" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const push = useContext(Ctx);
  return {
    ok: (title: string, detail?: string) => push({ title, detail }),
    err: (title: string, detail?: string) => push({ title, detail, bad: true }),
  };
}
