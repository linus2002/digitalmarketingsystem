import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { Alert, Button, Check, SelectField, TextArea, TextField } from "../components/ui";

// The public website inquiry form (/inquire). It can also be embedded in your site with an <iframe>,
// or your own site can post the same fields to /api/public/inquiries (see README).

export function PublicInquiryPage() {
  const [consentInfo, setConsentInfo] = useState<{ version: string; text: string; privacyUrl: string; business: string } | null>(null);
  const [f, setF] = useState({ name: "", email: "", phone: "", contact_preference: "email", medicine_name: "", destination_country: "", message: "", website: "" });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api<{ version: string; text: string; privacyUrl: string; business: string }>("/public/consent").then(setConsentInfo).catch(() => undefined);
  }, []);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ ref: string }>("/public/inquiries", {
        body: { ...f, email: f.email || undefined, phone: f.phone || undefined, message: f.message || undefined, consent, consent_version: consentInfo?.version },
      });
      setDone(r.ref);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="public-wrap">
      <div className="brand" style={{ border: 0, padding: 0 }}>
        <span className="mark">GM</span>
        <div>
          <b>{consentInfo?.business ?? "GetMeds"}</b>
          <span>Medicine inquiry</span>
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
          <div className="grid g2">
            <TextField label="Medicine name" value={f.medicine_name} onChange={set("medicine_name")} required placeholder="Brand or generic name" />
            <TextField label="Country it's needed in" value={f.destination_country} onChange={set("destination_country")} required />
          </div>
          <TextField label="Your name" optional value={f.name} onChange={set("name")} autoComplete="name" />
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
          {f.contact_preference === "email" ? (
            <TextField label="Email" type="email" value={f.email} onChange={set("email")} required autoComplete="email" />
          ) : (
            <TextField label="Phone number" value={f.phone} onChange={set("phone")} required placeholder="+63 917 123 4567" autoComplete="tel" />
          )}
          <TextArea label="Anything else?" optional value={f.message} onChange={set("message")} rows={3} />
          {/* Honeypot for bots: hidden from people */}
          <input type="text" name="website" value={f.website} onChange={set("website")} tabIndex={-1} autoComplete="off" style={{ position: "absolute", left: "-9999px" }} aria-hidden="true" />
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
          <Alert tone="info">If this is a medical emergency, contact your local emergency services. We can't give medical advice.</Alert>
          <Button variant="primary" type="submit" loading={busy} disabled={!consent || !f.medicine_name || !f.destination_country}>
            Send inquiry
          </Button>
        </form>
      )}
    </div>
  );
}
