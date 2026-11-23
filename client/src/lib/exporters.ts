// Export a table of posts to Excel, PDF, Word or a PNG picture, and read posts back from Excel/CSV.
// The heavy libraries are loaded only when someone actually exports or imports (dynamic import).
import { fromBizInput } from "./format";

export interface ExportColumn {
  key: string;
  label: string;
  /** Relative width (Excel characters / PDF & Word proportions) */
  width: number;
}
export interface ExportDoc {
  title: string;
  subtitle: string;
  filename: string; // without extension
  columns: ExportColumn[];
  rows: Record<string, string>[];
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "export";

// ---------------------------------------------------------------- Excel

export async function exportXlsx(doc: ExportDoc) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Marketing Hub";
  const ws = wb.addWorksheet(doc.title.slice(0, 31), { views: [{ state: "frozen", ySplit: 3 }] });
  ws.addRow([doc.title]).font = { bold: true, size: 14 };
  ws.addRow([doc.subtitle]).font = { color: { argb: "FF6A6A6A" } };
  const header = ws.addRow(doc.columns.map((c) => c.label));
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F5FD6" } };
    cell.alignment = { vertical: "middle" };
  });
  for (const r of doc.rows) {
    const row = ws.addRow(doc.columns.map((c) => r[c.key] ?? ""));
    row.alignment = { vertical: "top", wrapText: true };
  }
  doc.columns.forEach((c, i) => (ws.getColumn(i + 1).width = c.width));
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: doc.columns.length } };
  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${safeName(doc.filename)}.xlsx`);
}

// ---------------------------------------------------------------- PDF

export async function exportPdf(doc: ExportDoc) {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(16);
  pdf.text(doc.title, 40, 44);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(106);
  pdf.text(doc.subtitle, 40, 62);
  const total = doc.columns.reduce((s, c) => s + c.width, 0);
  const usable = pdf.internal.pageSize.getWidth() - 80;
  autoTable(pdf, {
    startY: 78,
    head: [doc.columns.map((c) => c.label)],
    // Emoji and other symbols the built-in PDF font can't draw are left out of the PDF (they stay in Excel/Word).
    body: doc.rows.map((r) => doc.columns.map((c) => (r[c.key] ?? "").replace(/[^\u0000-ɏ‐-‧]/g, ""))),
    styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak", valign: "top" },
    headStyles: { fillColor: [31, 95, 214], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [247, 248, 250] },
    columnStyles: Object.fromEntries(doc.columns.map((c, i) => [i, { cellWidth: (c.width / total) * usable }])),
    margin: { left: 40, right: 40 },
    didDrawPage: () => {
      pdf.setFontSize(8);
      pdf.setTextColor(150);
      pdf.text(`Page ${pdf.getNumberOfPages()}`, pdf.internal.pageSize.getWidth() - 80, pdf.internal.pageSize.getHeight() - 20);
    },
  });
  download(pdf.output("blob"), `${safeName(doc.filename)}.pdf`);
}

// ---------------------------------------------------------------- Word

export async function exportDocx(doc: ExportDoc) {
  const d = await import("docx");
  const total = doc.columns.reduce((s, c) => s + c.width, 0);
  const cell = (text: string, header = false, pct = 10) =>
    new d.TableCell({
      width: { size: pct, type: d.WidthType.PERCENTAGE },
      shading: header ? { fill: "1F5FD6", type: d.ShadingType.CLEAR, color: "auto" } : undefined,
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: (text || " ").split("\n").map((line) => new d.Paragraph({ children: [new d.TextRun({ text: line, bold: header, color: header ? "FFFFFF" : undefined, size: header ? 18 : 17 })] })),
    });
  const table = new d.Table({
    width: { size: 100, type: d.WidthType.PERCENTAGE },
    rows: [
      new d.TableRow({ tableHeader: true, children: doc.columns.map((c) => cell(c.label, true, (c.width / total) * 100)) }),
      ...doc.rows.map((r) => new d.TableRow({ children: doc.columns.map((c) => cell(r[c.key] ?? "", false, (c.width / total) * 100)) })),
    ],
  });
  const file = new d.Document({
    creator: "Marketing Hub",
    title: doc.title,
    sections: [
      {
        properties: { page: { size: { orientation: d.PageOrientation.LANDSCAPE } } },
        children: [
          new d.Paragraph({ heading: d.HeadingLevel.HEADING_1, children: [new d.TextRun(doc.title)] }),
          new d.Paragraph({ children: [new d.TextRun({ text: doc.subtitle, color: "6A6A6A" })] }),
          new d.Paragraph({ children: [] }),
          table,
        ],
      },
    ],
  });
  download(await d.Packer.toBlob(file), `${safeName(doc.filename)}.docx`);
}

// ---------------------------------------------------------------- PNG

/** A picture of what's on screen (e.g. the calendar or the posts table). */
export async function exportPng(el: HTMLElement, filename: string) {
  const { toBlob } = await import("html-to-image");
  const blob = await toBlob(el, { pixelRatio: 2, backgroundColor: "#ffffff", cacheBust: true });
  if (!blob) throw new Error("Couldn't make the picture.");
  download(blob, `${safeName(filename)}.png`);
}

// ---------------------------------------------------------------- import (Excel / CSV)

export interface ImportRow {
  row: number;
  title?: string;
  message?: string;
  hashtags?: string;
  planned_at?: string | null;
  campaign?: string;
  image_url?: string;
  video_url?: string;
  link_url?: string;
  /** Problems found before sending (shown in the preview) */
  problems: string[];
}

export const TEMPLATE_COLUMNS = ["Title", "Post text", "Hashtags", "Planned date (Philippine time)", "Campaign", "Image URL", "Video URL", "Link"];

const HEADER_KEYS: Record<string, keyof Omit<ImportRow, "row" | "problems">> = {
  title: "title",
  "post text": "message",
  text: "message",
  caption: "message",
  message: "message",
  hashtags: "hashtags",
  "planned date": "planned_at",
  "planned date (philippine time)": "planned_at",
  date: "planned_at",
  "scheduled at": "planned_at",
  campaign: "campaign",
  "image url": "image_url",
  image: "image_url",
  "video url": "video_url",
  video: "video_url",
  link: "link_url",
  "link url": "link_url",
};

/** "2026-12-01 09:30", "2026-12-01", "12/01/2026 9:30 AM" → ISO (Philippine time). Dates only → 09:00. */
export function parsePlanned(v: unknown): { iso: string | null; problem?: string } {
  if (v === null || v === undefined || v === "") return { iso: null };
  if (v instanceof Date) {
    // Excel dates have no time zone: read the written date and time as Philippine time.
    const p = (n: number) => String(n).padStart(2, "0");
    const local = `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}T${p(v.getUTCHours())}:${p(v.getUTCMinutes())}`;
    const iso = fromBizInput(v.getUTCHours() === 0 && v.getUTCMinutes() === 0 ? local.slice(0, 11) + "09:00" : local);
    return iso ? { iso } : { iso: null, problem: "The planned date isn't valid." };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})\s*(am|pm)?)?$/i);
  let y: number, mo: number, d: number, h = 9, mi = 0, ap: string | undefined;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[4]) [h, mi, ap] = [Number(m[4]), Number(m[5]), m[6]];
  } else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(am|pm)?)?$/i);
    if (!m) return { iso: null, problem: `Can't read the planned date "${s}". Use 2026-12-01 09:30.` };
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[4]) [h, mi, ap] = [Number(m[4]), Number(m[5]), m[6]];
  }
  if (ap) h = (h % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = fromBizInput(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}`);
  return iso ? { iso } : { iso: null, problem: `The planned date "${s}" isn't valid.` };
}

