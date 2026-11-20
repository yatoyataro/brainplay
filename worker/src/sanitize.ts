const CONTROL_RE = /[\x00-\x1F\x7F]/g;
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const BASIC_PROFANITY_RE = /\b(fuck|shit|bitch|asshole|cunt|nigger|faggot|slut|whore)\b/i;

export function sanitizeDisplayName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "Display name must be a string." };
  }
  let clean = raw
    .normalize("NFC")
    .replace(CONTROL_RE, "")
    .replace(URL_RE, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length < 2) {
    return { ok: false, error: "Display name must be at least 2 characters." };
  }
  if (clean.length > 20) {
    clean = clean.slice(0, 20).trim();
  }
  if (BASIC_PROFANITY_RE.test(clean)) {
    return { ok: false, error: "Please choose a friendly plain-text display name." };
  }
  return { ok: true, value: clean };
}

export function disambiguateDisplayName(desired: string, existingNames: string[]): string {
  const lowerExisting = new Set(existingNames.map((n) => n.toLowerCase()));
  if (!lowerExisting.has(desired.toLowerCase())) return desired;
  for (let n = 2; n <= 99; n++) {
    const suffix = ` #${n}`;
    const base = desired.slice(0, Math.max(1, 20 - suffix.length)).trim();
    const candidate = `${base}${suffix}`;
    if (!lowerExisting.has(candidate.toLowerCase())) return candidate;
  }
  return `${desired.slice(0, 15)} #${Math.floor(Math.random() * 900 + 100)}`;
}

export function isValidRoomCode(code: string): boolean {
  return /^[A-HJ-NP-Z2-9]{6}$/.test(code);
}
