import { useRef, type KeyboardEvent, type ReactNode } from "react";

// A Bold button (and Ctrl+B / Cmd+B) for post text. It wraps the selected words in **…**; when the post is published
// they become bold letters Facebook can show (see lib/fbText.ts). Pressing it again on bold words removes the bold.

function toggleBold(el: HTMLTextAreaElement, value: string): { text: string; start: number; end: number } {
  let s = el.selectionStart;
  let e = el.selectionEnd;
  // Already bold (markers just outside the selection, or selected with it): remove them.
  if (value.slice(s - 2, s) === "**" && value.slice(e, e + 2) === "**") {
    return { text: value.slice(0, s - 2) + value.slice(s, e) + value.slice(e + 2), start: s - 2, end: e - 2 };
  }
  const sel = value.slice(s, e);
  if (sel.length >= 4 && sel.startsWith("**") && sel.endsWith("**")) {
    return { text: value.slice(0, s) + sel.slice(2, -2) + value.slice(e), start: s, end: e - 4 };
  }
  if (s === e) {
    // Nothing selected: bold the word under the cursor, or add a placeholder to type over.
    const before = value.slice(0, s).match(/[\p{L}\p{N}'’-]*$/u)![0];
    const after = value.slice(s).match(/^[\p{L}\p{N}'’-]*/u)![0];
    if (before || after) {
      s -= before.length;
      e += after.length;
    } else {
      const ph = "bold text";
      return { text: `${value.slice(0, s)}**${ph}**${value.slice(s)}`, start: s + 2, end: s + 2 + ph.length };
    }
  }
  // Markers can't have spaces just inside them, and bold stays on one line.
  while (s < e && /\s/.test(value[s])) s++;
  while (e > s && /\s/.test(value[e - 1])) e--;
  if (s === e) return { text: value, start: el.selectionStart, end: el.selectionEnd };
  const lines = value.slice(s, e).split("\n");
  const wrapped = lines.map((l) => (l.trim() ? l.replace(/^(\s*)(.*?)(\s*)$/, "$1**$2**$3") : l)).join("\n");
  return { text: value.slice(0, s) + wrapped + value.slice(e), start: s + 2, end: s + wrapped.length - 2 };
}

/** Wraps a TextArea (passed as children) with a Bold button and the Ctrl+B / Cmd+B shortcut. */
export function BoldField({ value, onChange, disabled, children }: { value: string; onChange: (v: string) => void; disabled?: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const apply = (el: HTMLTextAreaElement | null) => {
    if (!el || el.disabled) return;
    const r = toggleBold(el, value);
    if (r.text === value) return;
    onChange(r.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.start, r.end);
    });
  };
  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !(ev.target instanceof HTMLTextAreaElement)) return;
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "b") {
      ev.preventDefault();
      apply(ev.target);
    }
  };
  return (
    <div ref={box} className="fmt-box" onKeyDown={onKeyDown}>
      {children}
      {!disabled && (
        <div className="fmt-bar" role="toolbar" aria-label="Text formatting">
          <button
            type="button"
            className="fmt-btn"
            title="Bold (Ctrl+B)"
            aria-label="Bold"
            onMouseDown={(e) => e.preventDefault()} // keep the selection in the text box
            onClick={() => apply(box.current?.querySelector("textarea") ?? null)}
          >
            B
          </button>
          <span className="fmt-hint">Select words and press B (or Ctrl+B). They show as bold on Facebook.</span>
        </div>
      )}
    </div>
  );
}
