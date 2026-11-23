import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env } from "../config/env.js";
import { encrypt, hmac } from "../lib/crypto.js";
import { one, q, tx } from "../lib/db.js";
import { conflict, parse } from "../lib/http.js";
import { errMsg, log } from "../lib/logger.js";
import { fillTemplate, getConsent } from "../lib/settings.js";
import { addActivity, autoAssign, leadRef, reclassifyLead } from "../services/leads.js";

// Endpoints for the website inquiry form. No sign-in; rate limited; CORS limited to PUBLIC_FORM_ORIGINS.
export const publicRouter = Router();

const formLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many submissions. Please try again later." } });

publicRouter.get("/consent", async (_req, res) => {
  const c = await getConsent();
  res.json({ version: c.version, text: fillTemplate(c.text, { business: env.BUSINESS_NAME }), privacyUrl: env.PRIVACY_POLICY_URL, business: env.BUSINESS_NAME });
});

publicRouter.post("/inquiries", formLimiter, async (req, res) => {
  const b = parse(
    z
      .object({
        name: z.string().trim().max(120).optional(),
        email: z.string().trim().email("Enter a valid email").optional().or(z.literal("")),
        phone: z.string().trim().max(40).optional().or(z.literal("")),
        contact_preference: z.enum(["email", "phone", "whatsapp"]),
        medicine_name: z.string().trim().min(1, "Tell us the medicine").max(120),
        destination_country: z.string().trim().min(1, "Tell us the country").max(80),
        message: z.string().trim().max(2000).optional(),
        consent: z.literal(true, { errorMap: () => ({ message: "Please tick the box to agree, so we can reply" }) }),
        consent_version: z.string().min(1, "Missing consent version").max(40),
        website: z.string().max(0).optional(), // honeypot: must stay empty
      })
      .superRefine((v, ctx) => {
        if (v.contact_preference === "email" && !v.email) ctx.addIssue({ code: "custom", path: ["email"], message: "Enter your email address" });
        if (v.contact_preference !== "email" && !(v.phone && /\d{7,}/.test(v.phone.replace(/\D/g, ""))))
          ctx.addIssue({ code: "custom", path: ["phone"], message: "Enter your phone number with the country code" });
      }),
    req.body,
  );
  const consent = await getConsent();
  // The visitor must have agreed to the wording we use now, not an older version cached in their browser.
  if (b.consent_version !== consent.version) throw conflict("The consent wording has been updated. Please reload the page, read it and tick the box again.");
  // Keep only the contact detail for the method they chose.
  const email = b.contact_preference === "email" ? b.email?.toLowerCase() : undefined;
  const phone = b.contact_preference === "email" ? undefined : b.phone;
  const id = await tx(async (c) => {
    const row = await one(
      `INSERT INTO leads (source, name_enc, email_enc, phone_enc, inquiry_enc, medicine_name, destination_country, contact_preference,
         status, consent_given, consent_at, consent_version, last_inbound_at, follow_up_at)
       VALUES ('website',$1,$2,$3,$4,$5,$6,$7,'new',true,now(),$8, now(), now() + interval '1 day') RETURNING id`,
      [encrypt(b.name), encrypt(email), encrypt(phone), encrypt(b.message), b.medicine_name, b.destination_country, b.contact_preference, consent.version],
      c,
    );
    await q(
      "INSERT INTO consent_records (lead_id, action, consent_version, channel, text_shown, ip_hash) VALUES ($1,'granted',$2,'website',$3,$4)",
      [row!.id, consent.version, fillTemplate(consent.text, { business: env.BUSINESS_NAME }), req.ip ? hmac(req.ip) : null],
      c,
    );
    await addActivity(row!.id, "created", "Submitted through the website form", null, c);
    return row!.id as number;
  });
  // Keyword rules run now, so a sensitive inquiry is flagged for review before anyone can see it unflagged.
  let cls = await reclassifyLead(id, false).catch((err) => {
    log.error("Website inquiry keyword classification failed", { leadId: id, error: errMsg(err) });
    return undefined;
  });
  res.status(201).json({ ref: leadRef(id), message: "Thank you. Our team will contact you using the method you chose." });
  // The local AI may refine the category afterwards (it can be slow), then the inquiry is assigned.
  void (async () => {
    try {
      cls = (await reclassifyLead(id, true)) ?? cls;
    } catch (err) {
      log.error("Website inquiry AI classification failed", { leadId: id, error: errMsg(err) });
    }
    try {
      await autoAssign(id, !!cls?.needsReview);
    } catch (err) {
      log.error("Website inquiry auto-assign failed", { leadId: id, error: errMsg(err) });
    }
  })();
});
