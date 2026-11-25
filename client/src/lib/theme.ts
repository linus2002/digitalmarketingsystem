import { useEffect, useState } from "react";

// Color theme for the whole app, kept per browser.
// "default": light pages with a near-black sidebar. "light": all light. "dark": all dark.
export type Theme = "default" | "light" | "dark";
export const THEMES: { value: Theme; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const KEY = "theme";
const EVENT = "themechange";

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "default") return v;
  } catch {
    /* storage blocked: fall back to the default */
  }
  return "default";
}

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t === "dark" ? "dark" : "light";
}

/** Call once before the first render so the page doesn't flash the wrong colors. */
export function initTheme() {
  apply(read());
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* still applies for this visit */
  }
  apply(t);
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(read);
  useEffect(() => {
    const on = () => set(read());
    window.addEventListener(EVENT, on);
    window.addEventListener("storage", on); // other tabs
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  useEffect(() => apply(theme), [theme]);
  return [theme, setTheme];
}

/** Sidebar collapsed to an icon rail (wide screens only), kept per browser. */
export function readCollapsed() {
  try {
    return localStorage.getItem("side.collapsed") === "1";
  } catch {
    return false;
  }
}
export function saveCollapsed(v: boolean) {
  try {
    localStorage.setItem("side.collapsed", v ? "1" : "0");
  } catch {
    /* just not remembered */
  }
}
