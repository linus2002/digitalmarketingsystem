# GetMeds Marketing Hub

Digital marketing automation and a healthcare inquiry assistant, in one app:

- **Marketing intelligence**: the top 5 trending healthcare, pharmaceutical, medicine and oncology topics from permitted sources (RSS, PubMed E-utilities, optional NewsAPI)
- **AI content studio**: captions, campaign ideas, hashtags and image prompts from **Claude** (or a local Ollama model), written to your brand rules
- **Posts and approvals**: draft → review → approved → scheduled → published, with a content calendar
- **Automated publishing** to your Facebook Page at the scheduled time, with retries and a publishing log
- **Facebook analytics**: reach, views, engagement, shares, comments and top posts from the Meta Graph API
- **Campaigns and reports**, with CSV export
- **Inquiry assistant**: answers people who message your Page or use your website form, collects only the medicine, destination country and contact preference, and routes prescription, medical, regulatory and availability questions to the pharmaceutical team

The interface uses the design system from the CRM components sheet (Poppins, ink, sage and mint, pill fields, ink-outlined cards). Tokens and class names match the sheet (`client/src/styles/app.css`).

---

## 1. Project structure

```
digitmarketing/
├─ package.json              npm workspaces: server + client; `npm run dev` starts both
├─ .env.example              every setting, documented; copy to .env
├─ scripts/gen-keys.mjs      prints fresh secrets
├─ server/                   Node.js + Express 5 + TypeScript + PostgreSQL
│  ├─ migrations/001_init.sql  schema (applied automatically on start)
│  └─ src/
│     ├─ index.ts            app, security headers, routes, serves the built client in production
│     ├─ config/env.ts       validated configuration
│     ├─ auth/permissions.ts roles → permissions (RBAC)
│     ├─ middleware/         session auth, permission checks, error handling
│     ├─ lib/                db, AES-256-GCM encryption, settings, audit log, logger
│     ├─ db/                 migrate, seed, default response templates
│     ├─ services/
│     │  ├─ trends.ts        feed readers + topic ranking (+ optional AI summaries)
│     │  ├─ ai.ts            AI entry point: Claude (Anthropic SDK) or Ollama, inquiry-data switch
│     │  ├─ ollama.ts        local AI backend
│     │  ├─ meta.ts          Graph API: publish, insights, Messenger send, webhook signatures
│     │  ├─ publisher.ts     scheduled publishing with exponential-backoff retries
│     │  ├─ analyticsSync.ts pulls post and Page insights
│     │  ├─ guardrails.ts    inquiry classification, review rules, content checks
│     │  ├─ bot.ts           Messenger assistant (template-only conversation)
│     │  ├─ leads.ts         assignment, 24-hour window rules, sending
│     │  ├─ retention.ts     anonymisation and deletion policy
│     │  └─ jobs.ts          background scheduler
│     └─ routes/             auth, users, dashboard, trends, analytics, studio, posts,
│                            campaigns, reports, logs, leads, templates, settings,
│                            public (website form), webhooks (Messenger)
└─ client/                   React 18 + Vite + TypeScript
   └─ src/
      ├─ styles/app.css      design system from the components sheet
      ├─ components/         Button, fields, Tag, KpiCard/Ring, Table parts, Tabs, Steps,
      │                      Modal/ConfirmModal, Toast, Empty, charts, sidebar layout
      ├─ lib/                API client, auth context, formatting
      └─ pages/              Home, Trends, Studio, Posts, PostEditor, Calendar, Campaigns,
                             Analytics, Reports, Logs, Leads, LeadDetail, Templates,
                             Settings, Users, PublicInquiry (/inquire), Login
```

## 2. Install on Windows

You need **Node.js 20.11 or later** (22 LTS recommended), **PostgreSQL 15+** and **Ollama**.

```powershell
winget install OpenJS.NodeJS.LTS
winget install PostgreSQL.PostgreSQL.17
winget install Ollama.Ollama
```

Close and reopen the terminal so the new commands are on your PATH.

