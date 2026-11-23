import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { BUSINESS_TZ_LABEL, fmtBiz, POST_STATUS } from "../lib/format";
import { downloadTemplate, exportDocx, exportPdf, exportPng, exportXlsx, readImportFile, type ExportDoc, type ImportRow } from "../lib/exporters";
import { useToast } from "./Toast";
import { Icon } from "./Icons";
import { Alert, Button, Modal, Tag } from "./ui";
import "../styles/exports.css";

export type ExportFormat = "xlsx" | "pdf" | "docx" | "png";
const FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: "xlsx", label: "Excel (.xlsx)", hint: "Spreadsheet with every column" },
  { value: "pdf", label: "PDF", hint: "Printable table" },
  { value: "docx", label: "Word (.docx)", hint: "Editable document" },
  { value: "png", label: "Image (.png)", hint: "Picture of what's on screen" },
];

/** Posts as rows for any export format. */
export interface ExportablePost {
  title: string;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  campaign_name?: string | null;
  message?: string;
  hashtags?: string[];
  image_url?: string | null;
  video_url?: string | null;
  media_kind?: string | null;
  created_by_name?: string | null;
  fb_post_id?: string | null;
}

export function postsDoc(posts: ExportablePost[], title: string, subtitle: string, filename: string, extra: { title: string; when: string; note: string }[] = []): ExportDoc {
  const columns = [
    { key: "title", label: "Title", width: 26 },
    { key: "status", label: "Status", width: 12 },
    { key: "when", label: `Planned / scheduled (${BUSINESS_TZ_LABEL})`, width: 20 },
    { key: "published", label: "Published", width: 18 },
    { key: "campaign", label: "Campaign", width: 16 },
    { key: "text", label: "Post text", width: 60 },
    { key: "hashtags", label: "Hashtags", width: 22 },
    { key: "media", label: "Media", width: 14 },
    { key: "author", label: "Created by", width: 16 },
    { key: "link", label: "Facebook link", width: 30 },
  ];
  const rows = posts.map((p) => ({
    title: p.title,
    status: POST_STATUS[p.status]?.label ?? p.status,
    when: p.scheduled_at ? fmtBiz(p.scheduled_at) : "",
    published: p.published_at ? fmtBiz(p.published_at) : "",
    campaign: p.campaign_name ?? "",
    text: p.message ?? "",
    hashtags: (p.hashtags ?? []).join(" "),
    media: p.media_kind ? `${p.media_kind === "video" ? "Video" : "Image"} (uploaded)` : p.video_url ? "Video link" : p.image_url ? "Image link" : "",
    author: p.created_by_name ?? "",
    link: p.fb_post_id && !p.fb_post_id.startsWith("dryrun") ? `https://www.facebook.com/${p.fb_post_id}` : "",
  }));
  for (const e of extra) rows.push({ title: e.title, status: "Planned by bots", when: e.when, published: "", campaign: "", text: e.note, hashtags: "", media: "", author: "", link: "" });
  return { title, subtitle, filename, columns, rows };
}

