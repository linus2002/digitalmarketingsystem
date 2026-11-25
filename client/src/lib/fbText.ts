// Bold text on Facebook. The Graph API only takes plain text, so **bold** in a post would show the asterisks as typed.
// We keep **…** in the saved text (easy to edit and check) and, when publishing, swap the letters and digits inside
// for Unicode "Mathematical Sans-Serif Bold" characters, which Facebook shows as bold.
// Keep in step with server/src/lib/fbText.ts.

const BOLD_UPPER = 0x1d5d4; // 𝗔
const BOLD_LOWER = 0x1d5ee; // 𝗮
const BOLD_DIGIT = 0x1d7ec; // 𝟬

function boldChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 65 && c <= 90) out += String.fromCodePoint(BOLD_UPPER + c - 65);
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(BOLD_LOWER + c - 97);
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(BOLD_DIGIT + c - 48);
    else out += ch; // accented letters, emojis and punctuation stay as they are
  }
  return out;
}

/** **text** markers: no spaces just inside the markers, and on one line. */
export const BOLD_SPAN = /\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g;

/** Turns **text** into bold letters Facebook can show. Hashtags inside stay plain so they still work as hashtags. */
export function toFacebookText(text: string): string {
  return text.replace(BOLD_SPAN, (_m, inner: string) =>
    inner
      .split(/(#[\p{L}\p{N}_]+)/u)
      .map((part, i) => (i % 2 ? part : boldChars(part)))
      .join(""),
  );
}
