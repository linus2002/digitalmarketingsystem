import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { THEMES, useTheme } from "../lib/theme";
import { ago, BUSINESS_TZ_LABEL, fmtBiz, fromBizInput, initials } from "../lib/format";
import { useToast } from "./Toast";
import { Icon, type IconName } from "./Icons";
import { Button, Check, IconButton, Modal, Seg, TextField } from "./ui";
import { BOTS, BotFace, type BotName, type Mood } from "./BotArt";
import "../styles/topbar.css";

// Top navigation bar: notes (personal to-dos), notifications (incl. messages from the AI bots by name) and the user menu.

interface Notification {
  id: number;
  bot: BotName | null;
  kind: string;
  level: "info" | "good" | "warn" | "bad";
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

interface Note {
  id: number;
  text: string;
  done: boolean;
  due_at: string | null;
  done_at: string | null;
  created_at: string;
}

const POLL_MS = 30_000;

/** Closes a popover on outside click or Escape (focus goes back to the button). */
function usePopover(open: boolean, close: () => void, wrap: RefObject<HTMLElement | null>, button: RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, wrap, button]);
}

/** Initials in a solid circle, like the account button in most web apps. */
export function InitialsAvatar({ name, size = 32 }: { name?: string | null; size?: number }) {
  return (
    <span className="ini-av" style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------- notifications

const KIND_ICON: Record<string, IconName> = {
  "post.review": "eye",
  "post.approved": "check",
  "post.changes": "edit",
  "post.published": "globe",
  "post.failed": "alert",
  "lead.assigned": "inbox",
};
const LEVEL_MOOD: Record<Notification["level"], Mood> = { info: "neutral", good: "happy", warn: "alert", bad: "sad" };

function useNotifications() {
  const toast = useToast();
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const lastMax = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Notification[]; unread: number }>("/notifications", { query: { limit: 30 } });
      setItems(r.items);
      setUnread(r.unread);
      setLoaded(true);
      const max = r.items.reduce((m, n) => Math.max(m, n.id), 0);
      // Pop up anything new since the last check (not on the first load).
      if (lastMax.current !== null) {
        r.items
          .filter((n) => n.id > (lastMax.current ?? 0) && !n.read_at)
          .slice(0, 3)
          .reverse()
          .forEach((n) => toast.ok(n.bot ? `${BOTS[n.bot].name}` : n.title, n.bot ? n.body ?? undefined : n.body ?? undefined));
      }
      lastMax.current = Math.max(lastMax.current ?? 0, max);
    } catch {
      /* signed out or offline: try again next time */
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVis = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const markRead = useCallback(async (id: number) => {
    setItems((xs) => xs.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
    await api(`/notifications/${id}/read`, { body: {} }).catch(() => undefined);
  }, []);
  const markAll = useCallback(async () => {
    setItems((xs) => xs.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() })));
    setUnread(0);
    await api("/notifications/read-all", { body: {} }).catch(() => undefined);
  }, []);
  const clearRead = useCallback(async () => {
    setItems((xs) => xs.filter((n) => !n.read_at));
    await api("/notifications/read", { method: "DELETE" }).catch(() => undefined);
  }, []);

  return { items, unread, loaded, load, markRead, markAll, clearRead };
}

