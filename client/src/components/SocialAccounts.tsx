import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, useLoad } from "../lib/api";
import { ago, fmtDate } from "../lib/format";
import { useToast } from "./Toast";
import { Alert, Button, ConfirmModal, LoadError, SelectField, Skeleton, Tag, TextField } from "./ui";
import { PLATFORM, PlatformIcon, type PlatformKey } from "./Platforms";

// Settings → Social accounts: app keys and sign-in for Instagram, X, YouTube, TikTok and LinkedIn.

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  help?: string;
  options?: { value: string; label: string }[];
  set: boolean;
  value?: string;
}
interface Item {
  id: PlatformKey;
  label: string;
  connected: boolean;
  account: string | null;
  connectedAt: string | null;
  expiresAt: string | null;
  setupHelp: string;
  oauth: boolean;
  signedIn?: boolean;
  redirectUri?: string;
  fields: Field[];
}
interface Summary {
  items: Item[];
  publicMedia: boolean;
  testMode: boolean;
}

export function SocialAccountsTab() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const data = useLoad(() => api<Summary>("/platforms"), []);

  // Back from a platform's sign-in page: say how it went, then tidy the address bar.
  useEffect(() => {
    const p = params.get("social") as PlatformKey | null;
    if (!p) return;
    const err = params.get("error");
    if (err) toast.err(`${PLATFORM[p]?.label ?? p} wasn't connected`, err);
    else if (params.get("ok")) toast.ok(`${PLATFORM[p]?.label ?? p} is connected`);
    setParams({ tab: "social" }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (data.loading && !data.data) return <Skeleton rows={4} />;
  if (data.error || !data.data) return <LoadError error={data.error ?? "Couldn't load"} retry={data.reload} />;
  const { items, publicMedia, testMode } = data.data;

  return (
    <div className="stackv" style={{ gap: 16 }}>
      <div className="board stackv" style={{ gap: 12 }}>
        <h2 className="section">Social accounts</h2>
        <p className="muted mt0">
          Connect the accounts posts can go to. Each platform needs its own developer app and keys, and some need the platform's approval before posts can be public. Pick the platforms
          for each post in the post editor.
        </p>
        {testMode && (
          <Alert tone="info" title="Test mode is on">
            Nothing is sent to any platform yet, so you can try posting to all of them before they're connected.
          </Alert>
        )}
        {!publicMedia && (
          <Alert tone="warn" title="Uploaded files aren't reachable from the internet">
            Instagram downloads images and videos from a public web address. Set PUBLIC_BASE_URL in .env to this system's https address so it can reach uploaded files. Image and video
            links already online work without it.
          </Alert>
        )}
      </div>
      <div className="sa-list">
        {items.map((it) => (
          <AccountCard key={it.id} item={it} reload={data.reload} />
        ))}
      </div>
    </div>
  );
}

function AccountCard({ item, reload }: { item: Item; reload: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setValues(Object.fromEntries(item.fields.map((f) => [f.key, f.secret ? "" : (f.value ?? "")])));
  }, [item]);

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.err("That didn't work", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    act("save", async () => {
      const r = await api<{ account: string | null; error: string | null }>(`/platforms/${item.id}`, { method: "PUT", body: { values } });
      if (r.error) toast.err("Saved, but the check failed", r.error);
      else toast.ok("Saved", r.account ? `Connected as ${r.account}` : item.oauth ? "Now press Connect to sign in." : undefined);
      reload();
    });
  const test = () =>
    act("test", async () => {
      const r = await api<{ account: string | null; error: string | null }>(`/platforms/${item.id}/test`, { body: {} });
      if (r.error) toast.err(`${item.label} didn't answer as expected`, r.error);
      else toast.ok("Connection works", r.account ?? undefined);
      reload();
    });
  const connect = () =>
    act("connect", async () => {
      const r = await api<{ url: string }>(`/platforms/${item.id}/connect`, { body: {} });
      window.location.assign(r.url);
    });
  const findIg = () =>
    act("find", async () => {
      const r = await api<{ account: string }>("/platforms/instagram/find", { body: {} });
      toast.ok("Instagram account found", r.account);
      reload();
    });
  const disconnect = () =>
    act("disconnect", async () => {
      await api(`/platforms/${item.id}`, { method: "DELETE" });
      toast.ok(`${item.label} disconnected`);
      setConfirm(false);
      reload();
    });

  const isFb = item.id === "facebook";
  const expiresSoon = item.expiresAt && new Date(item.expiresAt).getTime() - Date.now() < 7 * 86_400_000;

  return (
    <div className="sa-card">
      <div className="sa-head">
        <PlatformIcon p={item.id} size={32} />
        <div className="grow">
          <b>{item.label}</b>
          <div className="muted">
            {item.connected ? (item.account ? `Connected as ${item.account}` : "Connected") : "Not connected"}
            {item.connected && item.connectedAt ? ` · checked ${ago(item.connectedAt)}` : ""}
            {item.expiresAt ? ` · sign-in lasts until ${fmtDate(item.expiresAt)}` : ""}
          </div>
        </div>
        {item.connected ? <Tag tone={expiresSoon ? "warn" : "good"} dot>{expiresSoon ? "Expires soon" : "Connected"}</Tag> : <Tag tone="mute">Not connected</Tag>}
        {isFb ? (
          <Link className="btn btn-secondary btn-sm" to="/settings?tab=facebook">
            Facebook settings
          </Link>
        ) : (
          <Button size="sm" variant={open ? "quiet" : "secondary"} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? "Close" : item.connected ? "Manage" : "Set up"}
          </Button>
        )}
      </div>
      {open && !isFb && (
        <div className="sa-body">
          <p className="note mt0">{item.setupHelp}</p>
          {item.redirectUri && (
            <div className="sa-redirect">
              Redirect address to add in the developer app: <code>{item.redirectUri}</code>
            </div>
          )}
          <div className="sa-fields">
            {item.fields.map((f) =>
              f.options ? (
                <SelectField
                  key={f.key}
                  label={f.label}
                  optional={f.optional}
                  hint={f.help}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  options={[{ value: "", label: "Default" }, ...f.options]}
                />
              ) : (
                <TextField
                  key={f.key}
                  label={f.label}
                  optional={f.optional}
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  hint={f.secret && f.set ? "Saved. Leave empty to keep it." : f.help}
                  placeholder={f.secret && f.set ? "••••••••" : undefined}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              ),
            )}
          </div>
          <div className="row">
            <Button variant="primary" loading={busy === "save"} onClick={() => void save()}>
              Save
            </Button>
            {item.id === "instagram" && (
              <Button variant="secondary" icon="search" loading={busy === "find"} onClick={() => void findIg()}>
                Find from Facebook Page
              </Button>
            )}
            {item.oauth && (
              <Button variant="secondary" icon="globe" loading={busy === "connect"} onClick={() => void connect()}>
                {item.signedIn ? "Connect again" : "Connect"}
              </Button>
            )}
            {item.connected && (
              <Button variant="quiet" icon="refresh" loading={busy === "test"} onClick={() => void test()}>
                Test connection
              </Button>
            )}
            {(item.connected || item.fields.some((f) => f.set)) && (
              <Button variant="quiet" icon="trash" onClick={() => setConfirm(true)}>
                Disconnect
              </Button>
            )}
          </div>
        </div>
      )}
      {confirm && (
        <ConfirmModal
          title={`Disconnect ${item.label}?`}
          warning="The saved keys and sign-in are removed. Posts set to go there will fail until it's connected again."
          confirmLabel="Disconnect"
          busy={busy === "disconnect"}
          onClose={() => setConfirm(false)}
          onConfirm={() => void disconnect()}
        />
      )}
    </div>
  );
}
