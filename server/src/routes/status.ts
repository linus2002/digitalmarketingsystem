import { Router } from "express";
import { env } from "../config/env.js";
import { one } from "../lib/db.js";
import { getBrand, getMetaPage } from "../lib/settings.js";
import { aiStatus } from "../services/ai.js";
import { userCan } from "../middleware/auth.js";
import { errMsg, log } from "../lib/logger.js";

// System status for the app shell (banner, Home setup card) and the "waiting on you" nav badges.
// Every signed-in user may read these; details that only admins can act on are trimmed for others.
export const statusRouter = Router();

statusRouter.get("/", async (req, res) => {
  const isAdmin = req.user!.role === "admin";
  const [ai, page, brand] = await Promise.all([
    aiStatus().catch((err) => {
      log.error("AI status check failed", { error: errMsg(err) });
      return { ready: false, label: "AI", model: "", problem: "The AI status couldn't be checked.", fix: "Check the server log." } as {
        ready: boolean;
        label: string;
        model: string;
        problem?: string;
        fix?: string;
      };
    }),
    getMetaPage().catch(() => ({ pageId: "", token: "", pageName: undefined as string | undefined })),
    getBrand().catch(() => ({ name: env.BUSINESS_NAME })),
  ]);
  res.json({
    ai: {
      ready: ai.ready,
      label: ai.label,
      model: ai.model,
      ...(ai.ready ? {} : { problem: ai.problem, fix: isAdmin ? ai.fix : "Ask your administrator to start the AI." }),
    },
    facebook: { connected: !!(page.pageId && page.token), ...(page.pageName ? { pageName: page.pageName } : {}) },
    publishTestMode: env.PUBLISH_DRY_RUN,
    messengerTestMode: env.MESSENGER_DRY_RUN,
    businessName: brand?.name || env.BUSINESS_NAME,
  });
});

/** Counts of items the requester can act on right now. */
statusRouter.get("/badges", async (req, res) => {
  const u = req.user!;
  let review = 0;
  let leads = 0;

  if (userCan(req, "posts.approve")) {
    // Authors and last editors can't approve their own posts (admins can), so those aren't "waiting on you".
    const r = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM posts WHERE status='in_review' AND ($1 OR (created_by IS DISTINCT FROM $2 AND last_edited_by IS DISTINCT FROM $2))",
      [u.role === "admin", u.id],
    );
    review = r?.n ?? 0;
  }

  if (userCan(req, "leads.review")) {
    const all = userCan(req, "leads.view_all");
    // Same rows as the Leads "Needs review" view (routes/leads.ts filter=review + scopeSql), so the badge matches the list.
    const r = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM leads l
       WHERE (l.needs_review OR EXISTS (SELECT 1 FROM lead_messages m WHERE m.lead_id = l.id AND m.status = 'pending_review'))
         AND l.status <> 'closed' AND l.anonymized_at IS NULL
         -- not before consent, except deletion requests (people who see all inquiries get those), as in scopeSql
         AND (l.status NOT IN ('awaiting_consent','collecting') OR ($1 AND l.category = 'privacy_request'))
         AND ($1 OR l.assigned_to = $2 OR (l.assigned_to IS NULL AND l.consent_given AND NOT l.needs_review))`,
      [all, u.id],
    );
    leads = Number(r?.n ?? 0);
  } else if (userCan(req, "leads.view")) {
    // Agents: their own open inquiries where the customer is waiting on a reply.
    const r = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM leads l
       WHERE l.assigned_to = $1 AND l.status IN ('new','in_progress')
         AND (l.last_outbound_at IS NULL OR (l.last_inbound_at IS NOT NULL AND l.last_inbound_at > l.last_outbound_at))`,
      [u.id],
    );
    leads = r?.n ?? 0;
  }

  // Comments that look like questions and nobody has answered yet (the Comments inbox's first tab).
  let comments = 0;
  if (userCan(req, "leads.view")) {
    const r = await one<{ n: number }>("SELECT count(*)::int AS n FROM social_comments WHERE status='open' AND is_inquiry");
    comments = r?.n ?? 0;
  }

  res.json({ review, leads, comments });
});