/** "Export ▾" with the four formats. `png` needs the element to photograph. */
export function ExportMenu({ build, pngTarget, disabled }: { build: () => Promise<ExportDoc>; pngTarget?: () => HTMLElement | null; disabled?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function run(f: ExportFormat) {
    setOpen(false);
    setBusy(f);
    try {
      if (f === "png") {
        const el = pngTarget?.();
        if (!el) throw new Error("There's nothing on screen to take a picture of.");
        const doc = await build();
        await exportPng(el, doc.filename);
      } else {
        const doc = await build();
        if (!doc.rows.length) throw new Error("There are no posts to export with the current filter.");
        await (f === "xlsx" ? exportXlsx(doc) : f === "pdf" ? exportPdf(doc) : exportDocx(doc));
      }
      toast.ok("Exported", "Check your Downloads folder.");
    } catch (e) {
      toast.err("Couldn't export", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="xp-wrap" ref={wrap}>
      <Button icon="download" loading={!!busy} disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Export
      </Button>
      {open && (
        <div className="xp-menu" role="menu">
          {FORMATS.filter((f) => f.value !== "png" || pngTarget).map((f) => (
            <button key={f.value} type="button" role="menuitem" className="xp-item" onClick={() => void run(f.value)}>
              <b>{f.label}</b>
              <span>{f.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Import posts from an Excel or CSV file: pick → preview with problems → import as drafts. */
export function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"read" | "import" | null>(null);
  const [result, setResult] = useState<{ created: { row: number; id: number; title: string }[]; errors: { row: number; error: string }[]; warnings: { row: number; warning: string }[] } | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    setResult(null);
    setBusy("read");
    try {
      const r = await readImportFile(file);
      if (!r.length) throw new Error("No posts found in the file.");
      if (r.length > 200) throw new Error(`The file has ${r.length} posts. Import up to 200 at a time.`);
      setRows(r);
      setFileName(file.name);
    } catch (e) {
      setRows(null);
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  }

  const ok = rows?.filter((r) => !r.problems.length) ?? [];
  const bad = rows?.filter((r) => r.problems.length) ?? [];

  async function doImport() {
    setBusy("import");
    setErr(null);
    try {
      const body = { rows: ok.map(({ problems: _p, ...r }) => r) };
      const r = await api<NonNullable<typeof result>>("/posts/import", { body });
      setResult(r);
      if (r.created.length) {
        toast.ok(`Imported ${r.created.length} post${r.created.length === 1 ? "" : "s"} as drafts`);
        onDone();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      wide
      title="Import posts from Excel"
      onClose={onClose}
      actions={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon="plus" loading={busy === "import"} disabled={!ok.length || !!busy} onClick={() => void doImport()}>
              {ok.length ? `Import ${ok.length} post${ok.length === 1 ? "" : "s"} as drafts` : "Import"}
            </Button>
          </>
        )
      }
    >
      <div className="stackv" style={{ gap: 14 }}>
        <p className="muted mt0 mb0">
          Each row becomes a <b>draft</b> post. Nothing is published until it's approved and scheduled. Planned dates are read as {BUSINESS_TZ_LABEL}.
        </p>
        <div className="row">
          <Button icon="download" variant="soft" onClick={() => void downloadTemplate()}>
            Download the template
          </Button>
          <Button icon="plus" loading={busy === "read"} onClick={() => input.current?.click()}>
            {rows ? "Choose another file" : "Choose an Excel or CSV file"}
          </Button>
          <input ref={input} type="file" accept=".xlsx,.csv" hidden onChange={(e) => void pick(e.target.files?.[0])} aria-label="Choose a file to import" />
          {fileName && <span className="meta">{fileName}</span>}
        </div>
        {err && <Alert tone="bad">{err}</Alert>}

        {result ? (
          <div className="stackv" style={{ gap: 10 }}>
            <Alert tone={result.errors.length ? "warn" : "good"} title={`${result.created.length} imported${result.errors.length ? `, ${result.errors.length} not imported` : ""}`}>
              {result.created.length > 0 && (
                <>
                  Find them under <Link to="/posts?status=drafts">Posts → Drafts</Link>.{" "}
                </>
              )}
            </Alert>
            {[...result.errors.map((e) => ({ row: e.row, text: e.error, tone: "bad" as const })), ...result.warnings.map((w) => ({ row: w.row, text: w.warning, tone: "warn" as const }))].map((x, i) => (
              <p key={i} className={`imp-line ${x.tone}`}>
                Row {x.row}: {x.text}
              </p>
            ))}
          </div>
        ) : rows ? (
          <>
            <div className="row" style={{ gap: 8 }}>
              <Tag tone="good" dot>{ok.length} ready</Tag>
              {bad.length > 0 && <Tag tone="bad" dot>{bad.length} with problems (skipped)</Tag>}
            </div>
            <div className="imp-table">
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Title</th>
                    <th>Post text</th>
                    <th>Planned</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 100).map((r) => (
                    <tr key={r.row}>
                      <td className="nowrap">{r.row}</td>
                      <td>{r.title || <span className="muted">(from the text)</span>}</td>
                      <td>
                        <span className="clamp">{r.message}</span>
                      </td>
                      <td className="nowrap">{r.planned_at ? fmtBiz(r.planned_at) : <span className="muted">—</span>}</td>
                      <td>{r.problems.length ? <span className="imp-bad" title={r.problems.join(" ")}><Icon name="alert" size={14} /> {r.problems[0]}</span> : <Icon name="check" size={16} className="imp-ok" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 100 && <p className="note mt0">Showing the first 100 of {rows.length} rows.</p>}
          </>
        ) : (
          <div className="imp-empty">
            <Icon name="doc" size={28} />
            <p className="mb0">Start from the template, or use your own sheet with a <b>Post text</b> column.</p>
            <p className="muted small mt0">Columns it understands: Title, Post text, Hashtags, Planned date, Campaign, Image URL, Video URL, Link.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
