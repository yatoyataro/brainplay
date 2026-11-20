const NAMED_ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&#039;": "'",
  "&apos;": "'",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&ldquo;": '"',
  "&rdquo;": '"',
  "&lsquo;": "'",
  "&rsquo;": "'",
  "&ndash;": "-",
  "&mdash;": "-",
  "&hellip;": "...",
  "&deg;": "°",
  "&eacute;": "é",
  "&Eacute;": "É",
  "&uuml;": "ü",
  "&ouml;": "ö",
  "&auml;": "ä",
  "&ntilde;": "ñ",
  "&pi;": "π",
};

/**
 * Unescape common HTML entities and numeric character references cleanly.
 * Also handles URL-encoded OpenTriviaDB strings safely when needed.
 */
export function unescapeHtmlEntities(input: string): string {
  let out = input.replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, (match) => {
    if (match in NAMED_ENTITIES) return NAMED_ENTITIES[match]!;
    if (match.startsWith("&#x") || match.startsWith("&#X")) {
      const code = Number.parseInt(match.slice(3, -1), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (match.startsWith("&#")) {
      const code = Number.parseInt(match.slice(2, -1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return match;
  });
  // Second pass handles double-encoded entities like &amp;quot;
  out = out.replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, (match) =>
    match in NAMED_ENTITIES ? NAMED_ENTITIES[match]! : match
  );
  return out;
}

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u00AD]/g;
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

/**
 * Normalize UTF-8 text safely for Korean Hangul (NFC composition),
 * Japanese Kana/Kanji, and Latin text.
 */
export function normalizeUtf8Text(input: string): string {
  return unescapeHtmlEntities(input)
    .normalize("NFC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RESIDUAL_HTML_ENTITY_RE = /&(?:[a-zA-Z]{2,12}|#\d{1,6}|#x[0-9a-fA-F]{1,6});/;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/;

export function hasResidualHtmlArtifacts(input: string): boolean {
  return RESIDUAL_HTML_ENTITY_RE.test(input) || HTML_TAG_RE.test(input);
}

/**
 * Normalize an answer or prompt for deduplication & matching across
 * English, Korean (Hangul NFC + full-width normalization), and Japanese
 * (NFC + full-width ASCII normalization + punctuation trimming).
 */
export function normalizeForMatching(input: string): string {
  return normalizeUtf8Text(input)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/[.,!?;:'"“”‘’。、！？「」『』（）()]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;
const JAPANESE_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;

export function hasHangul(input: string): boolean {
  return HANGUL_RE.test(input);
}

export function hasJapanese(input: string): boolean {
  return JAPANESE_RE.test(input);
}
