import type { PackCatalog } from "../core/types.ts";

interface AboutViewProps {
  catalog: PackCatalog | null;
}

export function AboutView({ catalog }: AboutViewProps) {
  return (
    <div class="stack">
      <section class="card stack" aria-labelledby="about-privacy-title">
        <h1 id="about-privacy-title" class="h1">
          About, Zero-PII Privacy &amp; Open Licenses
        </h1>
        <p>
          BrainPlay runs on a strict <strong>zero-cost, zero-account, zero-tracker</strong> design.
          Solo mastery &amp; settings stay strictly in your browser (<code>IndexedDB</code> /{" "}
          <code>localStorage</code>) with zero tracking, analytics, or ads.
        </p>
        <p class="muted">
          Optional Multiplayer rooms temporarily store room nickname &amp; round answers
          (auto-deleted after 48h), plus short-lived keyed-hash rate-limit counters (1h–24h
          expiry, automatically purged) for room requests and card flags — no raw IPs, accounts,
          email addresses, advertising cookies, or PII are stored.
        </p>
      </section>

      <section class="card stack" aria-labelledby="about-ownership-title">
        <div class="row" style="justify-content: space-between;">
          <h2 id="about-ownership-title" class="h2">
            Application License &amp; Ownership
          </h2>
          <span class="pill pill-ok">MIT License</span>
        </div>
        <p>
          <strong>Copyright &copy; 2026 Dwight Jairo Pingul (</strong>
          <a href="https://github.com/yatoyataro" target="_blank" rel="noreferrer">
            @yatoyataro
          </a>
          <strong>)</strong>
        </p>
        <p class="muted">
          The BrainPlay web application source code, UI, and game engine are released under the
          permissive MIT License. Third-party open learning datasets listed below remain governed
          separately by their respective upstream licenses and attribution terms.
        </p>
      </section>

      <section class="card stack" aria-labelledby="about-licenses-title">
        <h2 id="about-licenses-title" class="h2">
          Open Learning Corpora &amp; Attribution
        </h2>
        <div class="stack">
          <div>
            <strong>Track 1 — Phrases &amp; Words in Context (English ↔ Korean, English ↔ Japanese):</strong>
            <p class="muted">
              Sourced from the{" "}
              <a href="https://tatoeba.org/" target="_blank" rel="noreferrer">
                Tatoeba Project
              </a>{" "}
              per-language exports under{" "}
              <a href="https://creativecommons.org/licenses/by/2.0/fr/" target="_blank" rel="noreferrer">
                CC BY 2.0 FR
              </a>
              . Curated into 4-choice cards with pre-computed Revised Romanization (Korean) and
              Hepburn Romaji (Japanese), preserving contributor attribution per item.
            </p>
          </div>
          <div>
            <strong>Track 2A — Anime Trivia:</strong>
            <p class="muted">
              Combines{" "}
              <a href="https://opentdb.com/" target="_blank" rel="noreferrer">
                OpenTriviaDB Category 31
              </a>{" "}
              questions under{" "}
              <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">
                CC BY-SA 4.0
              </a>{" "}
              (in <code>public/packs/cc-by-sa-4.0/</code>) with factual anime studio, premiere year,
              title, and source metadata powered by{" "}
              <a href="https://anilist.co/" target="_blank" rel="noreferrer">
                AniList
              </a>{" "}
              and{" "}
              <a href="https://kitsu.io/" target="_blank" rel="noreferrer">
                Kitsu
              </a>{" "}
              (in <code>public/packs/public-factual-api/</code>).
            </p>
          </div>
          <div>
            <strong>Track 2B — Who&apos;s That Anime? (Character Trivia):</strong>
            <p class="muted">
              Build-time character clue cards curated from{" "}
              <a href="https://anilist.co/" target="_blank" rel="noreferrer">
                AniList
              </a>{" "}
              story role, relationships, powers, defining moments, and series metadata (separated under{" "}
              <code>public/packs/public-factual-api/</code>, zero runtime API calls).
            </p>
          </div>
          <div>
            <strong>Track 2C — World, Culture &amp; Science Trivia:</strong>
            <p class="muted">
              Sourced from{" "}
              <a href="https://opentdb.com/" target="_blank" rel="noreferrer">
                OpenTriviaDB
              </a>{" "}
              under{" "}
              <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">
                CC BY-SA 4.0
              </a>
              . Curated derivative trivia packs remain openly accessible under ShareAlike terms in{" "}
              <code>public/packs/cc-by-sa-4.0/</code>.
            </p>
          </div>
          {catalog && (
            <p class="muted">
              Active static bundle: {catalog.total_items.toLocaleString()} verified cards across{" "}
              {catalog.shards.length} modular JSON shards (schema supports <code>CC0-1.0</code>,{" "}
              <code>CC-BY-2.0-FR</code>, <code>CC-BY-SA-4.0</code>, and{" "}
              <code>PUBLIC-FACTUAL-API</code> packs).
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
