import { expect, type Page, test } from "@playwright/test";

async function captureFirstNCards(page: Page, count: number): Promise<string> {
  const captured: Array<{ prompt: string; opts: string[] }> = [];
  for (let i = 0; i < count; i++) {
    await expect(page.locator(".prompt-text")).toBeVisible();
    const prompt = await page.locator(".prompt-text").innerText();
    const opts = await page.locator(".option-btn").allInnerTexts();
    captured.push({ prompt, opts });
    await page.locator(".option-btn").first().click();
    await expect(page.getByTestId("solo-feedback-banner")).toBeVisible();
    if (i + 1 < count) {
      await page.getByRole("button", { name: /Next Card/i }).click();
    }
  }
  return JSON.stringify(captured);
}

test.describe("PRB-005 End-to-End Solo, Multiplayer, Mobile & A11y", () => {
  test("TEST-001, TEST-002, TEST-009: 4-card Hub & RoomNew conditional controls, 1280px Bento, #FDFCE8 theme, 360px mobile & 0 /api/ calls", async ({
    page,
  }) => {
    const apiRequests: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.startsWith("/api/")) {
        apiRequests.push(req.url());
      }
    });

    // Desktop Bento layout & #FDFCE8 Cream Theme verification (1280x800)
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Today's 5-Card Ritual/i })).toBeVisible();

    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bodyBg).toBe("rgb(253, 252, 232)"); // #FDFCE8

    const primaryBox = await page.locator(".bento-primary").boundingBox();
    const companionBox = await page.locator(".bento-companion").boundingBox();
    expect(primaryBox).not.toBeNull();
    expect(companionBox).not.toBeNull();
    expect(companionBox!.x).toBeGreaterThan(primaryBox!.x + primaryBox!.width * 0.5);

    // Strictly 4 category cards on Hub + Languages config cue + mode description
    await expect(page.locator('[data-testid^="category-card-"]')).toHaveCount(4);
    await expect(page.getByTestId("category-card-languages")).toBeVisible();
    await expect(page.getByTestId("category-card-trivia-anime")).toBeVisible();
    await expect(page.getByTestId("category-card-trivia-anime-characters")).toBeVisible();
    await expect(page.getByTestId("category-card-trivia-world")).toBeVisible();
    await expect(page.getByTestId("languages-config-cue")).toContainText("Active: EN -> KO");
    await expect(page.getByText(/answers stay locked until all players answer/i)).toBeVisible();

    // Collapsed OptionsDrawer has [hidden]
    await expect(page.locator("#options-drawer-solo")).toHaveAttribute("hidden", "");

    // Open OptionsDrawer -> Languages shows 4 directions & Romaji group
    await page.getByTestId("options-drawer-toggle").click();
    await expect(page.locator("#options-drawer-solo")).not.toHaveAttribute("hidden", "");
    await page.getByTestId("category-card-languages").click();
    await expect(page.getByTestId("language-direction-group")).toBeVisible();
    await expect(page.getByTestId("lang-dir-phrases-en-ko")).toBeVisible();
    await expect(page.getByTestId("lang-dir-phrases-ko-en")).toBeVisible();
    await expect(page.getByTestId("lang-dir-phrases-en-ja")).toBeVisible();
    await expect(page.getByTestId("lang-dir-phrases-ja-en")).toBeVisible();
    await expect(page.getByTestId("romaji-mode-group")).toBeVisible();

    // Picking Korean -> English updates languages-config-cue to KO -> EN
    await page.getByTestId("lang-dir-phrases-ko-en").click();
    await expect(page.getByTestId("languages-config-cue")).toContainText("KO -> EN");

    // Selecting any Trivia category completely omits language-direction-group & romaji-mode-group
    for (const triviaTestId of [
      "category-card-trivia-anime",
      "category-card-trivia-anime-characters",
      "category-card-trivia-world",
    ]) {
      await page.getByTestId(triviaTestId).click();
      await expect(page.getByTestId("language-direction-group")).toHaveCount(0);
      await expect(page.getByTestId("romaji-mode-group")).toHaveCount(0);
    }

    // Who's That Anime? locks Shuffle to Always ON pill
    await page.getByTestId("category-card-trivia-anime-characters").click();
    await expect(page.getByText("Always ON for Who's That Anime?")).toBeVisible();

    // Anime Trivia exposes Shuffle ON/OFF & passes shuf=1 / shuf=0 to Today's 5
    await page.getByTestId("category-card-trivia-anime").click();
    await page.getByTestId("shuffle-on-btn").click();
    await expect(page.getByTestId("shuffle-on-btn")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /Play Today's 5/i }).click();
    await expect(page.locator(".prompt-text")).toBeVisible();
    const dailyOnUrl = new URL(page.url());
    expect(dailyOnUrl.pathname).toBe("/play/daily");
    expect(dailyOnUrl.searchParams.get("track")).toBe("trivia-anime");
    expect(dailyOnUrl.searchParams.get("shuf")).toBe("1");

    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByTestId("options-drawer-toggle").click();
    await page.getByTestId("shuffle-off-btn").click();
    await expect(page.getByTestId("shuffle-off-btn")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /Play Today's 5/i }).click();
    await expect(page.locator(".prompt-text")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("shuf")).toBe("0");

    // Verify RoomNew 4-card picker & conditional Language/Romaji options
    await page.goto("/room/new");
    await expect(page.locator('[data-testid^="room-category-card-"]')).toHaveCount(4);
    await expect(page.getByTestId("room-languages-config-cue")).toBeVisible();
    await expect(page.locator("#options-drawer-room")).toHaveAttribute("hidden", "");
    await page.getByTestId("options-drawer-toggle").click();
    await page.getByTestId("room-category-card-languages").click();
    await expect(page.getByTestId("language-direction-group")).toBeVisible();
    await expect(page.getByTestId("romaji-mode-group")).toBeVisible();

    for (const roomTriviaTestId of [
      "room-category-card-trivia-anime",
      "room-category-card-trivia-anime-characters",
      "room-category-card-trivia-world",
    ]) {
      await page.getByTestId(roomTriviaTestId).click();
      await expect(page.getByTestId("language-direction-group")).toHaveCount(0);
      await expect(page.getByTestId("romaji-mode-group")).toHaveCount(0);
    }

    // Switch to 360x740 Mobile & verify stacking, conditional drawer, >=16px input & 0 horizontal overflow
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Today's 5-Card Ritual/i })).toBeVisible();
    await expect(page.locator('[data-testid^="category-card-"]')).toHaveCount(4);
    await expect(page.getByTestId("languages-config-cue")).toBeVisible();

    const mobilePrimary = await page.locator(".bento-primary").boundingBox();
    const mobileCompanion = await page.locator(".bento-companion").boundingBox();
    expect(mobileCompanion!.y).toBeGreaterThan(mobilePrimary!.y);

    const inputFontPx = await page
      .locator("#hub-room-code")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(inputFontPx).toBeGreaterThanOrEqual(16);

    await page.getByTestId("options-drawer-toggle").click();
    await page.getByTestId("category-card-languages").click();
    await expect(page.getByTestId("language-direction-group")).toBeVisible();
    await expect(page.getByTestId("romaji-mode-group")).toBeVisible();
    await page.getByTestId("category-card-trivia-world").click();
    await expect(page.getByTestId("language-direction-group")).toHaveCount(0);
    await expect(page.getByTestId("romaji-mode-group")).toHaveCount(0);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(overflow).toBe(false);

    // DEC-006 strict $0 guarantee: Solo mode made ZERO /api/ requests
    expect(apiRequests).toEqual([]);
  });

  test("ISS-DEV-012 & ISS-DEV-013: Persistent Options across Today's 5, Play Extra Practice, reload & genuine random shuffling", async ({
    page,
  }) => {
    const apiRequests: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.startsWith("/api/")) {
        apiRequests.push(req.url());
      }
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    // Configure Languages (Korean -> English), Harder, 10 cards, After answer Romaji, Shuffle: ON
    await page.getByTestId("category-card-languages").click();
    await page.getByTestId("options-drawer-toggle").click();
    await page.getByTestId("lang-dir-phrases-ko-en").click();
    await page.getByRole("button", { name: "Harder (Tighter + 15s Timer)", exact: true }).click();
    await page.getByRole("button", { name: "10 cards", exact: true }).click();
    await page.getByRole("button", { name: "After answer", exact: true }).click();
    await page.getByTestId("shuffle-on-btn").click();
    await expect(page.getByTestId("languages-config-cue")).toContainText("KO -> EN");

    // Play through 5 cards of Today's 5
    await page.getByRole("button", { name: /Play Today's 5/i }).click();
    await expect(page.locator(".prompt-text")).toBeVisible();

    for (let i = 0; i < 5; i++) {
      await expect(page.getByText(`${i + 1}/5`, { exact: true })).toBeVisible();
      await expect(page.getByTestId("solo-timer")).toBeVisible();
      // After answer Romaji must stay hidden before answering
      await expect(page.getByTestId("prompt-romanization")).toHaveCount(0);

      const optBox = await page.locator(".option-btn").first().boundingBox();
      expect(optBox?.height ?? 0).toBeGreaterThanOrEqual(44);

      await page.keyboard.press("1");
      await expect(page.getByTestId("solo-feedback-banner")).toBeVisible();
      // After answer Romaji reveals once answered
      await expect(page.getByTestId("prompt-romanization")).toBeVisible();
      await page.keyboard.press("Enter");
    }

    await expect(page.getByTestId("share-preview")).toBeVisible();
    const shareTxt = await page.getByTestId("share-preview").innerText();
    expect(shareTxt).toMatch(/[🟩🟨⬜]{5}/);

    // Click "Play Extra Practice" -> starts Practice at 1/10 with Harder timer visible
    await page.getByRole("button", { name: "Play Extra Practice", exact: true }).click();
    await expect(page).toHaveURL(/\/play\/practice\?track=phrases-ko-en/);
    await expect(page.locator(".prompt-text")).toBeVisible();
    await expect(page.getByText("1/10", { exact: true })).toBeVisible();
    await expect(page.getByTestId("solo-timer")).toBeVisible();

    // Navigate back to "/" and run page.reload() -> verify full UserPreferencesV1 persistence
    await page.goto("/");
    await page.reload();
    await expect(page.getByTestId("category-card-languages")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByTestId("languages-config-cue")).toContainText("KO -> EN");

    await page.getByTestId("options-drawer-toggle").click();
    await expect(page.getByTestId("lang-dir-phrases-ko-en")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(
      page.getByRole("button", { name: "Harder (Tighter + 15s Timer)", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "10 cards", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByRole("button", { name: "After answer", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByTestId("shuffle-on-btn")).toHaveAttribute("aria-pressed", "true");

    // Genuine Random Shuffling: Who's That Anime? across 2 fresh sessions (cards 1..5)
    await page.getByTestId("category-card-trivia-anime-characters").click();
    await page.getByRole("button", { name: /Unlimited Practice \(10 cards\)/i }).click();
    await expect(page.getByText("1/10", { exact: true })).toBeVisible();
    const charRun1 = await captureFirstNCards(page, 5);

    await page.goto("/");
    await page.getByTestId("category-card-trivia-anime-characters").click();
    await page.getByRole("button", { name: /Unlimited Practice \(10 cards\)/i }).click();
    await expect(page.getByText("1/10", { exact: true })).toBeVisible();
    const charRun2 = await captureFirstNCards(page, 5);
    expect(charRun2).not.toBe(charRun1);

    // Genuine Random Shuffling: Anime Trivia with Shuffle ON across 2 fresh sessions (cards 1..5)
    await page.goto("/");
    await page.getByTestId("category-card-trivia-anime").click();
    await page.getByTestId("options-drawer-toggle").click();
    await expect(page.getByTestId("shuffle-on-btn")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /Unlimited Practice \(10 cards\)/i }).click();
    await expect(page.getByText("1/10", { exact: true })).toBeVisible();
    const animeRun1 = await captureFirstNCards(page, 5);

    await page.goto("/");
    await page.getByTestId("category-card-trivia-anime").click();
    await page.getByRole("button", { name: /Unlimited Practice \(10 cards\)/i }).click();
    await expect(page.getByText("1/10", { exact: true })).toBeVisible();
    const animeRun2 = await captureFirstNCards(page, 5);
    expect(animeRun2).not.toBe(animeRun1);

    expect(apiRequests).toEqual([]);
  });

  test("TEST-007: Mastery Dashboard 1280px Bento & 360px mobile, grouped Languages + 4 directions, >=44px buttons, due CTA, backup & checksum", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/mastery");
    await expect(page.getByRole("heading", { name: /My Mastery Dashboard/i })).toBeVisible();
    const reviewCta = page.getByTestId("review-due-cta");
    await expect(reviewCta).toBeVisible();
    expect((await reviewCta.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    // 1280px Bento: .bento-companion right of .bento-primary; 7-Day Study Guide above Portable Backup & Sync
    const primaryBox = await page.locator(".bento-primary").boundingBox();
    const companionBox = await page.locator(".bento-companion").boundingBox();
    expect(primaryBox).not.toBeNull();
    expect(companionBox).not.toBeNull();
    expect(companionBox!.x).toBeGreaterThan(primaryBox!.x + primaryBox!.width * 0.5);
    await expect(page.locator(".bento-companion")).toContainText("7-Day Activity & Study Guide");
    await expect(page.locator(".bento-companion")).toContainText("Portable Backup & Sync");

    const guideBox = await page.getByRole("heading", { name: /7-Day Activity & Study Guide/i }).boundingBox();
    const backupBox = await page.getByRole("heading", { name: /Portable Backup & Sync/i }).boundingBox();
    expect(guideBox!.y).toBeLessThan(backupBox!.y);

    // Grouped Languages + all 4 direction subrows + 3 Trivia tracks rendered at 0 learned cards
    const perTrack = page.getByTestId("per-track-progress");
    const langGroup = page.getByTestId("mastery-languages-group");
    await expect(langGroup).toBeVisible();
    await expect(page.getByTestId("mastery-lang-heading")).toContainText("Languages (KO & JA)");

    for (const dirId of [
      "phrases-en-ko",
      "phrases-ko-en",
      "phrases-en-ja",
      "phrases-ja-en",
    ]) {
      const subrow = page.getByTestId(`mastery-subrow-${dirId}`);
      await expect(subrow).toBeVisible();
      const subBtn = subrow.getByRole("button", { name: /Practice|Review Due/i });
      expect((await subBtn.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    for (const label of [
      "English -> Korean",
      "Korean -> English",
      "English -> Japanese",
      "Japanese -> English",
      "Anime Trivia",
      "Who's That Anime?",
      "World, Culture & Science Trivia",
    ]) {
      await expect(perTrack).toContainText(label);
    }

    // Actionable Practice button on Who's That Anime? >= 44px height & launches Practice cleanly
    const charPracticeBtn = perTrack
      .locator(".card-subtle", { hasText: "Who's That Anime?" })
      .getByRole("button", { name: "Practice" });
    expect((await charPracticeBtn.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await charPracticeBtn.click();
    await expect(page).toHaveURL(/\/play\/practice\?track=trivia-anime-characters/);
    await expect(page.locator(".prompt-text")).toBeVisible();

    // Answer cards until at least 1 card is due today (missed answer schedules due today)
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.locator(".option-btn").first().click();
      const isWrong = (await page.locator(".banner-err").count()) > 0;
      if (isWrong) break;
      const advBtn = page.getByRole("button", { name: /Next Card|See Summary/i });
      if ((await advBtn.count()) > 0) {
        await advBtn.click();
      } else {
        break;
      }
    }

    // Return to Mastery Dashboard at 1280x800 (confirm intentional ISS-DEV-015 leave guard mid-round) and verify due >= 1 CTA + Review Due button >= 44px
    await page.getByRole("button", { name: "Mastery", exact: true }).click();
    await expect(page.getByTestId("confirm-leave-dialog")).toBeVisible();
    await page.getByTestId("leave-confirm-btn").click();
    await expect(page.getByTestId("review-due-cta")).toContainText(/Review Due Cards \(\d+\)/i);
    const reviewDueBtn = perTrack.getByRole("button", { name: /Review Due \(\d+\)/i }).first();
    await expect(reviewDueBtn).toBeVisible();
    expect((await reviewDueBtn.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await reviewDueBtn.click();
    await expect(page).toHaveURL(/\/play\/practice\?track=trivia-anime-characters/);
    await expect(page.locator(".prompt-text")).toBeVisible();

    // Check 360x740 mobile layout: grouped Languages + 4 subrows + 3 trivia tracks, >= 44px buttons, 0 horizontal overflow & stacking
    await page.getByRole("button", { name: "Mastery", exact: true }).click();
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(page.getByRole("heading", { name: /My Mastery Dashboard/i })).toBeVisible();
    await expect(page.getByTestId("mastery-languages-group")).toBeVisible();
    await expect(page.getByTestId("mastery-subrow-phrases-en-ko")).toBeVisible();
    await expect(page.getByTestId("mastery-subrow-phrases-ja-en")).toBeVisible();
    expect((await page.getByTestId("review-due-cta").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    const mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(mobileOverflow).toBe(false);
    const mPrimary = await page.locator(".bento-primary").boundingBox();
    const mCompanion = await page.locator(".bento-companion").boundingBox();
    expect(mCompanion!.y).toBeGreaterThan(mPrimary!.y);

    // Export sync code & reject corrupted checksum
    await page.getByRole("button", { name: "Generate Sync Code" }).click();
    const syncVal = await page.locator("#sync-code-output").inputValue();
    expect(syncVal.startsWith("BP1.")).toBe(true);

    const decodedJson = Buffer.from(syncVal.slice(4), "base64url").toString("utf8");
    const parsed = JSON.parse(decodedJson) as { checksum: string };
    const tampered = {
      ...parsed,
      checksum: (parsed.checksum.startsWith("a") ? "b" : "a") + parsed.checksum.slice(1),
    };
    await page.locator("#import-backup-input").fill(JSON.stringify(tampered));
    await page.getByRole("button", { name: /Verify & Merge Backup/i }).click();
    await expect(page.getByRole("alert")).toContainText(/Checksum verification failed/i);
  });

  test("TEST-003, TEST-004, TEST-005: Live Sync via 4-card RoomNew UI, min-2-players guard, distinct colors, sync reveal, feedback & Ready gate", async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const guestContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();

    const preRevealResponses: string[] = [];
    guestPage.on("response", async (res) => {
      if (res.url().includes("/api/rooms/")) {
        try {
          preRevealResponses.push(await res.text());
        } catch {
          // Ignore stream bodies
        }
      }
    });

    await hostPage.goto("/room/new");
    await hostPage.getByTestId("room-category-card-languages").click();
    await expect(hostPage.getByTestId("room-category-card-languages")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(hostPage.getByTestId("room-languages-config-cue")).toContainText("EN -> KO");
    await hostPage.locator("#host-display-name").fill("Devon");
    await hostPage.getByRole("button", { name: /Create Room/i }).click();

    await expect(hostPage).toHaveURL(/\/room\/[A-Z2-9]{6}/, { timeout: 20_000 });
    const roomUrl = hostPage.url();

    // Min 2 players guard: Start Round 1 disabled & notice visible while alone
    await expect(hostPage.getByTestId("min-players-notice")).toBeVisible();
    await expect(hostPage.getByRole("button", { name: "Start Round 1" })).toBeDisabled();

    // Guest joins via shared link in <= 2 taps
    await guestPage.goto(roomUrl);
    await guestPage.locator("#guest-display-name").fill("Maya");
    await guestPage.getByRole("button", { name: "Join Room" }).click();
    await expect(guestPage.getByText("Waiting in Lobby")).toBeVisible();

    // Distinct player color avatars rendered in lobby & Start Round 1 now enabled
    await expect(hostPage.locator(".player-color-0")).toBeVisible();
    await expect(hostPage.locator(".player-color-1")).toBeVisible();
    await expect(hostPage.getByRole("button", { name: "Start Round 1" })).toBeEnabled();

    // Host starts Round 1
    await hostPage.getByRole("button", { name: "Start Round 1" }).click();
    await expect(hostPage.locator(".prompt-text")).toBeVisible();
    await expect(guestPage.locator(".prompt-text")).toBeVisible();
    // Romanization shown under Korean options for en-ko
    await expect(guestPage.locator(".option-romanization").first()).toBeVisible();

    // TEST-005: No pre-reveal answer key leaked to guest before submission/reveal
    for (const payload of preRevealResponses) {
      expect(payload).not.toContain("correct_index");
    }

    // Host submits first -> synchronized reveal waits on Guest!
    await hostPage.locator(".option-btn").first().click();
    await expect(hostPage.getByTestId("locked-in-waiting")).toBeVisible();
    await expect(hostPage.getByText("Round 1 Revealed", { exact: true })).toHaveCount(0);

    // TEST-004: Guest reloads mid-round and recovers exact state via saved playerToken
    await guestPage.reload();
    await expect(guestPage.locator(".prompt-text")).toBeVisible();

    // Guest submits -> triggers simultaneous reveal & unmistakable feedback on both
    await guestPage.locator(".option-btn").first().click();

    await expect(hostPage.getByText("Round 1 Revealed", { exact: true })).toBeVisible();
    await expect(guestPage.getByText("Round 1 Revealed", { exact: true })).toBeVisible();
    await expect(hostPage.getByTestId("reveal-verdict-banner")).toBeVisible();
    await expect(guestPage.getByTestId("reveal-verdict-banner")).toBeVisible();

    // Synchronized Ready Gate: Host clicks Ready -> waits on Guest -> Guest clicks Ready -> Round 2!
    await hostPage.getByRole("button", { name: "Ready for next round" }).click();
    await expect(hostPage.getByTestId("waiting-ready-banner")).toBeVisible();
    await expect(guestPage.getByText("Card 2 / 5")).toHaveCount(0);

    await guestPage.getByRole("button", { name: "Ready for next round" }).click();
    await expect(hostPage.getByText("Card 2 / 5")).toBeVisible();
    await expect(guestPage.getByText("Card 2 / 5")).toBeVisible();

    await hostContext.close();
    await guestContext.close();
  });

  test("TEST-003 (24h Async): Self-paced 5-card run via 4-card RoomNew UI with instant feedback & group standings", async ({
    page,
  }) => {
    await page.goto("/room/new");
    await page.getByTestId("room-category-card-trivia-anime-characters").click();
    await expect(page.getByTestId("room-category-card-trivia-anime-characters")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await page.getByRole("button", { name: /24h Micro-Async/i }).click();
    await page.locator("#host-display-name").fill("Sam");
    await page.getByRole("button", { name: /Create Room/i }).click();

    await expect(page).toHaveURL(/\/room\/[A-Z2-9]{6}/);
    for (let r = 0; r < 5; r++) {
      await expect(page.locator(".prompt-text")).toBeVisible();
      await page.locator(".option-btn").first().click();
      await expect(page.locator(".banner")).toBeVisible();
      await page.getByRole("button", { name: /Next Card|View Group Standings/i }).click();
    }

    await expect(page.getByRole("heading", { name: /24h Async Run Complete/i })).toBeVisible();
    await expect(page.getByTestId("share-preview")).toBeVisible();
  });

  test("TEST-008: Quota shedding 503 response via 4-card RoomNew UI shows friendly Solo Daily fallback", async ({
    page,
  }) => {
    await page.route("**/api/rooms", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "DAILY_QUOTA_REACHED",
          fallback: "solo",
          resetAtUtc: "2026-11-20T00:00:00.000Z",
          error:
            "Live rooms are at today's free-tier safety capacity. Solo Daily & Practice remain 100% available offline/locally.",
        }),
      });
    });

    await page.goto("/room/new");
    await page.getByTestId("room-category-card-languages").click();
    await page.locator("#host-display-name").fill("Devon");
    await page.getByRole("button", { name: /Create Room/i }).click();

    await expect(page.getByTestId("quota-fallback-banner")).toBeVisible();
    await page.getByRole("button", { name: /Play Solo Daily/i }).click();
    await expect(page).toHaveURL(/\/play\/daily/);
    await expect(page.locator(".prompt-text")).toBeVisible();
  });

  test("About route displays Zero-PII, Who's That Anime? story role credits (no voice clues) & open corpora attribution", async ({
    page,
  }) => {
    await page.goto("/about");
    await expect(page.getByText(/Tatoeba Project/i)).toBeVisible();
    await expect(page.getByText(/CC BY 2.0 FR/i)).toBeVisible();
    await expect(page.getByRole("link", { name: "OpenTriviaDB", exact: true })).toBeVisible();
    await expect(page.getByText(/Who's That Anime\?/i)).toBeVisible();
    await expect(page.getByText(/story role/i)).toBeVisible();
    await expect(page.getByText(/voice clues/i)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "AniList" }).first()).toBeVisible();
    await expect(page.getByText(/Kitsu/i)).toBeVisible();
  });

  test("ISS-DEV-017: Data-Access Notice popup visible on 1280px & 360px, dismissible & persistent across reload", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    const notice = page.getByTestId("data-access-notice");
    const dismissBtn = page.getByTestId("data-notice-dismiss");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/Local-first privacy:/i);
    await expect(notice).toContainText(/IndexedDB/i);
    await expect(notice).toContainText(/48h/i);
    await expect(dismissBtn).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    ).toBe(false);

    await page.setViewportSize({ width: 360, height: 740 });
    await expect(notice).toBeVisible();
    const noticeBox = await notice.boundingBox();
    expect(noticeBox).not.toBeNull();
    expect(noticeBox!.x).toBeGreaterThanOrEqual(0);
    expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(360);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    ).toBe(false);

    // Rework Loop 2 regression check: scrolling to bottom at 360px keeps .app-footer clear above the data-notice dock
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const footerBox = await page.locator(".app-footer").boundingBox();
    const dockCardBox = await notice.locator(".data-notice-card").boundingBox();
    expect(footerBox).not.toBeNull();
    expect(dockCardBox).not.toBeNull();
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(dockCardBox!.y);

    await dismissBtn.click();
    await expect(notice).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("heading", { name: /Today's 5-Card Ritual/i })).toBeVisible();
    await expect(page.getByTestId("data-access-notice")).toHaveCount(0);
  });

  test("ISS-DEV-015 (Solo): Unanswered Card 1 leaves freely; mid-round Leave opens ConfirmLeaveModal with Stay, Escape & Leave Anyway + GPU classes + 0 /api/", async ({
    page,
  }) => {
    const apiRequests: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.startsWith("/api/")) {
        apiRequests.push(req.url());
      }
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.locator(".route-stage")).toBeVisible();

    // Card 1 before answering leaves freely without ConfirmLeaveModal
    await page.getByRole("button", { name: /Play Today's 5/i }).click();
    await expect(page.locator(".prompt-text")).toBeVisible();
    await expect(page.locator(".card-stage")).toBeVisible();

    const animInfo = await page.evaluate(() => {
      const routeEl = document.querySelector(".route-stage");
      const cardEl = document.querySelector(".card-stage");
      return {
        routeAnim: routeEl ? getComputedStyle(routeEl).animationName : "none",
        cardAnim: cardEl ? getComputedStyle(cardEl).animationName : "none",
      };
    });
    expect(animInfo.routeAnim).not.toBe("none");
    expect(animInfo.cardAnim).not.toBe("none");

    await page.getByTestId("solo-leave-btn").click();
    await expect(page.getByTestId("confirm-leave-dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: /Today's 5-Card Ritual/i })).toBeVisible();

    // Start round again, answer Card 1 -> Leave button opens ConfirmLeaveModal
    await page.getByRole("button", { name: /Play Today's 5/i }).click();
    await expect(page.locator(".prompt-text")).toBeVisible();
    await page.locator(".option-btn").first().click();
    await expect(page.getByTestId("solo-feedback-banner")).toBeVisible();

    await page.getByTestId("solo-leave-btn").click();
    const dialog = page.getByTestId("confirm-leave-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Leave current session?");
    await expect(dialog).toContainText("Unfinished round progress will be lost");

    // "Stay in Game" closes modal and preserves round progress
    await page.getByTestId("leave-stay-btn").click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/play\/daily/);
    await expect(page.getByTestId("solo-feedback-banner")).toBeVisible();

    // Advance to Card 2, open modal, verify Escape closes modal to Stay
    await page.getByRole("button", { name: /Next Card/i }).click();
    await expect(page.getByText("2/5", { exact: true })).toBeVisible();
    await page.getByTestId("solo-leave-btn").click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/play\/daily/);
    await expect(page.getByText("2/5", { exact: true })).toBeVisible();

    // Re-open modal and click "Leave Anyway" -> navigates cleanly to Hub
    await page.getByTestId("solo-leave-btn").click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("leave-confirm-btn").click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: /Today's 5-Card Ritual/i })).toBeVisible();

    expect(apiRequests).toEqual([]);
  });

  test("ISS-DEV-015 (Live Sync): Guest leaving mid-round via ConfirmLeaveModal unblocks remaining Host cleanly", async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const guestContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();

    await hostPage.goto("/room/new");
    await hostPage.getByTestId("room-category-card-trivia-anime").click();
    await hostPage.locator("#host-display-name").fill("HostA");
    await hostPage.getByRole("button", { name: /Create Room/i }).click();
    await expect(hostPage).toHaveURL(/\/room\/[A-Z2-9]{6}/, { timeout: 20_000 });
    const roomUrl = hostPage.url();

    await guestPage.goto(roomUrl);
    await guestPage.locator("#guest-display-name").fill("GuestB");
    await guestPage.getByRole("button", { name: "Join Room" }).click();
    await expect(guestPage.getByText("Waiting in Lobby")).toBeVisible();

    await expect(hostPage.getByRole("button", { name: "Start Round 1" })).toBeEnabled();
    await hostPage.getByRole("button", { name: "Start Round 1" }).click();
    await expect(hostPage.locator(".prompt-text")).toBeVisible();
    await expect(guestPage.locator(".prompt-text")).toBeVisible();

    // Host locks in answer and waits on Guest
    await hostPage.locator(".option-btn").first().click();
    await expect(hostPage.getByTestId("locked-in-waiting")).toBeVisible();

    // Guest leaves mid-round via ConfirmLeaveModal
    await guestPage.getByTestId("room-leave-btn").click();
    const guestDialog = guestPage.getByTestId("confirm-leave-dialog");
    await expect(guestDialog).toBeVisible();
    await expect(guestDialog).toContainText("Leave current session?");
    await expect(guestDialog).toContainText("Unfinished round progress will be lost");
    await guestPage.getByTestId("leave-confirm-btn").click();
    await expect(guestPage).toHaveURL(/\/$/);

    // Remaining Host is NOT stuck waiting: Round 1 reveals and Ready advances to Card 2 / 5
    await expect(hostPage.getByText("Round 1 Revealed", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(hostPage.getByTestId("reveal-verdict-banner")).toBeVisible();
    await hostPage.getByRole("button", { name: "Ready for next round" }).click();
    await expect(hostPage.getByText("Card 2 / 5")).toBeVisible({ timeout: 15_000 });

    await hostContext.close();
    await guestContext.close();
  });

  test("ISS-DEV-016 & ISS-DEV-018: Mastery legend pills, 360px/1280px overflow, malformed BP1.invalid recovery, footer & /about ownership", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    // Record 1 card so Mastery state is non-empty before testing malformed backup import
    await page.getByRole("button", { name: /Play Today's 5/i }).click();
    await expect(page.locator(".prompt-text")).toBeVisible();
    await page.locator(".option-btn").first().click();
    await expect(page.getByTestId("solo-feedback-banner")).toBeVisible();

    // Navigate via ConfirmLeaveModal to Mastery
    await page.getByRole("button", { name: "Mastery", exact: true }).click();
    await expect(page.getByTestId("confirm-leave-dialog")).toBeVisible();
    await page.getByTestId("leave-confirm-btn").click();

    await expect(page.getByRole("heading", { name: /My Mastery Dashboard/i })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    ).toBe(false);

    // Legend pills & tier summary visible
    const legend = page.locator(".legend-row");
    await expect(legend).toBeVisible();
    await expect(legend).toContainText("Mastered");
    await expect(legend).toContainText("Familiar");
    await expect(legend).toContainText("Learning");

    const cardsLearnedTile = page.locator(".stat-tile", { hasText: "Cards Learned" });
    await expect(cardsLearnedTile.locator(".stat-num")).toHaveText("1");

    // Malformed BP1.invalid import displays error without wiping local state, Clear Input resets cleanly
    const importBox = page.locator("#import-backup-input");
    await importBox.fill("BP1.invalid");
    await page.getByRole("button", { name: /Verify & Merge Backup/i }).click();
    const errAlert = page.getByRole("alert");
    await expect(errAlert).toBeVisible();
    await expect(cardsLearnedTile.locator(".stat-num")).toHaveText("1");

    await page.getByTestId("clear-import-btn").click();
    await expect(importBox).toHaveValue("");
    await expect(errAlert).toHaveCount(0);

    // 360px mobile zero horizontal overflow on /mastery
    await page.setViewportSize({ width: 360, height: 740 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    ).toBe(false);

    // Subtle footer & /about ownership/licenses
    const footer = page.locator(".app-footer");
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("Dwight Jairo Pingul");
    await expect(footer).toContainText("@yatoyataro");
    await expect(footer).toContainText("MIT Licensed App");

    await footer.getByRole("button", { name: /Privacy & Licenses/i }).click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.getByRole("heading", { name: /Application License & Ownership/i })).toBeVisible();
    await expect(page.locator("main")).toContainText("Dwight Jairo Pingul");
    await expect(page.locator("main")).toContainText("@yatoyataro");
    await expect(page.locator("main")).toContainText("MIT License");
    await expect(page.locator("main")).toContainText("CC BY 2.0 FR");
    await expect(page.locator("main")).toContainText("CC BY-SA 4.0");
    await expect(page.locator("main")).toContainText("PUBLIC-FACTUAL-API");
  });

  test("ISS-DEV-019: Invalid room /room/BAD1 blocker CTAs, 429 rate-limit Solo fallback & 24h Async keyboard guard", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    // Invalid room code renders blocker with working CTAs (zero blank screen)
    await page.goto("/room/BAD1");
    const blocker = page.getByTestId("room-blocker-invalid_code");
    await expect(blocker).toBeVisible();
    await expect(blocker).toContainText("Invalid room code");
    await blocker.getByRole("button", { name: "Start a Fresh Room" }).click();
    await expect(page).toHaveURL(/\/room\/new$/);

    await page.goto("/room/BAD1");
    await expect(blocker).toBeVisible();
    await blocker.getByRole("button", { name: "Play Solo Daily" }).click();
    await expect(page).toHaveURL(/\/$/);

    // 429 RATE_LIMITED on /room/new renders cooldown & Solo fallback cleanly
    await page.route("**/api/rooms", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 429,
          contentType: "application/json",
          body: JSON.stringify({
            code: "RATE_LIMITED",
            retryAfterSec: 45,
            error: "Too many room creations from this connection. Please wait or play Solo.",
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/room/new");
    await page.locator("#host-display-name").fill("Devon");
    await page.getByRole("button", { name: /Create Room/i }).click();
    await expect(page.getByTestId("room-rate-countdown")).toContainText("Try again in 45s.");
    await page.getByRole("button", { name: /Play Solo Daily/i }).click();
    await expect(page).toHaveURL(/\/play\/daily/);
    await expect(page.locator(".prompt-text")).toBeVisible();

    // Unroute 429 mock so 24h Async room creation hits live local Worker
    await page.unroute("**/api/rooms");

    // 24h Async feedback keyboard guard: pressing '2' while asyncStepReveal is visible must NOT auto-submit next card
    await page.goto("/room/new");
    await page.getByTestId("room-category-card-trivia-anime").click();
    await page.getByRole("button", { name: /24h Micro-Async/i }).click();
    await page.locator("#host-display-name").fill("Jordan");
    await page.getByRole("button", { name: /Create Room/i }).click();

    await expect(page).toHaveURL(/\/room\/[A-Z2-9]{6}/, { timeout: 20_000 });
    await expect(page.getByText("Card 1 / 5")).toBeVisible();
    await page.locator(".option-btn").first().click();

    const asyncFeedback = page.getByLabel("Async card feedback");
    await expect(asyncFeedback).toBeVisible();
    const nextBtn = page.getByRole("button", { name: "Next Card (2/5)" });
    await expect(nextBtn).toBeVisible();

    // Press key "2" while feedback banner is shown -> must stay on feedback, NOT advance/submit Card 2
    await page.keyboard.press("2");
    await page.waitForTimeout(300);
    await expect(asyncFeedback).toBeVisible();
    await expect(nextBtn).toBeVisible();

    // Clicking Next Card (2/5) reveals Card 2 / 5 unanswered with enabled option buttons
    await nextBtn.click();
    await expect(page.getByText("Card 2 / 5")).toBeVisible();
    await expect(page.locator(".option-btn").first()).toBeEnabled();
    await expect(page.getByLabel("Async card feedback")).toHaveCount(0);
  });
});
