// What each social platform accepts. Keep in step with client/src/lib/platformRules.ts.

export type PlatformKey = "facebook" | "instagram" | "twitter" | "youtube" | "tiktok" | "linkedin";

export interface RuleInput {
  /** Caption with hashtags added (no link). */
  text: string;
  link: string | null;
  media: { kind: "image" | "video"; mime?: string | null } | null;
}

const LIMITS: Record<PlatformKey, number> = { facebook: 63_206, instagram: 2_200, twitter: 280, youtube: 5_000, tiktok: 2_200, linkedin: 3_000 };

/** The text each platform gets. Facebook attaches the link separately, LinkedIn shows it as a link card when there's no picture. */
export function captionFor(p: PlatformKey, text: string, link: string | null, hasMedia: boolean): string {
  if (!link || p === "facebook" || (p === "linkedin" && !hasMedia)) return text;
  return `${text}\n\n${link}`;
}

/** Length as the platform counts it (X counts every link as 23 characters). */
export function lengthFor(p: PlatformKey, s: string): number {
  if (p === "twitter") return [...s.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;
  return [...s].length;
}

/** Why this post can't go to this platform as it is, or null when it can. */
export function platformProblem(p: PlatformKey, x: RuleInput): string | null {
  const caption = captionFor(p, x.text, x.link, !!x.media);
  const len = lengthFor(p, caption);
  switch (p) {
    case "instagram":
      if (!x.media) return "Instagram needs an image or a video.";
      if (x.media.kind === "image" && x.media.mime && x.media.mime !== "image/jpeg") return "Instagram only takes JPG images. Use a JPG or a video.";
      break;
    case "youtube":
      if (x.media?.kind !== "video") return "YouTube needs a video.";
      break;
    case "tiktok":
      if (x.media?.kind !== "video") return "TikTok needs a video.";
      break;
    case "twitter":
      if (x.media?.kind === "video") return "Videos on X aren't supported yet. Use an image, or no picture.";
      break;
  }
  if (len > LIMITS[p]) return `Too long for ${p === "twitter" ? "X" : p[0].toUpperCase() + p.slice(1)}: ${len} of ${LIMITS[p]} characters.`;
  return null;
}
