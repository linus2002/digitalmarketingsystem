import { Link } from "react-router-dom";
import { useDocTitle } from "../components/ui";
import { Icon, type IconName } from "../components/Icons";
import { BRAND } from "../components/Layout";
import { BOT_ORDER, BOTS, BotFace } from "../components/BotArt";

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: "trend", title: "Trending topics", text: "See what people are searching for and talking about, so every post starts from a topic that matters this week." },
  { icon: "spark", title: "AI studio", text: "Turn notes, photos or a video transcript into captions, hooks and hashtags written in your team's own voice." },
  { icon: "bot", title: "AI bots", text: "Six bots write, learn your style, edit, schedule, check and hand over a whole batch of posts in one go." },
  { icon: "check", title: "Post approvals", text: "Nothing goes out until a marketing manager approves it. Reviewers see exactly what changed and why." },
  { icon: "cal", title: "Post calendar and campaigns", text: "Plan the month on one calendar, group posts into campaigns and avoid two posts landing at the same time." },
  { icon: "send", title: "Publishing everywhere", text: "Approved posts publish on time to Facebook, Instagram, X, YouTube, TikTok and LinkedIn. The publish log shows every attempt and its result." },
  { icon: "inbox", title: "Inquiries", text: "Messages from the Page and the website form arrive in one inbox. Medical questions go to the pharmaceutical team first." },
  { icon: "chart", title: "Analytics and reports", text: "Reach, engagement and follower growth per post and per campaign, ready to share as a report." },
];

const STEPS: { title: string; text: string }[] = [
  { title: "Plan", text: "Pick a trending topic or campaign and set the dates on the calendar." },
  { title: "Create", text: "Add your notes and media. The bots write, edit and schedule every post." },
  { title: "Approve", text: "A marketing manager reviews each post and approves it or sends it back." },
  { title: "Publish and answer", text: "Posts go live on the Page, and every inquiry gets a proper, checked reply." },
];

const TRUST: { icon: IconName; title: string; text: string }[] = [
  { icon: "shield", title: "Consent first", text: "We keep a person's details only after they agree. Opting out is honoured straight away." },
  { icon: "eye-off", title: "Contacts stay hidden", text: "Names and contact details are masked until someone who needs them reveals them, and each reveal is logged." },
  { icon: "clock", title: "Data retention", text: "Old conversations are anonymised or deleted on a schedule you set, and you see the effect before it runs." },
  { icon: "list", title: "Full audit log", text: "Every approval, reveal, change and sign-in is recorded with who did it and when." },
];

