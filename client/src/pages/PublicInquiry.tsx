import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { Alert, Button, Check, SelectField, TextArea, TextField } from "../components/ui";
import "../styles/inquiries.css";

// The public website inquiry form (/inquire). It can also be embedded in your site with an <iframe>,
// or your own site can post the same fields to /api/public/inquiries (see README).

interface ConsentInfo {
  version: string;
  text: string;
  privacyUrl: string;
  business: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Maps zod issues from the server ({ path, message }[]) to field errors. */
function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const details = e instanceof ApiError ? e.details : null;
  if (Array.isArray(details))
    for (const d of details as { path?: (string | number)[]; message?: string }[]) {
      const k = d.path?.[0];
      if (k !== undefined && d.message && !out[String(k)]) out[String(k)] = d.message;
    }
  return out;
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("");

export function PublicInquiryPage() {
  const [consentInfo, setConsentInfo] = useState<ConsentInfo | null>(null);
  const [consentError, setConsentError] = useState(false);
  const [f, setF] = useState({ name: "", email: "", phone: "", contact_preference: "email", medicine_name: "", destination_country: "", message: "", website: "" });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [serverErrs, setServerErrs] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const loadConsent = () =>
    api<ConsentInfo>("/public/consent")
      .then((c) => {
        setConsentInfo(c);
        setConsentError(false);
      })
      .catch(() => setConsentError(true));
  useEffect(() => {
    void loadConsent();
  }, []);

  // Public-facing title: the business's name, never the internal app's name.
  const business = consentInfo?.business?.trim() || "";
  useEffect(() => {
    document.title = business ? `Medicine inquiry · ${business}` : "Medicine inquiry";
  }, [business]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setServerErrs((x) => {
      if (!x[k]) return x;
      const { [k]: _gone, ...rest } = x;
      return rest;
    });
  };
  const byEmail = f.contact_preference === "email";

  function validate() {
    const e: Record<string, string> = {};
    if (!f.medicine_name.trim()) e.medicine_name = "Tell us the medicine";
    if (!f.destination_country.trim()) e.destination_country = "Tell us the country";
    if (byEmail && !EMAIL_RE.test(f.email.trim())) e.email = f.email.trim() ? "That doesn't look like an email address" : "Enter your email address";
    if (!byEmail && f.phone.replace(/\D/g, "").length < 7) e.phone = f.phone.trim() ? "Enter the full number, with the country code" : "Enter your phone number";
    if (!consent) e.consent = "Please tick the box to agree, so we can reply";
    return e;
  }
  const errs = tried ? { ...validate(), ...serverErrs } : serverErrs;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    setErr(null);
    setServerErrs({});
    if (Object.keys(validate()).length) return;
    if (!consentInfo) {
      setErr("The consent wording couldn't be loaded. Please reload the page and try again.");
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ ref: string }>("/public/inquiries", {
        body: {
          name: f.name.trim() || undefined,
          medicine_name: f.medicine_name.trim(),
          destination_country: f.destination_country.trim(),
          contact_preference: f.contact_preference,
          // Only the contact detail for the method they picked is sent.
          email: byEmail ? f.email.trim() : undefined,
          phone: byEmail ? undefined : f.phone.trim(),
          message: f.message.trim() || undefined,
          website: f.website,
          consent,
          consent_version: consentInfo.version,
        },
      });
      setDone(r.ref);
    } catch (e2) {
      const fe = fieldErrors(e2);
      setServerErrs(fe);
      if (!Object.keys(fe).length) setErr((e2 as Error).message);
      // The wording changed since the page loaded: fetch the new text so they can read it and agree again.
      if (e2 instanceof ApiError && e2.status === 409) {
        setConsent(false);
        void loadConsent();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="public-wrap">
      <div className="brand" style={{ border: 0, padding: 0 }}>
        <span className="mark inq-mark" aria-hidden="true">
          {business ? initialsOf(business) : "Rx"}
        </span>
        <div>
          <b>{business || "Medicine inquiry"}</b>
          {business && <span>Medicine inquiry</span>}
        </div>
      </div>
      {done ? (
        <div className="board mt24">
          <Alert tone="good" title={`Thank you. Your reference is ${done}.`}>
            Our team will contact you using the method you chose, usually within one business day.
          </Alert>
        </div>
      ) : (
        <form className="board mt24 stackv" style={{ gap: 16 }} onSubmit={submit} noValidate>
          <div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: "-.02em" }}>Ask about a medicine</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              Tell us which medicine you're looking for and where. We only ask for what we need to reply. Please don't include medical records or diagnoses.
            </p>
          </div>
          {err && <Alert tone="bad">{err}</Alert>}
          {consentError && !consentInfo && <Alert tone="warn">Part of this form didn't load. Please check your connection and reload the page.</Alert>}
          <div className="grid g2">
            <TextField label="Medicine name" value={f.medicine_name} onChange={set("medicine_name")} required placeholder="Brand or generic name" error={errs.medicine_name} />
            <TextField label="Country it's needed in" value={f.destination_country} onChange={set("destination_country")} required error={errs.destination_country} />
          </div>
          <TextField label="Your name" optional value={f.name} onChange={set("name")} autoComplete="name" error={errs.name} />
          <SelectField
            label="How should we contact you?"
            value={f.contact_preference}
            onChange={set("contact_preference")}
            options={[
              { value: "email", label: "Email" },
              { value: "phone", label: "Phone call" },
              { value: "whatsapp", label: "WhatsApp" },
            ]}
          />
          {byEmail ? (
            <TextField label="Email" type="email" value={f.email} onChange={set("email")} required autoComplete="email" error={errs.email} />
          ) : (
            <TextField
              label={f.contact_preference === "whatsapp" ? "WhatsApp number" : "Phone number"}
              type="tel"
              value={f.phone}
              onChange={set("phone")}
              required
              placeholder="+63 917 123 4567"
              autoComplete="tel"
              hint="Include the country code."
              error={errs.phone}
            />
          )}
          <TextArea label="Anything else?" optional value={f.message} onChange={set("message")} rows={3} error={errs.message} />
          {/* Honeypot for bots: hidden from people */}
          <input type="text" name="website" value={f.website} onChange={set("website")} tabIndex={-1} autoComplete="off" style={{ position: "absolute", left: "-9999px" }} aria-hidden="true" />
          <div>
            <Check
              label={
                <span className="small">
                  {consentInfo?.text ?? "I agree that you may keep these details to answer my inquiry."}{" "}
                  {consentInfo?.privacyUrl && (
                    <a href={consentInfo.privacyUrl} target="_blank" rel="noreferrer">
                      Privacy notice
                    </a>
                  )}
                </span>
              }
              checked={consent}
              onChange={setConsent}
            />
            {errs.consent && (
              <p className="small" style={{ color: "var(--bad)", margin: "6px 0 0" }} role="alert">
                {errs.consent}
              </p>
            )}
          </div>
          <Alert tone="info">If this is a medical emergency, contact your local emergency services. We can't give medical advice.</Alert>
          <Button variant="primary" type="submit" loading={busy}>
            Send inquiry
          </Button>
        </form>
      )}
    </div>
  );
}
