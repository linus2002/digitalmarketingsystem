import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { one, q, type Row } from "../lib/db.js";
import { HttpError, notFound } from "../lib/http.js";
import { errMsg, log } from "../lib/logger.js";

// Uploaded images and videos. Files live on disk in server/uploads/ (not in git); the media table describes them.
// At publish time the file itself is sent to Facebook, so it doesn't need to be on a public website.

export const UPLOAD_DIR = path.resolve(import.meta.dirname, "../../uploads");
export const IMAGE_MAX = 10 * 1024 * 1024; // 10 MB
export const VIDEO_MAX = 100 * 1024 * 1024; // 100 MB

interface Sniffed {
  kind: "image" | "video";
  mime: string;
  ext: string;
}

/** Identifies the file from its first bytes (not from the name or the browser's claim). */
export function sniff(buf: Buffer): Sniffed | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mime: "image/png", ext: "png" };
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return { kind: "image", mime: "image/gif", ext: "gif" };
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("latin1");
    return brand === "qt  " ? { kind: "video", mime: "video/quicktime", ext: "mov" } : { kind: "video", mime: "video/mp4", ext: "mp4" };
  }
  return null;
}

export async function saveUpload(buf: Buffer, originalName: string, userId: number): Promise<Row> {
  const s = sniff(buf);
  if (!s) throw new HttpError(415, "That file type isn't supported. Upload a JPG, PNG or GIF image, or an MP4 or MOV video.");
  if (s.kind === "image" && buf.length > IMAGE_MAX) throw new HttpError(413, "Images can be up to 10 MB. Make it smaller and try again.");
  if (s.kind === "video" && buf.length > VIDEO_MAX) throw new HttpError(413, "Videos can be up to 100 MB. Shorten or compress it and try again.");
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const storage = `${randomUUID()}.${s.ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, storage), buf);
  const name = originalName.replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 200) || `upload.${s.ext}`;
  const row = await one(
    "INSERT INTO media (kind, mime, storage_name, original_name, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind, mime, original_name, size_bytes, created_at",
    [s.kind, s.mime, storage, name, buf.length, userId],
  );
  void pruneOrphans();
  return row!;
}

export async function getMedia(id: number): Promise<Row> {
  const row = await one("SELECT * FROM media WHERE id=$1", [id]);
  if (!row) throw notFound("Image or video");
  return row;
}

export const mediaPath = (row: Row) => path.join(UPLOAD_DIR, path.basename(String(row.storage_name)));

export async function readMedia(id: number): Promise<{ data: Buffer; mime: string; kind: "image" | "video"; name: string }> {
  const row = await getMedia(id);
  const data = await fs.readFile(mediaPath(row)).catch(() => {
    throw new HttpError(410, "The uploaded file is missing from this computer. Upload it again.");
  });
  return { data, mime: row.mime, kind: row.kind, name: row.original_name || row.storage_name };
}

/** Uploads nobody used (no post or bot item points at them) are removed after a day. */
export async function pruneOrphans(): Promise<void> {
  try {
    const rows = await q(
      `DELETE FROM media m WHERE m.created_at < now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.media_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM bot_items i WHERE i.media_id = m.id)
       RETURNING storage_name`,
    );
    await Promise.all(rows.map((r) => fs.rm(path.join(UPLOAD_DIR, path.basename(String(r.storage_name))), { force: true })));
  } catch (err) {
    log.warn("Couldn't clean up unused uploads", { error: errMsg(err) });
  }
}
