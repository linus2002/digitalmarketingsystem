import type { Request } from "express";
import { q, type Db, pool } from "./db.js";
import { log, errMsg } from "./logger.js";

export async function audit(
  req: Request | null,
  action: string,
  entity?: string,
  entityId?: string | number | null,
  meta: Record<string, unknown> = {},
  db: Db = pool,
) {
  try {
    await q(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6)",
      [req?.user?.id ?? null, action, entity ?? null, entityId != null ? String(entityId) : null, meta, req?.ip ?? null],
      db,
    );
  } catch (err) {
    // Auditing must never break the request, but we do want to know.
    log.error("Audit write failed", { action, error: errMsg(err) });
  }
}