export function LandingPage() {
  useDocTitle("");
  return (
    <div className="lp">
      <header className="lp-top">
        <div className="lp-wrap lp-top-in">
          <a href="#top" className="lp-brand">
            <span className="mark">{BRAND.short}</span>
            <span>
              <b>{BRAND.name}</b>
              <small>{BRAND.org}</small>
            </span>
          </a>
          <nav className="lp-nav" aria-label="Page sections">
            <a href="#features">Features</a>
            <a href="#bots">AI bots</a>
            <a href="#how">How it works</a>
            <a href="#privacy">Privacy</a>
          </nav>
          <Link to="/login" className="btn btn-primary">
            Log in
          </Link>
        </div>
      </header>

      <main id="top">
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-in">
            <div className="lp-hero-copy">
              <span className="lp-eyebrow">Marketing system</span>
              <h1>Plan, approve and publish, then answer every inquiry properly.</h1>
              <p>
                Trends, content, the calendar and your social accounts in one place, with AI bots doing the heavy lifting and the pharmaceutical team in the
                loop.
              </p>
              <div className="lp-cta">
                <Link to="/login" className="btn btn-primary">
                  Log in
                </Link>
                <a href="#features" className="btn btn-secondary">
                  See the features
                </a>
              </div>
            </div>
            <HeroMock />
          </div>
        </section>

        <section id="features" className="lp-sec">
          <div className="lp-wrap">
            <SecHead kicker="Features" title="Everything the marketing team needs" text="From the first idea to the last reply, each step has its own place." />
            <div className="lp-grid">
              {FEATURES.map((f) => (
                <article key={f.title} className="lp-card">
                  <span className="lp-ico">
                    <Icon name={f.icon} />
                  </span>
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="bots" className="lp-sec lp-sec-soft">
          <div className="lp-wrap">
            <SecHead kicker="AI bots" title="Six bots, one batch of posts" text="Give them your notes and media. They pass the work along, and a person approves every post before it goes out." />
            <div className="lp-bots">
              {BOT_ORDER.map((b) => (
                <article key={b} className="lp-bot" style={{ ["--bot" as string]: BOTS[b].color }}>
                  <BotFace bot={b} size={64} />
                  <div>
                    <h3>{BOTS[b].name}</h3>
                    <span className="lp-bot-role">{BOTS[b].role}</span>
                    <p>“{BOTS[b].line}”</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how" className="lp-sec">
          <div className="lp-wrap">
            <SecHead kicker="How it works" title="Four steps from idea to inbox" />
            <ol className="lp-steps">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="lp-step-n">{i + 1}</span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="privacy" className="lp-sec lp-sec-soft">
          <div className="lp-wrap">
            <SecHead kicker="Privacy and control" title="Built for health conversations" text="People ask us about medicines. The system treats their details with that in mind." />
            <div className="lp-grid lp-grid-4">
              {TRUST.map((t) => (
                <article key={t.title} className="lp-card">
                  <span className="lp-ico">
                    <Icon name={t.icon} />
                  </span>
                  <h3>{t.title}</h3>
                  <p>{t.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-sec">
          <div className="lp-wrap">
            <div className="lp-band">
              <div>
                <h2>Ready to plan this week's posts?</h2>
                <p>Log in with your work account. If you don't have one yet, ask an administrator.</p>
              </div>
              <Link to="/login" className="btn lp-btn-white">
                Log in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-in">
          <span>
            © {new Date().getFullYear()} {BRAND.name} {BRAND.org}
          </span>
          <Link to="/login">Log in</Link>
        </div>
      </footer>
    </div>
  );
}

function SecHead({ kicker, title, text }: { kicker: string; title: string; text?: string }) {
  return (
    <div className="lp-head">
      <span className="lp-eyebrow">{kicker}</span>
      <h2>{title}</h2>
      {text && <p>{text}</p>}
    </div>
  );
}

/** A small, static picture of the app: this week's posts with their status, and the bots working on the batch. */
function HeroMock() {
  const rows: { day: string; time: string; title: string; status: string; tone: string }[] = [
    { day: "Mon", time: "9:00 AM", title: "Stay hydrated this summer", status: "Published", tone: "good" },
    { day: "Wed", time: "12:30 PM", title: "Know your blood pressure", status: "Approved", tone: "info" },
    { day: "Fri", time: "6:00 PM", title: "Vitamin C myths, explained", status: "In review", tone: "warn" },
  ];
  return (
    <div className="lp-mock" aria-hidden="true">
      <div className="lp-mock-bar">
        <i />
        <i />
        <i />
        <span>This week's posts</span>
      </div>
      <div className="lp-mock-body">
        {rows.map((r) => (
          <div key={r.title} className="lp-mock-row">
            <span className="lp-mock-day">
              <b>{r.day}</b>
              {r.time}
            </span>
            <span className="lp-mock-title">{r.title}</span>
            <span className={`lp-pill ${r.tone}`}>{r.status}</span>
          </div>
        ))}
        <div className="lp-mock-bots">
          <div className="lp-mock-faces">
            {BOT_ORDER.map((b) => (
              <BotFace key={b} bot={b} size={34} />
            ))}
          </div>
          <span>
            <b>Batch of 6 posts</b>
            Editor Bot is revising captions
          </span>
        </div>
        <div className="lp-mock-inq">
          <Icon name="inbox" />
          <span>
            <b>3 new inquiries</b>
            1 waiting for pharmaceutical review
          </span>
        </div>
      </div>
    </div>
  );
}