### Database

Open **SQL Shell (psql)** from the Start menu (or `psql -U postgres`) and run the following, with your own password:

```sql
CREATE USER dm_app WITH PASSWORD 'choose-a-strong-password';
-- UTF8 matters on Windows: the default (WIN1252) can't store emoji or non-Latin text
CREATE DATABASE digitmarketing OWNER dm_app ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C';
```

### AI: Claude (default)

1. Create an API key at [console.anthropic.com](https://console.anthropic.com) (Settings → API keys) and add billing.
2. In `.env`, set `ANTHROPIC_API_KEY=` to the key. `AI_PROVIDER=anthropic` and `CLAUDE_MODEL=claude-opus-5-5` are the defaults.
3. Restart the app. **Settings → System** shows whether Claude is ready.

Inquiry text is health-related personal data, so by default it is **not** sent to Claude. With Claude, inquiries are sorted by the keyword rules only, and "Suggest a reply" is hidden. Set `AI_FOR_INQUIRIES=true` only after your privacy review covers sending inquiry data to Anthropic, for example under a data processing agreement. Marketing content and trend summaries contain no personal data and always use the configured AI.

If a request is declined by Claude's safety checks, the API automatically retries on a suitable model (server-side fallback). If that also declines, the app says so and asks you to reword.

### Optional: local AI (Ollama) instead

Set `AI_PROVIDER=ollama`. Nothing leaves your computer, so inquiry AI is allowed by default.

```powershell
ollama pull llama3.1:8b      # ~4.7 GB; good balance on a 16 GB laptop
# Alternatives: qwen2.5:7b (strong at JSON), llama3.2:3b (faster on smaller machines)
```

Ollama runs in the background after installation. Set `OLLAMA_MODEL` to whichever model you pulled.

### The app

```powershell
cd C:\Users\Getmeds\Desktop\digitmarketing
npm install
copy .env.example .env
npm run gen:keys            # paste the three lines into .env
notepad .env                # set DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD (12+ chars)
npm run db:setup            # creates tables, settings, trend sources, templates, the admin user
npm run dev                 # API on :4000, app on http://localhost:5173
```

Sign in with the admin account, then **remove `ADMIN_PASSWORD` from `.env`**. Add your team in **Users and roles**.

`PUBLISH_DRY_RUN=true` and `MESSENGER_DRY_RUN=true` are on by default, so you can try every workflow without anything reaching Facebook. Turn them off when you're ready.

## 3. Connect Facebook (Meta)

1. At [developers.facebook.com](https://developers.facebook.com), create an app of type **Business**, linked to your Business Manager. Add the **Facebook Login for Business**, **Pages API** and **Messenger** products.
2. Permissions the app uses (each needs **Advanced Access through App Review** to work for people who aren't app admins or testers):

   | Permission | Used for |
   |---|---|
   | `pages_show_list`, `pages_read_engagement` | Read the Page and its posts |
   | `pages_manage_posts` | Publish scheduled posts |
   | `read_insights` | Reach, views and engagement |
   | `pages_messaging` | Reply to people who message the Page |
   | `human_agent` (optional) | People-written replies up to 7 days after the last message |

3. Generate a **long-lived Page access token** (Graph API Explorer → your app → get a User token with the permissions above → exchange it for a long-lived token → `GET /me/accounts` returns the Page token). Enter the **Page ID** and **Page access token** in **Settings → Facebook connection**. The token is checked against the Graph API, then stored encrypted.
4. Put the app's **App Secret** in `META_APP_SECRET`. It verifies webhook signatures and adds `appsecret_proof` to API calls.
5. **Messenger webhook.** Meta needs a public HTTPS URL. While running locally, use a tunnel:
   ```powershell
   winget install Cloudflare.cloudflared
   cloudflared tunnel --url http://localhost:4000
   ```
   In the Meta app → Messenger → Webhooks, set the callback URL to `https://<tunnel-host>/api/webhooks/meta`, the verify token to your `META_VERIFY_TOKEN`, and subscribe your Page to **`messages`** and **`messaging_postbacks`** only.
6. Set `PUBLISH_DRY_RUN=false` and `MESSENGER_DRY_RUN=false`, then restart.

Meta renames and retires Insights metrics between API versions. Metrics are requested one at a time, so an unavailable metric is skipped (and listed on the Analytics page) without breaking the rest. Adjust `META_PAGE_METRICS` / `META_POST_METRICS` and `META_GRAPH_VERSION` in `.env` when Meta announces changes.

## 4. Website inquiry form

- Hosted form: `http://<your-app>/inquire`. Link to it, or embed it with `<iframe src="https://<your-app>/inquire" style="width:100%;height:900px;border:0"></iframe>`.
- Or post from your own site's form (add your site to `PUBLIC_FORM_ORIGINS`):
  ```js
  fetch("https://<your-app>/api/public/inquiries", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ medicine_name, destination_country, contact_preference: "email", email, name, message, consent: true }),
  });
  ```
  `GET /api/public/consent` returns the current consent wording and version to show beside the checkbox. The endpoint is rate-limited (10 per hour per IP) and has a honeypot field (`website`).

## 5. Roles

| Role | Can |
|---|---|
| Administrator | Everything, including users, settings, audit log and deleting personal data |
| Marketing manager | Approve, schedule and publish posts; campaigns; analytics sync; publishing log |
| Marketer | Trends, AI studio, write posts and send them for review |
| Pharmaceutical team | All inquiries; review sensitive ones; approve replies and templates; export an inquiry's data |
| Inquiry agent | Their own and unassigned inquiries; sensitive replies wait for pharmaceutical approval |
| Viewer | Read-only marketing dashboards and reports |

Authors can't approve their own posts (except administrators). Editing an approved or scheduled post sends it back for approval, so what is published is always what was approved.

## 6. Safety, privacy and Meta policy, by design

- **No outreach.** The app has no bulk messaging, no audience lists and no way to message someone first. Messenger replies only go to people who messaged the Page, within Meta's **24-hour standard messaging window** (or 7 days with the `HUMAN_AGENT` tag, by a person, only if enabled and approved). Outside the window the reply is blocked and the screen says to use the person's preferred contact method.
- **No scraping or profiling.** Trend sources are RSS feeds published for syndication, NCBI E-utilities and NewsAPI with your key. Only headlines and summaries are read. Nothing visits personal pages or profiles, and nothing infers anyone's health condition.
- **Consent first.** The assistant asks for consent before collecting anything. If the person declines, their messages are wiped, and conversations without consent are deleted after `unconsentedDays`. Consent, refusal and withdrawal are recorded with the wording version.
- **Data minimisation.** The assistant only asks for the medicine name, destination country and contact preference (plus the email or phone for that method). It tells people not to send records or prescriptions.
- **Human review.** Keyword rules flag prescription, medical, regulatory and availability questions. The AI, when allowed for inquiries, can add flags but never remove them. Flagged inquiries are assigned to the pharmaceutical team, and replies from other staff wait for their approval.
- **Approved wording only.** The assistant sends nothing but approved templates. Editing a template returns it to draft, and the last approved wording stays in use until it's re-approved. AI reply suggestions are drafts a person must edit and send.
- **STOP / DELETE.** "STOP" opts out immediately. "DELETE" flags a deletion request for the team.
- **Encryption.** Names, emails, phone numbers, inquiry text and every message are AES-256-GCM encrypted at rest (`DATA_ENCRYPTION_KEY`). Contact details are masked on screen until someone presses *Show*, and that is audit-logged.
- **Retention.** A daily job anonymises closed or opted-out inquiries after `leadDays` and prunes old audit and AI logs. Configure it in **Settings → Privacy and retention**. Administrators can export (subject access) or anonymise (erasure) a single inquiry.
- **Security.** bcrypt passwords (12+ characters), account lockout after 5 failed attempts, httpOnly SameSite=Strict session cookie, Helmet headers, rate limits, webhook signature verification, parameterised SQL everywhere, validated input (zod), CSV formula-injection guard, and an audit log of sensitive actions.

Before going live, have your **privacy notice** (`PRIVACY_POLICY_URL`), the consent wording and the response templates reviewed by your compliance or legal team for each country you serve. The Philippine Data Privacy Act (RA 10173) treats health information as sensitive personal information. Also confirm that local rules allow you to promote prescription medicines on social media before naming them in posts.

## 7. How publishing and retries work

Every `SCHEDULER_INTERVAL_SECONDS`, the publisher claims due posts with `FOR UPDATE SKIP LOCKED`, which is safe even with several server instances, and publishes them. Posts with an image URL are published as photo posts. Temporary failures (rate limits, timeouts, Meta "transient" errors) are retried after 1, 2, 4, 8 and 16 minutes, up to `max_attempts` (5). Permission or content errors fail at once. A post left mid-publish by a crash is marked **failed** with a note to check the Page first, rather than risking a duplicate post. Every attempt is recorded in the **Publishing log**.

## 8. Production on a server (later)

```bash
npm ci && npm run build
NODE_ENV=production COOKIE_SECURE=true TRUST_PROXY=true npm start
```

In production, the API serves the built client from the same origin. Put it behind a TLS reverse proxy (Caddy, nginx or IIS ARR), set `HOST=127.0.0.1` so only the proxy can reach it, and run it as a service (`pm2`, `nssm` on Windows, or systemd). Back up PostgreSQL daily (`pg_dump`), and keep `DATA_ENCRYPTION_KEY` in a password manager or vault: without it, encrypted contact details can't be recovered. Ollama can stay on the same machine or on a separate GPU box (`OLLAMA_URL`).

## 9. Implementation plan

**Phase 1: MVP (built)**
Everything above runs locally: sign-in and roles, trends, AI studio, posts, approvals, calendar, scheduling, dry-run publishing, campaigns, reports, website form, the Messenger assistant (dry run), inquiry handling, templates, retention and audit.

**Phase 2: go live with Facebook**
Meta app review for the permissions above, a long-lived Page token, the webhook through a tunnel, then turn off the dry runs. Watch the Publishing log and Analytics for a week.

**Phase 3: hardening and convenience**
- Email notifications (SMTP) for reviews waiting and overdue follow-ups, and replies sent by email from the inquiry screen
- Image upload and storage, in place of public image URLs
- Two-factor sign-in for administrators and the pharmaceutical team
- Automated test suite in CI (the smoke flows below), and database backups

**Phase 4: server deployment**
A Windows Server or Linux VM with HTTPS, a service manager, monitoring and alerts on failed publishes.

**Phase 5: more channels**
Instagram Business publishing (same Graph API pattern) and WhatsApp Business inquiries, under the same consent and review rules.

## 10. What has been verified

A scripted end-to-end run against a real PostgreSQL 17 database, with the API in both development and production mode, passed 84 of 84 checks:

- Sign-in and lockout rules, and role permissions
- The full post workflow: self-approval blocked, approval reset on edit, scheduled publishing by the background job (dry run), publishing logs
- Campaigns, the reports summary and CSV export
- Brand checks, and the error shown when Ollama is down
- The website form: consent required, honeypot
- The webhook handshake and signature check, and a full Messenger conversation: consent → medicine → country → contact → invalid email re-asked → handoff with a reference
- Review flagging and auto-assignment to the pharmaceutical team; agent replies held for approval
- STOP opt-out, contact reveal with an audit entry, export and anonymisation
- Template approval, the retention run and every role's dashboard

A live trend scan read 111 headlines from all 7 enabled sources.

**Not yet tested:**
- Real calls to Facebook. They need your Page token, and app review for live use.
- Generation with an installed Ollama model. Only the "Ollama not running" path was exercised.
- Clicking through the screens in a browser. The client type-checks and builds, and the server serves it.