function toRows(table: unknown[][]): ImportRow[] {
  const headerIdx = table.findIndex((r) => r.some((c) => String(c ?? "").trim()));
  if (headerIdx < 0) return [];
  const header = table[headerIdx].map((c) => HEADER_KEYS[String(c ?? "").trim().toLowerCase()]);
  if (!header.includes("message")) throw new Error(`The first row must be the column names, including "Post text". Download the template to see the layout.`);
  const out: ImportRow[] = [];
  table.slice(headerIdx + 1).forEach((cells, i) => {
    if (!cells.some((c) => String(c ?? "").trim())) return;
    const r: ImportRow = { row: headerIdx + i + 2, problems: [] };
    header.forEach((key, ci) => {
      if (!key) return;
      const raw = cells[ci];
      if (key === "planned_at") {
        const p = parsePlanned(raw);
        r.planned_at = p.iso;
        if (p.problem) r.problems.push(p.problem);
      } else {
        const text = raw && typeof raw === "object" && "text" in (raw as object) ? String((raw as { text: unknown }).text) : String(raw ?? "");
        (r as unknown as Record<string, string>)[key] = text.trim();
      }
    });
    if (!r.message) r.problems.push("Post text is empty.");
    if (r.image_url && r.video_url) r.problems.push("Use either an image or a video link, not both.");
    out.push(r);
  });
  return out;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

export async function readImportFile(file: File): Promise<ImportRow[]> {
  if (/\.csv$/i.test(file.name)) return toRows(parseCsv((await file.text()).replace(/^﻿/, "")));
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Use an Excel file (.xlsx) or a CSV file.");
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("The Excel file has no sheets.");
  const table: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (r, n) => {
    const vals = (r.values as unknown[]).slice(1);
    table[n - 1] = vals.map((v) => (v && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v));
  });
  return toRows(Array.from(table, (r) => r ?? []));
}

/** A ready-to-fill Excel template with two example rows and short instructions. */
export async function downloadTemplate() {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Posts");
  const head = ws.addRow(TEMPLATE_COLUMNS);
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F5FD6" } };
  });
  ws.addRow(["Cold chain explained", "Some medicines must stay between 2°C and 8°C. Here's how we keep them safe from warehouse to door.", "#GetMeds #ColdChain", "2026-12-01 09:30", "", "", "", ""]);
  ws.addRow(["Caregiver thank-you", "A warm thank-you to every caregiver. Remember to look after yourself too.", "#Caregivers", "2026-12-03", "", "", "", ""]);
  [28, 70, 26, 28, 20, 30, 30, 30].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  const help = wb.addWorksheet("How to fill it in");
  [
    ["One row per post. Only \"Post text\" is required."],
    ["Planned date: 2026-12-01 09:30 (Philippine time). A date without a time becomes 9:00 AM."],
    ["Hashtags: separate with spaces, e.g. #GetMeds #Health"],
    ["Campaign: must match an existing campaign name exactly, or leave it empty."],
    ["Image URL / Video URL: public https links. To use a file from your computer, add it in the post editor after importing."],
    ["Every imported post becomes a draft. Nothing is published until it's approved and scheduled."],
  ].forEach((r) => help.addRow(r));
  help.getColumn(1).width = 110;
  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "posts-import-template.xlsx");
}
