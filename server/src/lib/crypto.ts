import crypto from "node:crypto";
import { env } from "../config/env.js";

// AES-256-GCM for personal data at rest. Format: v1.<iv>.<tag>.<ciphertext> (base64url)
const key = Buffer.from(env.DATA_ENCRYPTION_KEY, "hex");

export function encrypt(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  const [ver, iv, tag, ct] = value.split(".");
  if (ver !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognised ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function safeDecrypt(value: string | null | undefined): string | null {
  try {
    return decrypt(value);
  } catch {
    return "[unreadable: check DATA_ENCRYPTION_KEY]";
  }
}

/** Keyed hash for values we must match on but never read back (e.g. IP addresses). */
export function hmac(value: string): string {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

export function maskEmail(v: string | null): string | null {
  if (!v) return v;
  const [user, domain] = v.split("@");
  if (!domain) return "•••";
  return `${user.slice(0, 2)}•••@${domain}`;
}

export function maskPhone(v: string | null): string | null {
  if (!v) return v;
  const digits = v.replace(/\D/g, "");
  return digits.length <= 4 ? "•••" : `•••• ${digits.slice(-4)}`;
}

export function maskName(v: string | null): string | null {
  if (!v) return v;
  return v
    .split(/\s+/)
    .map((p) => (p ? `${p[0]}.` : p))
    .join(" ");
}
