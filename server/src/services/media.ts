import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
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

// Instagram feed images: JPG only, width/height between 4:5 (portrait) and 1.91:1 (landscape), at most 1440 px wide.
const IG_MIN_RATIO = 4 / 5;
const IG_MAX_RATIO = 1.91;
const IG_MAX_WIDTH = 1440;

/** Converts an image to what Instagram accepts. Nothing is cut off: an image outside the allowed shape gets white
 *  margins instead. Transparent areas become white, the photo is turned upright, and location/camera data is removed. */
export async function toInstagramJpeg(input: Buffer): Promise<{ data: Buffer; width: number; height: number; padded: boolean }> {
  // First frame only for GIFs; .rotate() with no angle applies the photo's EXIF orientation.
  const upright = await sharp(input, { animated: false }).rotate().png().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = upright.info;
  if (!w || !h) throw new HttpError(422, "This image couldn't be read.");
  const ratio = w / h;
  let padX = 0;
  let padY = 0;
  if (ratio < IG_MIN_RATIO) padX = Math.ceil(h * IG_MIN_RATIO) - w; // too tall: margins left and right
  else if (ratio > IG_MAX_RATIO) padY = Math.ceil(w / IG_MAX_RATIO) - h; // too wide: margins top and bottom
  const white = { r: 255, g: 255, b: 255, alpha: 1 };
  let img = sharp(upright.data).flatten({ background: white });
  if (padX || padY) {
    img = sharp(
      await img
        .extend({ left: Math.floor(padX / 2), right: Math.ceil(padX / 2), top: Math.floor(padY / 2), bottom: Math.ceil(padY / 2), background: white })
        .png()
        .toBuffer(),
    );
  }
  let outW = w + padX;
  let outH = h + padY;
  if (outW > IG_MAX_WIDTH) {
    outH = Math.round((outH * IG_MAX_WIDTH) / outW);
    outW = IG_MAX_WIDTH;
    img = img.resize(outW, outH, { fit: "fill" });
  }
  const data = await img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return { data, width: outW, height: outH, padded: !!(padX || padY) };
}

/**
 * The Instagram-ready copy of an uploaded image (made on first use, then reused). Returns its file name, which the
 * public media address serves while the post is scheduled, being published or published.
 */
export async function instagramImage(mediaId: number): Promise<string> {
  const row = await getMedia(mediaId);
  if (row.kind !== "image") throw new HttpError(400, "Only images are converted for Instagram.");
  if (row.ig_storage_name) {
    const exists = await fs.stat(path.join(UPLOAD_DIR, path.basename(String(row.ig_storage_name)))).catch(() => null);
    if (exists) return String(row.ig_storage_name);
  }
  const { data } = await readMedia(mediaId);
  let out: Buffer;
  try {
    out = (await toInstagramJpeg(data)).data;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, `This image couldn't be converted for Instagram: ${errMsg(err)}`);
  }
  const name = `${randomUUID()}.jpg`;
  await fs.writeFile(path.join(UPLOAD_DIR, name), out);
  // Replace only what we saw (nothing, or a copy whose file went missing). If another publish saved its copy in the
  // meantime, use that one and remove ours.
  const won = await q(
    "UPDATE media SET ig_storage_name=$2 WHERE id=$1 AND ig_storage_name IS NOT DISTINCT FROM $3 RETURNING id",
    [mediaId, name, row.ig_storage_name ?? null],
  );
  if (won.length) return name;
  await fs.rm(path.join(UPLOAD_DIR, name), { force: true });
  const other = await one<{ ig_storage_name: string | null }>("SELECT ig_storage_name FROM media WHERE id=$1", [mediaId]);
  if (!other?.ig_storage_name) throw new HttpError(409, "The image changed while it was being converted. Try again.");
  return other.ig_storage_name;
}

/** Uploads nobody used (no post or bot item points at them) are removed after a day. */
export async function pruneOrphans(): Promise<void> {
  try {
    const rows = await q(
      `DELETE FROM media m WHERE m.created_at < now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.media_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM bot_items i WHERE i.media_id = m.id)
       RETURNING storage_name, ig_storage_name`,
    );
    const files = rows.flatMap((r) => [r.storage_name, r.ig_storage_name]).filter(Boolean);
    await Promise.all(files.map((f) => fs.rm(path.join(UPLOAD_DIR, path.basename(String(f))), { force: true })));
  } catch (err) {
    log.warn("Couldn't clean up unused uploads", { error: errMsg(err) });
  }
}
