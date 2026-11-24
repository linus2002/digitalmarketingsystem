import { q } from "../lib/db.js";
import { errMsg, log } from "../lib/logger.js";
import { can, type Permission, type Role } from "../auth/permissions.js";

// In-app notifications. The AI bots notify under their own names (the client shows each bot's face).
// Sending a notification never throws: a failed notification must not break the action that caused it.

export const BOT_NAMES = {
  caption: "Caption Bot",
  style: "Style Bot",
  scheduler: "Scheduler Bot",
  checker: "Checker Bot",
  posting: "Posting Bot",
  editor: "Editor Bot",
} as const;
export type NotifyBot = keyof typeof BOT_NAMES;

export interface Notice {
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  level?: "info" | "good" | "warn" | "bad";
  bot?: NotifyBot | null;
}

export async function notify(userIds: (number | null | undefined)[], n: Notice): Promise<void> {
  const ids = [...new Set(userIds.filter((u): u is number => typeof u === "number" && u > 0))];
  if (!ids.length) return;
  try {
    await q(
      `INSERT INTO notifications (user_id, bot, kind, level, title, body, link)
       SELECT u, $2, $3, $4, $5, $6, $7 FROM unnest($1::int[]) AS u`,
      [ids, n.bot ?? null, n.kind, n.level ?? "info", n.title.slice(0, 200), n.body ? n.body.slice(0, 500) : null, n.link ?? null],
    );
  } catch (err) {
    log.warn("Couldn't save notification", { kind: n.kind, error: errMsg(err) });
  }
}

/** Active users whose role has the permission, minus the ones listed. */
export async function usersWithPerm(perm: Permission, exclude: (number | null | undefined)[] = []): Promise<number[]> {
  try {
    const rows = await q<{ id: number; role: Role }>("SELECT id, role FROM users WHERE is_active");
    return rows.filter((r) => can(r.role, perm) && !exclude.includes(r.id)).map((r) => r.id);
  } catch (err) {
    log.warn("Couldn't list users to notify", { perm, error: errMsg(err) });
    return [];
  }
}

/** Keeps the table small: read notifications go after 60 days, unread after 180. */
export async function pruneNotifications(): Promise<void> {
  await q("DELETE FROM notifications WHERE (read_at IS NOT NULL AND created_at < now() - interval '60 days') OR created_at < now() - interval '180 days'").catch(() => undefined);
}
