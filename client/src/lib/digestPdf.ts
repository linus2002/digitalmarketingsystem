import { download } from "./exporters";

// The weekly digest as a one- or two-page PDF report (A4, portrait).

export interface DigestTotals {
  published: number;
  failed: number;
  reach: number;
  impressions: number;
  engagement: number;
  clicks: number;
  inquiries: number;
}
export interface DigestPost {
  id: number;
  title: string;
  excerpt: string;
  platforms: string[];
  format: string;
  campaign: string | null;
  published: string;
  hasStats: boolean;
  reach: number | null;
  engagement: number | null;
  rate: number | null;
  permalink: string | null;
}
export interface DigestData {
  id: number;
  week_start: string;
  week_end: string;
  written_by: string;
  ai_error: string | null;
  updated_at: string;
  stats: {
    totals: DigestTotals;
    previous: DigestTotals;
    byPlatform: { platform: string; label: string; published: number; failed: number }[];
    byFormat: { format: string; posts: number; avgEngagement: number | null }[];
    posts: DigestPost[];
    best: DigestPost | null;
    worst: DigestPost | null;
    failedPosts: { id: number; title: string; error: string | null }[];
    nextWeek: { scheduled: number; emptyDays: string[] };
    statsNote: string | null;
    /** False when reach/engagement aren't measured yet (unknown, not zero). */
    measured?: boolean;
  };
  summary: { headline: string; worked: string[]; flopped: string[]; bestWhy: string; suggestions: string[] };
}

export const weekLabel = (start: string, end: string) => {
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(new Date(`${d}T00:00:00Z`));
  return `${f(start, { day: "numeric", month: "short" })} – ${f(end, { day: "numeric", month: "short", year: "numeric" })}`;
};
export const change = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%` : a ? "new" : "—");
const n = (v: number | null | undefined) => (v == null ? "—" : new Intl.NumberFormat("en").format(v));
// The built-in PDF font can't draw emoji or most symbols; leave them out.
const plain = (s: string) => s.replace(/[^\u0000-ɏ‐-‧]/g, "").replace(/\s+/g, " ").trim();

export async function digestPdf(d: DigestData, business: string) {
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 44;
  let y = 0;
  const ensure = (h: number) => {
    if (y + h > H - 50) {
      pdf.addPage();
      y = 54;
    }
  };
  const para = (text: string, size = 10.5, color = 40, indent = 0) => {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(size);
    pdf.setTextColor(color);
    const lines = pdf.splitTextToSize(plain(text), W - M * 2 - indent);
    ensure(lines.length * size * 1.35);
    pdf.text(lines, M + indent, y);
    y += lines.length * size * 1.35;
  };
  const heading = (text: string) => {
    ensure(40);
    y += 14;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(13);
    pdf.setTextColor(20);
    pdf.text(text, M, y);
    y += 16;
  };
  const bullets = (items: string[], numbered = false) =>
    items.forEach((t, i) => {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(10.5);
      pdf.setTextColor(31, 95, 214);
      ensure(16);
      pdf.text(numbered ? `${i + 1}.` : "•", M + 2, y);
      para(t, 10.5, 40, 18);
      y += 4;
    });

  // Header band
  pdf.setFillColor(31, 95, 214);
  pdf.rect(0, 0, W, 86, "F");
  pdf.setTextColor(255);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.text(`${plain(business)} · Digital Marketing`, M, 32);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(20);
  pdf.text("Weekly performance digest", M, 56);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10.5);
  pdf.text(weekLabel(d.week_start, d.week_end), M, 74);
  y = 116;

  // Headline
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(13);
  pdf.setTextColor(20);
  const hl = pdf.splitTextToSize(plain(d.summary.headline), W - M * 2);
  pdf.text(hl, M, y);
  y += hl.length * 17 + 8;

  // KPI boxes
  const t = d.stats.totals;
  const p = d.stats.previous;
  const m = d.stats.measured !== false;
  const kpis = [
    ["Posts published", n(t.published), `${change(t.published, p.published)} vs week before`],
    ["People reached", m ? n(t.reach) : "—", m ? `${change(t.reach, p.reach)} vs week before` : "not measured yet"],
    ["Engagement", m ? n(t.engagement) : "—", m ? `${change(t.engagement, p.engagement)} vs week before` : "not measured yet"],
    ["Inquiries", n(t.inquiries), `${change(t.inquiries, p.inquiries)} vs week before`],
  ];
  const gap = 10;
  const bw = (W - M * 2 - gap * 3) / 4;
  kpis.forEach(([label, value, delta], i) => {
    const x = M + i * (bw + gap);
    pdf.setFillColor(237, 243, 254);
    pdf.roundedRect(x, y, bw, 62, 8, 8, "F");
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(90);
    pdf.text(label, x + 10, y + 18);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(17);
    pdf.setTextColor(20);
    pdf.text(value, x + 10, y + 40);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8.5);
    pdf.setTextColor(delta.startsWith("-") ? 184 : 21, delta.startsWith("-") ? 38 : 122, delta.startsWith("-") ? 31 : 67);
    pdf.text(delta, x + 10, y + 54);
  });
  y += 78;

  heading("What worked");
  bullets(d.summary.worked);
  heading("What didn't work");
  bullets(d.summary.flopped);

  if (d.stats.best) {
    heading("Best post of the week");
    const b = d.stats.best;
    para(`"${b.title}"`, 11, 20);
    para(`${b.format} · ${b.published} · reach ${n(b.reach)} · engagement ${n(b.engagement)}${b.rate != null ? ` (${b.rate} per 100 reached)` : ""}`, 9.5, 100);
    y += 4;
    if (d.summary.bestWhy) para(d.summary.bestWhy);
  }

  heading("Three things to do this week");
  bullets(d.summary.suggestions, true);

  if (d.stats.posts.length) {
    heading("All posts last week");
    ensure(60);
    autoTable(pdf, {
      startY: y,
      head: [["Post", "Published", "Format", "Platforms", "Reach", "Engagement"]],
      body: d.stats.posts.map((x) => [plain(x.title), x.published, x.format, x.platforms.join(", "), n(x.reach), n(x.engagement)]),
      styles: { fontSize: 8.5, cellPadding: 4, overflow: "linebreak" },
      headStyles: { fillColor: [31, 95, 214], textColor: 255 },
      alternateRowStyles: { fillColor: [247, 248, 250] },
      columnStyles: { 0: { cellWidth: 180 } },
      margin: { left: M, right: M },
    });
    y = (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  }

  y += 8;
  if (d.stats.statsNote) para(d.stats.statsNote, 8.5, 120);
  para(`Numbers are calculated from the system's records. Written by ${d.written_by === "rules" ? "the system (AI not available)" : d.written_by}.`, 8.5, 120);

  const pages = pdf.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i);
    pdf.setFontSize(8);
    pdf.setTextColor(150);
    pdf.text(`Page ${i} of ${pages}`, W - M - 50, H - 22);
  }
  download(pdf.output("blob"), `weekly-digest-${d.week_start}.pdf`);
}
