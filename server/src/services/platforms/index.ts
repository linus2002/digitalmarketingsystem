import { env } from "../../config/env.js";
import { getCreds, getDefaultPlatforms, getStored, PLATFORM_IDS, publicMediaUrl, redirectUri, type Connector, type PlatformId } from "./core.js";
import { platformProblem, type RuleInput } from "../../lib/platformRules.js";
import { facebook, instagram } from "./meta.js";
import { linkedin } from "./linkedin.js";
import { tiktok } from "./tiktok.js";
import { twitter } from "./twitter.js";
import { youtube } from "./youtube.js";

export * from "./core.js";
export { findInstagramAccount } from "./meta.js";

export const CONNECTORS: Record<PlatformId, Connector> = { facebook, instagram, twitter, youtube, tiktok, linkedin };

export const isPlatform = (v: unknown): v is PlatformId => typeof v === "string" && (PLATFORM_IDS as readonly string[]).includes(v);

/**
 * The default platforms that fit a post made without a person picking them (bot batches, spreadsheet imports):
 * platforms the post can't go to as it is (e.g. YouTube without a video) are left out, and with `connectedOnly`
 * (posts that go straight to the schedule) so are platforms that aren't connected while Test mode is off.
 * Never empty: Facebook if nothing fits.
 */
export async function defaultPlatformsFor(post: RuleInput, opts: { connectedOnly?: boolean } = {}): Promise<PlatformId[]> {
  return platformsThatFit(await getDefaultPlatforms(), post, opts);
}

/** Same rules for a chosen list (a bot batch's platforms). */
export async function platformsThatFit(list: PlatformId[], post: RuleInput, opts: { connectedOnly?: boolean } = {}): Promise<PlatformId[]> {
  const connected = opts.connectedOnly && !env.PUBLISH_DRY_RUN ? await connectedPlatforms() : null;
  const fit = list.filter((p) => !platformProblem(p, post) && (!connected || connected[p]));
  return fit.length ? fit : ["facebook"];
}

/** A batch's platforms: the ones chosen for it, or the defaults when none were chosen. */
export async function batchPlatforms(batch: { platforms?: unknown }): Promise<{ platforms: PlatformId[]; usesDefaults: boolean }> {
  const chosen = Array.isArray(batch.platforms) ? PLATFORM_IDS.filter((p) => (batch.platforms as string[]).includes(p)) : [];
  return chosen.length ? { platforms: chosen, usesDefaults: false } : { platforms: await getDefaultPlatforms(), usesDefaults: true };
}

/** Which platforms can be posted to right now. */
export async function connectedPlatforms(): Promise<Record<PlatformId, boolean>> {
  const out = {} as Record<PlatformId, boolean>;
  await Promise.all(
    PLATFORM_IDS.map(async (id) => {
      try {
        out[id] = !!(await CONNECTORS[id].configured(await getCreds(id)));
      } catch {
        out[id] = false;
      }
    }),
  );
  return out;
}

/** What Settings shows for each platform. Secret values are never sent back, only whether they're set. */
export async function platformSummaries() {
  const connected = await connectedPlatforms();
  return Promise.all(
    PLATFORM_IDS.map(async (id) => {
      const c = CONNECTORS[id];
      const [creds, stored] = await Promise.all([getCreds(id), getStored(id)]);
      return {
        id,
        label: c.label,
        connected: connected[id],
        account: stored?.account ?? (id === "linkedin" ? creds.personName || null : null),
        connectedAt: stored?.connectedAt ?? null,
        expiresAt: id === "linkedin" && creds.expiresAt ? new Date(Number(creds.expiresAt)).toISOString() : null,
        setupHelp: c.setupHelp,
        oauth: !!c.oauth,
        signedIn: c.oauth ? !!(creds.accessToken || creds.refreshToken) : undefined,
        redirectUri: c.oauth ? redirectUri(id) : undefined,
        fields: c.fields.map((f) => ({
          ...f,
          set: !!creds[f.key],
          value: f.secret ? undefined : (creds[f.key] ?? ""),
        })),
      };
    }),
  ).then((items) => ({ items, publicMedia: !!publicMediaUrl("x"), testMode: env.PUBLISH_DRY_RUN }));
}
