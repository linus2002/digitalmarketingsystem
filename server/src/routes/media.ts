import fs from "node:fs";
import express, { Router } from "express";
import { forbidden, intParam } from "../lib/http.js";
import { userCan } from "../middleware/auth.js";
import { getMedia, mediaPath, saveUpload, VIDEO_MAX } from "../services/media.js";

// Upload: the browser sends the file as the raw request body (Content-Type = the file's type),
// with its name in X-Filename. No multipart parsing library needed.

export const mediaRouter = Router();

mediaRouter.post("/", express.raw({ type: () => true, limit: VIDEO_MAX + 1024 }), async (req, res) => {
  if (!userCan(req, "posts.edit") && !userCan(req, "content.generate")) throw forbidden("You can't add images or videos.");
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let name = "";
  try {
    name = decodeURIComponent(String(req.header("x-filename") ?? ""));
  } catch {
    /* keep empty */
  }
  const media = await saveUpload(buf, name, req.user!.id);
  res.status(201).json({ media });
});

/** Shows an uploaded file to signed-in staff who can see posts (previews in the editor, bots page, calendar). */
mediaRouter.get("/:id", async (req, res) => {
  if (!userCan(req, "posts.view") && !userCan(req, "content.generate")) throw forbidden();
  const row = await getMedia(intParam(req.params.id));
  const file = mediaPath(row);
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat) {
    res.status(410).json({ error: "The uploaded file is missing from this computer." });
    return;
  }
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(file).pipe(res);
});
