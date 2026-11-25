import { Router } from "express";
import { one, q } from "../lib/db.js";
import { userCan } from "../middleware/auth.js";

// One call for the home screen; each block is included only if the user may see it.
export const dashboardRouter = Router();

dashboardRouter.get("/", async (req, res) => {
  const out: Record<string, unknown> = {};
  const uid = req.user!.id;

  if (userCan(req, "posts.view")) {
    out.posts = await one(
      `SELECT count(*) FILTER (WHERE status='scheduled' AND scheduled_at < now() + interval '7 days')::int AS scheduled_week,
              count(*) FILTER (WHERE status='published' AND published_at >= date_trunc('month', now()))::int AS published_month,
              count(*) FILTER (WHERE status='in_review')::int AS in_review,
              count(*) FILTER (WHERE status='failed')::int AS failed,
              count(*) FILTER (WHERE status IN ('draft','changes_requested') AND created_by=$1)::int AS my_drafts
       FROM posts`,
      [uid],
    );
    out.upcoming = await q(
      "SELECT id, title, scheduled_at, status FROM posts WHERE status='scheduled' AND scheduled_at >= now() - interval '1 hour' ORDER BY scheduled_at LIMIT 5",
    );
    out.attentionPosts = await q(
      `SELECT id, title, status, last_error, updated_at FROM posts
       WHERE status='failed' OR (status='in_review' AND $1 AND ($3 OR (created_by IS DISTINCT FROM $2 AND last_edited_by IS DISTINCT FROM $2))) OR (status='changes_requested' AND created_by=$2)
       ORDER BY updated_at DESC LIMIT 6`,
      // Authors can't approve their own posts (admins can), so those aren't "waiting on your approval".
      [userCan(req, "posts.approve"), uid, req.user!.role === "admin"],
    );
  }
  if (userCan(req, "analytics.view")) {
    out.engagement = await one(
      `SELECT COALESCE(sum(reach),0)::int AS reach, COALESCE(sum(reactions + comments + shares),0)::int AS engagement, count(*)::int AS posts
       FROM fb_page_posts WHERE created_time >= now() - interval '28 days'`,
    );
  }
  if (userCan(req, "trends.view")) {
    const t = await one("SELECT topics, created_at FROM trend_snapshots ORDER BY created_at DESC LIMIT 1");
    out.trends = t ? { at: t.created_at, topics: (t.topics as unknown[]).slice(0, 5) } : null;
  }
  if (userCan(req, "leads.view")) {
    const all = userCan(req, "leads.view_all");
    // An agent's scope: inquiries assigned to them, plus unassigned ones they could claim
    // (consented, and not waiting on pharmaceutical review). Counts and the attention list use the same scope.
    const scope = `($1 OR assigned_to=$2 OR (assigned_to IS NULL AND consent_given AND NOT needs_review))`;
    out.leads = await one(
      `SELECT count(*) FILTER (WHERE status IN ('new','in_progress','waiting_customer'))::int AS open,
              count(*) FILTER (WHERE needs_review AND status NOT IN ('closed','opted_out') AND anonymized_at IS NULL
                                 -- same rule as the Inquiries list: not before consent, except deletion requests
                                 AND (status NOT IN ('awaiting_consent','collecting') OR ($1 AND category='privacy_request')))::int AS needs_review,
              count(*) FILTER (WHERE follow_up_at < now() AND status IN ('new','in_progress','waiting_customer'))::int AS overdue,
              count(*) FILTER (WHERE status='new')::int AS new
       FROM leads WHERE ${scope}`,
      [all, uid],
    );
    out.attentionLeads = await q(
      `SELECT id, medicine_name, destination_country, category, needs_review, follow_up_at, status FROM leads
       WHERE ${scope} AND status IN ('new','in_progress','waiting_customer')
         AND (needs_review OR follow_up_at < now() + interval '4 hours')
       ORDER BY needs_review DESC, follow_up_at NULLS LAST LIMIT 6`,
      [all, uid],
    );
  }
  res.json(out);
});
