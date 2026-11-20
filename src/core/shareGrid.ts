export type RoundEmojiOutcome = "correct" | "wrong" | "skipped" | "pending";

export function outcomeToEmoji(outcome: RoundEmojiOutcome): string {
  if (outcome === "correct") return "🟩";
  if (outcome === "wrong") return "🟨";
  return "⬜";
}

export function buildEmojiRow(outcomes: RoundEmojiOutcome[]): string {
  return outcomes.slice(0, 5).map(outcomeToEmoji).join("");
}

/**
 * Generate a spoiler-free share card (REQ-003 / TEST-002).
 * Contains zero prompt text, answers, or personal identifiers.
 */
export function buildSpoilerFreeShareText(params: {
  title: string;
  dateOrRoom: string;
  outcomes: RoundEmojiOutcome[];
  url: string;
}): string {
  const padded: RoundEmojiOutcome[] = [...params.outcomes];
  while (padded.length < 5) padded.push("skipped");
  const grid = buildEmojiRow(padded);
  const score = padded.slice(0, 5).filter((o) => o === "correct").length;
  return `${params.title} · ${params.dateOrRoom}\n${grid} (${score}/5)\n${params.url}`;
}
