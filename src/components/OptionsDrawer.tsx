import { useState } from "preact/hooks";
import { ACTIVE_DIR_SHORT, LANGUAGE_DIRECTIONS, resolveTrackShuffle } from "../core/options.ts";
import type {
  GameDifficulty,
  GameOptions,
  HubCategoryId,
  LanguageSubtrackId,
  RomajiDisplayMode,
  SessionLength,
} from "../core/types.ts";

interface OptionsDrawerProps {
  selectedCategory: HubCategoryId;
  languageSubtrack: LanguageSubtrackId;
  onChangeLanguageSubtrack: (subtrackId: LanguageSubtrackId) => void;
  value: GameOptions;
  onChange: (next: GameOptions) => void;
  context: "solo" | "room";
  defaultOpen?: boolean;
}

export function OptionsDrawer({
  selectedCategory,
  languageSubtrack,
  onChangeLanguageSubtrack,
  value,
  onChange,
  context,
  defaultOpen = false,
}: OptionsDrawerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isLanguages = selectedCategory === "languages";
  const isCharacterQuiz = selectedCategory === "trivia-anime-characters";
  const effectiveShuffle =
    context === "room" || resolveTrackShuffle(selectedCategory, value.shuffleCardsAndChoices);

  const summaryBits: string[] = [];
  if (isLanguages) {
    summaryBits.push(ACTIVE_DIR_SHORT[languageSubtrack]);
  }
  summaryBits.push(
    value.difficulty === "harder" ? "Harder" : "Standard",
    effectiveShuffle ? "Shuffled" : "Fixed order",
    `${value.sessionLength} cards`
  );
  if (isLanguages) {
    summaryBits.push(
      value.romajiMode === "subtle"
        ? "Subtle Romaji"
        : value.romajiMode === "after_answer"
        ? "Romaji after answer"
        : "Romaji off"
    );
  }

  return (
    <div class="options-drawer-wrap">
      <button
        type="button"
        class="drawer-toggle"
        aria-expanded={open}
        aria-controls={`options-drawer-${context}`}
        data-testid="options-drawer-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <span>
          <strong>Advanced / Options</strong>{" "}
          <span class="muted" style="font-size: 0.85rem; font-weight: 500;">
            ({summaryBits.join(" · ")})
          </span>
        </span>
        <span class="pill" aria-hidden="true">
          {open ? "Hide" : "Customize"}
        </span>
      </button>

      <div
        id={`options-drawer-${context}`}
        class={`options-drawer ${open ? "is-open" : ""}`}
        hidden={!open}
        aria-hidden={!open}
      >
        <div class="options-drawer-inner">
          <div class="options-panel stack">
            {isLanguages && (
              <div class="stack" style="gap: 6px;">
                <span class="field-label" style="margin-bottom: 0;">
                  Language &amp; Direction
                </span>
                <div
                  class="segmented-row"
                  role="group"
                  aria-label="Language and direction"
                  data-testid="language-direction-group"
                >
                  {LANGUAGE_DIRECTIONS.map((dir) => (
                    <button
                      key={dir.subtrackId}
                      type="button"
                      class="seg-btn"
                      data-testid={`lang-dir-${dir.subtrackId}`}
                      aria-pressed={languageSubtrack === dir.subtrackId}
                      onClick={() => onChangeLanguageSubtrack(dir.subtrackId)}
                    >
                      {dir.label}
                    </button>
                  ))}
                </div>
                <span class="muted" style="font-size: 0.8125rem;">
                  {LANGUAGE_DIRECTIONS.find((d) => d.subtrackId === languageSubtrack)?.hint}
                </span>
              </div>
            )}

            <div class="stack" style="gap: 6px;">
              <span class="field-label" style="margin-bottom: 0;">
                Difficulty
              </span>
              <div class="segmented-row" role="group" aria-label="Difficulty">
                {(
                  [
                    ["standard", "Standard (Default)"],
                    ["harder", "Harder (Tighter + 15s Timer)"],
                  ] as Array<[GameDifficulty, string]>
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    class="seg-btn"
                    aria-pressed={value.difficulty === key}
                    onClick={() =>
                      onChange({
                        ...value,
                        difficulty: key,
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span class="muted" style="font-size: 0.8125rem;">
                Harder prioritizes challenge/intermediate cards in Practice and adds a 15s timer.
                {isLanguages ? " Use Romaji options below for a blind reading test." : ""}
              </span>
            </div>

            <div class="stack" style="gap: 6px;">
              <span class="field-label" style="margin-bottom: 0;">
                Session Length {context === "solo" ? "(Unlimited Practice)" : "(Room Cards)"}
              </span>
              <div class="segmented-row" role="group" aria-label="Session length">
                {([5, 10, 15] as SessionLength[]).map((len) => (
                  <button
                    key={len}
                    type="button"
                    class="seg-btn"
                    aria-pressed={value.sessionLength === len}
                    onClick={() => onChange({ ...value, sessionLength: len })}
                  >
                    {len} cards{len === 5 ? " (Default)" : ""}
                  </button>
                ))}
              </div>
              {context === "solo" && (
                <span class="muted" style="font-size: 0.8125rem;">
                  Daily Ritual is always 5 cards; Session Length applies to Unlimited Practice &amp; Multiplayer rooms.
                </span>
              )}
            </div>

            {isLanguages && (
              <div class="stack" style="gap: 6px;">
                <span class="field-label" style="margin-bottom: 0;">
                  Romaji / Romanization
                </span>
                <div
                  class="segmented-row"
                  role="group"
                  aria-label="Romaji display mode"
                  data-testid="romaji-mode-group"
                >
                  {(
                    [
                      ["subtle", "Subtle (Default)"],
                      ["after_answer", "After answer"],
                      ["off", "Off"],
                    ] as Array<[RomajiDisplayMode, string]>
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      class="seg-btn"
                      aria-pressed={value.romajiMode === mode}
                      onClick={() => onChange({ ...value, romajiMode: mode })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div class="row" style="justify-content: space-between; align-items: center;">
              <div class="stack" style="gap: 2px; min-width: 0;">
                <strong style="font-size: 0.9375rem;">Shuffle Cards &amp; Choices</strong>
                <span class="muted" style="font-size: 0.8125rem;">
                  {context === "room"
                    ? "Always shuffled uniquely for every multiplayer room."
                    : "Prevents button-position memorization across sessions."}
                </span>
              </div>
              {context === "room" ? (
                <span class="pill pill-ok">Always ON</span>
              ) : isCharacterQuiz ? (
                <span class="pill pill-ok">Always ON for Who&apos;s That Anime?</span>
              ) : (
                <div class="segmented-row" role="group" aria-label="Shuffle cards and choices">
                  <button
                    type="button"
                    class="seg-btn"
                    aria-pressed={value.shuffleCardsAndChoices}
                    data-testid="shuffle-on-btn"
                    onClick={() =>
                      onChange({
                        ...value,
                        shuffleCardsAndChoices: true,
                      })
                    }
                  >
                    ON (Shuffled)
                  </button>
                  <button
                    type="button"
                    class="seg-btn"
                    aria-pressed={!value.shuffleCardsAndChoices}
                    data-testid="shuffle-off-btn"
                    onClick={() =>
                      onChange({
                        ...value,
                        shuffleCardsAndChoices: false,
                      })
                    }
                  >
                    OFF (Fixed order)
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
