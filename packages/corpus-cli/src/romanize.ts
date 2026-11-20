import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

// Korean Revised Romanization (RR) tables
const INITIALS = [
  "g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h",
];
const MEDIALS = [
  "a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i",
];
const FINALS = [
  "", "k", "k", "ks", "n", "nj", "nh", "t", "l", "lk", "lm", "lb", "ls", "lt", "lp", "lh", "m", "p", "ps", "t", "t", "ng", "t", "t", "k", "t", "p", "h",
];

// Liaison final -> next initial when next syllable begins with silent 'ㅇ' (initial index 11)
const LIAISON_MAP: Record<number, { stayFinal: string; nextInitial: string }> = {
  1: { stayFinal: "", nextInitial: "g" }, // ㄱ
  2: { stayFinal: "", nextInitial: "kk" }, // ㄲ
  4: { stayFinal: "", nextInitial: "n" }, // ㄴ
  7: { stayFinal: "", nextInitial: "d" }, // ㄷ
  8: { stayFinal: "", nextInitial: "r" }, // ㄹ
  16: { stayFinal: "", nextInitial: "m" }, // ㅁ
  17: { stayFinal: "", nextInitial: "b" }, // ㅂ
  19: { stayFinal: "", nextInitial: "s" }, // ㅅ
  20: { stayFinal: "", nextInitial: "ss" }, // ㅆ
  21: { stayFinal: "ng", nextInitial: "" }, // ㅇ stays ng
  22: { stayFinal: "", nextInitial: "j" }, // ㅈ
  23: { stayFinal: "", nextInitial: "ch" }, // ㅊ
  24: { stayFinal: "", nextInitial: "k" }, // ㅋ
  25: { stayFinal: "", nextInitial: "t" }, // ㅌ
  26: { stayFinal: "", nextInitial: "p" }, // ㅍ
  27: { stayFinal: "", nextInitial: "" }, // ㅎ silent intervocalically
};

/**
 * Convert Korean Hangul text into clean Revised Romanization at build time.
 * Handles Hangul syllable decomposition, intervocalic liaison with ㅇ,
 * and basic ㄹ-ㄹ -> ll assimilation.
 */
export function romanizeKorean(input: string): string {
  const text = input.normalize("NFC");
  const out: string[] = [];

  interface Syll {
    isHangul: boolean;
    ch: string;
    init: number;
    med: number;
    fin: number;
  }

  const parts: Syll[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xac00 && code <= 0xd7a3) {
      const idx = code - 0xac00;
      const init = Math.floor(idx / 588);
      const med = Math.floor((idx % 588) / 28);
      const fin = idx % 28;
      parts.push({ isHangul: true, ch, init, med, fin });
    } else {
      parts.push({ isHangul: false, ch, init: -1, med: -1, fin: -1 });
    }
  }

  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i]!;
    if (!cur.isHangul) {
      out.push(cur.ch);
      continue;
    }

    const prev = i > 0 ? parts[i - 1] : undefined;
    const next = i + 1 < parts.length ? parts[i + 1] : undefined;

    let initStr = INITIALS[cur.init] ?? "";
    // Check liaison from previous Hangul syllable ending into silent ㅇ (11)
    if (prev && prev.isHangul && cur.init === 11 && prev.fin in LIAISON_MAP) {
      initStr = LIAISON_MAP[prev.fin]!.nextInitial;
    } else if (prev && prev.isHangul && cur.init === 5 && prev.fin === 8) {
      // ㄹ + ㄹ -> l + l
      initStr = "l";
    }

    const medStr = MEDIALS[cur.med] ?? "";
    let finStr = FINALS[cur.fin] ?? "";

    // If current final liaises into next syllable starting with ㅇ (11)
    if (next && next.isHangul && next.init === 11 && cur.fin in LIAISON_MAP) {
      finStr = LIAISON_MAP[cur.fin]!.stayFinal;
    } else if (next && next.isHangul && cur.fin === 8 && next.init === 5) {
      finStr = "l";
    } else if (next && next.isHangul && (cur.fin === 1 || cur.fin === 2) && (next.init === 2 || next.init === 6)) {
      // Nasalization ㄱ/ㄲ + ㄴ/ㅁ -> ng
      finStr = "ng";
    } else if (next && next.isHangul && (cur.fin === 17 || cur.fin === 26) && (next.init === 2 || next.init === 6)) {
      // Nasalization ㅂ/ㅍ + ㄴ/ㅁ -> m
      finStr = "m";
    }

    out.push(initStr + medStr + finStr);
  }

  return out
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export interface JapaneseRomanizer {
  romanize(input: string): Promise<string>;
}

/**
 * Initialize build-time Japanese Hepburn Romaji converter backed by
 * Kuroshiro + Kuromoji morphological analyzer (zero runtime client bundle cost).
 */
export async function createJapaneseRomanizer(): Promise<JapaneseRomanizer> {
  const kuroshiro = new Kuroshiro();
  await kuroshiro.init(new KuromojiAnalyzer());

  return {
    async romanize(input: string): Promise<string> {
      const converted = await kuroshiro.convert(input.normalize("NFC"), {
        to: "romaji",
        mode: "spaced",
        romajiSystem: "hepburn",
      });
      return converted
        .replace(/\s+([.,!?。、！？])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
    },
  };
}