function NotificationsMenu() {
  const n = useNotifications();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopover(open, close, wrap, btn);

  const toggle = () => {
    setOpen((o) => !o);
    if (!open) void n.load();
  };
  const go = (item: Notification) => {
    void n.markRead(item.id);
    setOpen(false);
    if (item.link) nav(item.link);
  };

  return (
    <div className="tb-wrap" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="tb-btn"
        aria-label={n.unread ? `Notifications, ${n.unread} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <Icon name="bell" />
        {n.unread > 0 && <span className="tb-badge">{n.unread > 99 ? "99+" : n.unread}</span>}
      </button>
      {open && (
        <div className="tb-pop tb-notif" role="dialog" aria-label="Notifications">
          <div className="tb-pop-head">
            <b>Notifications</b>
            {n.unread > 0 && (
              <button type="button" className="linkish small" onClick={() => void n.markAll()}>
                Mark all as read
              </button>
            )}
          </div>
          {!n.loaded ? (
            <p className="muted tb-empty">Loading…</p>
          ) : !n.items.length ? (
            <div className="tb-empty">
              <BotFace bot="checker" mood="happy" size={56} />
              <p className="mb0">You're all caught up.</p>
              <p className="muted small mt0">The bots and your team will let you know here when something needs you.</p>
            </div>
          ) : (
            <ul className="tb-list">
              {n.items.map((item) => (
                <li key={item.id}>
                  <button type="button" className={`tb-item ${item.read_at ? "" : "unread"} lvl-${item.level}`} onClick={() => go(item)}>
                    {item.bot ? (
                      <BotFace bot={item.bot} mood={LEVEL_MOOD[item.level]} size={36} />
                    ) : (
                      <span className={`tb-ico lvl-${item.level}`}>
                        <Icon name={KIND_ICON[item.kind] ?? "bell"} />
                      </span>
                    )}
                    <span className="grow">
                      <b>{item.bot ? BOTS[item.bot].name : item.title}</b>
                      {item.body && <span className="tb-body">{item.body}</span>}
                      <span className="tb-time">{ago(item.created_at)}</span>
                    </span>
                    {!item.read_at && (
                      <span className="tb-dot">
                        <span className="sr-only">Unread</span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {n.items.some((i) => i.read_at) && (
            <div className="tb-pop-foot">
              <button type="button" className="linkish small" onClick={() => void n.clearRead()}>
                Clear read notifications
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- notes

function useNotes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api<{ notes: Note[] }>("/notes");
      setNotes(r.notes);
      setLoaded(true);
    } catch {
      /* try again when the notes are opened */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { notes, setNotes, loaded, load };
}

function NotesModal({ store, onClose }: { store: ReturnType<typeof useNotes>; onClose: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<"open" | "done">("open");
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const now = Date.now();
  const open = store.notes.filter((n) => !n.done);
  const done = store.notes.filter((n) => n.done);
  const list = view === "open" ? open : done;

  async function add() {
    if (!text.trim()) {
      setError("Write something first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ note: Note }>("/notes", { body: { text: text.trim(), due_at: fromBizInput(due) } });
      store.setNotes((xs) => [r.note, ...xs]);
      setText("");
      setDue("");
      setView("open");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function update(id: number, patch: Partial<Pick<Note, "done" | "text" | "due_at">>) {
    const before = store.notes;
    store.setNotes((xs) => xs.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    try {
      const r = await api<{ note: Note }>(`/notes/${id}`, { method: "PATCH", body: patch });
      store.setNotes((xs) => xs.map((n) => (n.id === id ? r.note : n)));
    } catch (e) {
      store.setNotes(before);
      toast.err("Couldn't update the note", (e as Error).message);
    }
  }
  /** Hides the note at once; it's only deleted after a few seconds, so Undo can bring it back. */
  function remove(id: number) {
    const gone = store.notes.find((n) => n.id === id);
    if (!gone) return;
    const putBack = () => store.setNotes((xs) => (xs.some((n) => n.id === id) ? xs : [...xs, gone].sort((p, q) => p.id - q.id)));
    store.setNotes((xs) => xs.filter((n) => n.id !== id));
    let undone = false;
    toast.undo("Note deleted", () => {
      undone = true;
      putBack();
    });
    window.setTimeout(async () => {
      if (undone) return;
      try {
        await api(`/notes/${id}`, { method: "DELETE" });
      } catch (e) {
        putBack();
        toast.err("Couldn't delete the note", (e as Error).message);
      }
    }, 6000);
  }
  async function clearDone() {
    const before = store.notes;
    store.setNotes((xs) => xs.filter((n) => !n.done));
    try {
      await api("/notes", { method: "DELETE" });
    } catch (e) {
      store.setNotes(before);
      toast.err("Couldn't clear finished notes", (e as Error).message);
    }
  }

  return (
    <Modal title="My notes" onClose={onClose} wide>
      <p className="muted mt0">Your own to-do list: only you can see it.</p>
      <form
        className="notes-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <TextField label="What do you need to do?" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Approve this week's bot posts" error={error} autoFocus />
        <TextField label={`Due (${BUSINESS_TZ_LABEL})`} optional type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        <Button variant="primary" icon="plus" type="submit" loading={busy}>
          Add
        </Button>
      </form>
      <div className="spread mt16">
        <Seg
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: "open", label: "To do", n: open.length },
            { value: "done", label: "Done", n: done.length },
          ]}
        />
        {view === "done" && done.length > 0 && (
          <Button size="sm" variant="quiet" icon="trash" onClick={() => void clearDone()}>
            Clear finished
          </Button>
        )}
      </div>
      {!store.loaded ? (
        <p className="muted">Loading…</p>
      ) : !list.length ? (
        <p className="muted notes-empty">{view === "open" ? "Nothing to do. Add a note above." : "Nothing finished yet."}</p>
      ) : (
        <ul className="notes-list">
          {list.map((n) => {
            const overdue = !n.done && n.due_at && new Date(n.due_at).getTime() < now;
            return (
              <li key={n.id} className={n.done ? "done" : ""}>
                <Check label={<span className="sr-only">{n.done ? "Mark as not done" : "Mark as done"}</span>} checked={n.done} onChange={(v) => void update(n.id, { done: v })} />
                <div className="grow">
                  {editing === n.id ? (
                    <form
                      className="row"
                      style={{ gap: 6 }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (editText.trim()) void update(n.id, { text: editText.trim() });
                        setEditing(null);
                      }}
                    >
                      <input className="input" style={{ height: 36 }} value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Edit note" autoFocus />
                      <Button size="sm" variant="soft" type="submit">
                        Save
                      </Button>
                    </form>
                  ) : (
                    <span className="note-text">{n.text}</span>
                  )}
                  <span className={`note-meta ${overdue ? "overdue" : ""}`}>
                    {n.done ? `Done ${ago(n.done_at)}` : n.due_at ? `${overdue ? "Overdue · " : "Due "}${fmtBiz(n.due_at)}` : `Added ${ago(n.created_at)}`}
                  </span>
                </div>
                {!n.done && editing !== n.id && (
                  <IconButton
                    icon="edit"
                    label="Edit"
                    onClick={() => {
                      setEditing(n.id);
                      setEditText(n.text);
                    }}
                  />
                )}
                <IconButton icon="trash" label="Delete" danger onClick={() => remove(n.id)} />
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

function NotesButton() {
  const store = useNotes();
  const [open, setOpen] = useState(false);
  const openCount = store.notes.filter((n) => !n.done).length;
  const overdue = store.notes.some((n) => !n.done && n.due_at && new Date(n.due_at).getTime() < Date.now());
  return (
    <>
      <button
        type="button"
        className="tb-btn"
        aria-label={openCount ? `My notes, ${openCount} to do` : "My notes"}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
          void store.load();
        }}
      >
        <Icon name="note" />
        {openCount > 0 && <span className={`tb-badge ${overdue ? "" : "soft"}`}>{openCount}</span>}
      </button>
      {open && <NotesModal store={store} onClose={() => setOpen(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- user menu

function UserMenu({ org }: { org: string }) {
  const { user, can, logout } = useAuth();
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopover(open, close, wrap, btn);
  if (!user) return null;
  const item = (to: string, icon: IconName, label: string) => (
    <Link to={to} className="tb-menu-item" onClick={close}>
      <Icon name={icon} />
      {label}
    </Link>
  );
  return (
    <div className="tb-wrap" ref={wrap}>
      <button ref={btn} type="button" className="tb-avatar-btn" aria-label={`Account menu for ${user.name}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <InitialsAvatar name={user.name} />
      </button>
      {open && (
        <div className="tb-pop tb-user" role="dialog" aria-label="Account">
          <div className="tb-user-head">
            <InitialsAvatar name={user.name} size={52} />
            <div className="grow">
              <b>{user.name}</b>
              <span className="muted">{user.email}</span>
              <span className="muted">{org}</span>
            </div>
          </div>
          <div className="tb-role">{user.roleLabel}</div>
          <div className="tb-theme" role="group" aria-labelledby="tb-theme-label">
            <span id="tb-theme-label" className="tb-theme-label">
              Theme
            </span>
            <div className="seg seg-grid tb-theme-seg">
              {THEMES.map((t) => (
                <button key={t.value} type="button" aria-pressed={theme === t.value} onClick={() => setTheme(t.value)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="tb-menu">
            {item("/account", "users", "Your account")}
            {(can("settings.manage") || can("settings.brand")) && item("/settings", "settings", "Settings")}
            <button
              type="button"
              className="tb-menu-item"
              onClick={() => {
                close();
                void logout();
              }}
            >
              <Icon name="logout" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the bar

export function TopBar({ org, start }: { org: string; start?: ReactNode }) {
  const today = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "long", day: "numeric", month: "long" }).format(new Date());
  return (
    <header className="appbar">
      <div className="appbar-start">
        {start}
        <span className="appbar-date">{today}</span>
      </div>
      <div className="appbar-end">
        <NotesButton />
        <NotificationsMenu />
        <span className="appbar-sep" aria-hidden="true" />
        <UserMenu org={org} />
      </div>
    </header>
  );
}
