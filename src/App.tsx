import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ConfirmLeaveModal, type LeaveGuardConfig } from "./components/ConfirmLeaveModal.tsx";
import { DataAccessNotice } from "./components/DataAccessNotice.tsx";
import { lazyComponent } from "./core/lazyRoute.tsx";
import { computeMomentumStats, getLocalDateIso } from "./core/mastery.ts";
import { loadUserPreferences, resolveSubtrackId, saveUserPreferences } from "./core/options.ts";
import { loadPackCatalog } from "./core/packsClient.ts";
import {
  createLocalStore,
  dismissDataNotice,
  isDataNoticeDismissed,
  type LocalStore,
} from "./core/storage.ts";
import type {
  LocalActiveDay,
  LocalMasteryItem,
  PackCatalog,
  UserPreferencesV1,
} from "./core/types.ts";
import { PlayHub } from "./routes/PlayHub.tsx";

const SoloRunner = lazyComponent(
  () => import("./routes/SoloRunner.tsx").then((m) => m.SoloRunner),
  "Loading round runner"
);
const RoomNew = lazyComponent(
  () => import("./routes/RoomNew.tsx").then((m) => m.RoomNew),
  "Loading room creator"
);
const RoomPlay = lazyComponent(
  () => import("./routes/RoomPlay.tsx").then((m) => m.RoomPlay),
  "Loading multiplayer room"
);
const MasteryView = lazyComponent(
  () => import("./routes/MasteryView.tsx").then((m) => m.MasteryView),
  "Loading mastery dashboard"
);
const AboutView = lazyComponent(
  () => import("./routes/AboutView.tsx").then((m) => m.AboutView),
  "Loading about and credits"
);

function parseLocation() {
  const path = window.location.pathname || "/";
  const search = window.location.search || "";
  const params = new URLSearchParams(search);
  return { path, search, track: params.get("track") };
}

export function App() {
  const [loc, setLoc] = useState(parseLocation);
  const [catalog, setCatalog] = useState<PackCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<UserPreferencesV1>(() => loadUserPreferences());
  const [store, setStore] = useState<LocalStore | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [dataNoticeOpen, setDataNoticeOpen] = useState<boolean>(() => !isDataNoticeDismissed());
  const [leaveGuard, setLeaveGuard] = useState<LeaveGuardConfig | null>(null);
  const [pendingLeaveAction, setPendingLeaveAction] = useState<{
    run: () => void | Promise<void>;
  } | null>(null);
  const [masteryItems, setMasteryItems] = useState<LocalMasteryItem[]>([]);
  const [activeDays, setActiveDays] = useState<LocalActiveDay[]>([]);

  const leaveGuardRef = useRef<LeaveGuardConfig | null>(null);
  const currentUrlRef = useRef<string>(`${loc.path}${loc.search}`);

  const setLeaveGuardStable = useCallback((guard: LeaveGuardConfig | null) => {
    leaveGuardRef.current = guard;
    setLeaveGuard(guard);
    if (!guard?.active) {
      setPendingLeaveAction(null);
    }
  }, []);

  const navigateImmediate = useCallback((to: string) => {
    window.history.pushState({}, "", to);
    const next = parseLocation();
    currentUrlRef.current = `${next.path}${next.search}`;
    setLoc(next);
  }, []);

  const requestNavigate = useCallback(
    (to: string) => {
      if (leaveGuardRef.current?.active && to !== currentUrlRef.current) {
        setPendingLeaveAction({ run: () => navigateImmediate(to) });
        return;
      }
      navigateImmediate(to);
    },
    [navigateImmediate]
  );

  const requestGuardedAction = useCallback((action: () => void | Promise<void>) => {
    if (leaveGuardRef.current?.active) {
      setPendingLeaveAction({ run: action });
      return;
    }
    void action();
  }, []);

  const handleChangePrefs = (patch: Partial<Omit<UserPreferencesV1, "schema_version">>) => {
    setPrefs(saveUserPreferences(patch));
  };

  const fetchCatalog = () => {
    setCatalogError(null);
    loadPackCatalog()
      .then((c) => {
        setCatalog(c);
      })
      .catch((err) => {
        setCatalogError(err instanceof Error ? err.message : "Failed to load packs.");
      });
  };

  useEffect(() => {
    fetchCatalog();
    createLocalStore((reason) => setStorageWarning(reason)).then(async (s) => {
      setStore(s);
      const data = await s.loadAll();
      setMasteryItems(data.mastery);
      setActiveDays(data.activeDays);
    });

    const onPop = () => {
      const dest = `${window.location.pathname || "/"}${window.location.search || ""}`;
      if (leaveGuardRef.current?.active && dest !== currentUrlRef.current) {
        window.history.pushState({}, "", currentUrlRef.current);
        setPendingLeaveAction({ run: () => navigateImmediate(dest) });
        return;
      }
      const next = parseLocation();
      currentUrlRef.current = `${next.path}${next.search}`;
      setLoc(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [navigateImmediate]);

  useEffect(() => {
    if (!leaveGuard?.active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [leaveGuard?.active]);

  const handleConfirmLeave = async () => {
    const guard = leaveGuardRef.current;
    const pending = pendingLeaveAction;
    setPendingLeaveAction(null);
    setLeaveGuardStable(null);
    try {
      await guard?.onConfirmLeave?.();
    } catch {
      // Do not trap user if leave cleanup fails
    }
    if (pending) {
      await pending.run();
    }
  };

  const masteryMap = useMemo(
    () => new Map(masteryItems.map((m) => [m.item_id, m])),
    [masteryItems]
  );

  const momentum = useMemo(
    () => computeMomentumStats(activeDays, masteryItems, getLocalDateIso()),
    [activeDays, masteryItems]
  );

  const resolvedPrefTrack = resolveSubtrackId(prefs.selectedCategory, prefs.languageSubtrack);
  const activeTrack = loc.track ?? resolvedPrefTrack;

  const handleRecordAnswer = async (
    updated: LocalMasteryItem,
    completedRoundGrid?: string,
    isCorrect?: boolean
  ) => {
    const today = getLocalDateIso();
    setMasteryItems((prev) => {
      const map = new Map(prev.map((m) => [m.item_id, m]));
      map.set(updated.item_id, updated);
      return Array.from(map.values());
    });
    await store?.saveMasteryItems([updated]);

    const existingDay = activeDays.find((d) => d.local_date === today);
    const updatedDay: LocalActiveDay = {
      local_date: today,
      cards_completed: (existingDay?.cards_completed ?? 0) + 1,
      correct_count: (existingDay?.correct_count ?? 0) + (isCorrect ? 1 : 0),
      attempt_count: (existingDay?.attempt_count ?? 0) + (isCorrect !== undefined ? 1 : 0),
      daily_grid_summary: completedRoundGrid ?? existingDay?.daily_grid_summary,
      subtrack_id: updated.subtrack_id,
    };
    setActiveDays((prev) => {
      const map = new Map(prev.map((d) => [d.local_date, d]));
      map.set(today, updatedDay);
      return Array.from(map.values());
    });
    await store?.saveActiveDay(updatedDay);
  };

  const handleFlagLocally = async (itemId: string) => {
    const cur = masteryMap.get(itemId);
    const updated: LocalMasteryItem = cur
      ? { ...cur, flagged_hidden: true, updated_at: new Date().toISOString() }
      : {
          item_id: itemId,
          subtrack_id: activeTrack,
          tier: "New",
          streak_count: 0,
          next_due_date: getLocalDateIso(),
          updated_at: new Date().toISOString(),
          flagged_hidden: true,
        };
    setMasteryItems((prev) => {
      const map = new Map(prev.map((m) => [m.item_id, m]));
      map.set(itemId, updated);
      return Array.from(map.values());
    });
    await store?.saveMasteryItems([updated]);
  };

  const handleReplaceAll = async (nextMastery: LocalMasteryItem[], nextDays: LocalActiveDay[]) => {
    setMasteryItems(nextMastery);
    setActiveDays(nextDays);
    await store?.replaceAll(nextMastery, nextDays);
  };

  let page;
  if (loc.path === "/play/daily") {
    page = (
      <div class="play-stage">
        <SoloRunner
          key={`${loc.path}${loc.search}`}
          mode="daily"
          subtrackId={activeTrack}
          search={loc.search}
          catalog={catalog}
          masteryMap={masteryMap}
          onRecordAnswer={handleRecordAnswer}
          onFlagItemLocally={handleFlagLocally}
          onNavigate={requestNavigate}
          onSetLeaveGuard={setLeaveGuardStable}
          onRequestLeaveAction={requestGuardedAction}
        />
      </div>
    );
  } else if (loc.path === "/play/practice") {
    page = (
      <div class="play-stage">
        <SoloRunner
          key={`${loc.path}${loc.search}`}
          mode="practice"
          subtrackId={activeTrack}
          search={loc.search}
          catalog={catalog}
          masteryMap={masteryMap}
          onRecordAnswer={handleRecordAnswer}
          onFlagItemLocally={handleFlagLocally}
          onNavigate={requestNavigate}
          onSetLeaveGuard={setLeaveGuardStable}
          onRequestLeaveAction={requestGuardedAction}
        />
      </div>
    );
  } else if (loc.path === "/room/new") {
    page = (
      <div class="play-stage">
        <RoomNew
          catalog={catalog}
          defaultTrack={activeTrack}
          search={loc.search}
          prefs={prefs}
          onChangePrefs={handleChangePrefs}
          onNavigate={requestNavigate}
        />
      </div>
    );
  } else if (loc.path.startsWith("/room/")) {
    const code = loc.path.slice("/room/".length).split("/")[0] ?? "";
    page = (
      <RoomPlay
        roomCode={code}
        onNavigate={requestNavigate}
        onForceNavigate={navigateImmediate}
        onSetLeaveGuard={setLeaveGuardStable}
      />
    );
  } else if (loc.path === "/mastery") {
    page = (
      <MasteryView
        storageMode={store?.mode ?? "indexeddb"}
        storageWarning={storageWarning}
        onDismissStorageWarning={() => setStorageWarning(null)}
        catalog={catalog}
        masteryItems={masteryItems}
        activeDays={activeDays}
        momentum={momentum}
        prefs={prefs}
        onReplaceAll={handleReplaceAll}
        onNavigate={requestNavigate}
      />
    );
  } else if (loc.path === "/about") {
    page = (
      <div class="play-stage">
        <AboutView catalog={catalog} />
      </div>
    );
  } else {
    page = (
      <PlayHub
        catalog={catalog}
        catalogError={catalogError}
        storageWarning={storageWarning}
        onDismissStorageWarning={() => setStorageWarning(null)}
        prefs={prefs}
        onChangePrefs={handleChangePrefs}
        momentum={momentum}
        onNavigate={requestNavigate}
        onRetryCatalog={fetchCatalog}
      />
    );
  }

  return (
    <div class={`app-shell ${dataNoticeOpen ? "has-data-notice" : ""}`}>
      <header class="topbar">
        <button type="button" class="brand-btn" onClick={() => requestNavigate("/")}>
          <span class="brand-mark" aria-hidden="true">
            B
          </span>
          <span>BrainPlay</span>
        </button>
        <nav class="nav-links" aria-label="Primary navigation">
          <button
            type="button"
            class="nav-link"
            aria-current={loc.path === "/" ? "page" : undefined}
            onClick={() => requestNavigate("/")}
          >
            Play
          </button>
          <button
            type="button"
            class="nav-link"
            aria-current={loc.path === "/mastery" ? "page" : undefined}
            onClick={() => requestNavigate("/mastery")}
          >
            Mastery
          </button>
          <button
            type="button"
            class="nav-link"
            aria-current={loc.path === "/about" ? "page" : undefined}
            onClick={() => requestNavigate("/about")}
          >
            About
          </button>
        </nav>
      </header>
      <main>
        <div key={loc.path} class="route-stage">
          {page}
        </div>
      </main>
      <footer class="app-footer">
        <span>
          BrainPlay &middot; MIT Licensed App &middot; Copyright &copy; 2026 Dwight Jairo Pingul (
          <a
            href="https://github.com/yatoyataro"
            target="_blank"
            rel="noreferrer"
            class="footer-link"
          >
            @yatoyataro
          </a>
          )
        </span>
        <button type="button" class="btn-link" onClick={() => requestNavigate("/about")}>
          Privacy &amp; Licenses
        </button>
      </footer>
      <DataAccessNotice
        visible={dataNoticeOpen}
        onDismiss={() => {
          dismissDataNotice();
          setDataNoticeOpen(false);
        }}
        onOpenPrivacy={() => requestNavigate("/about")}
      />
      <ConfirmLeaveModal
        open={Boolean(pendingLeaveAction && leaveGuard?.active)}
        context={leaveGuard?.context ?? "solo"}
        roomCode={leaveGuard?.roomCode}
        onStay={() => setPendingLeaveAction(null)}
        onConfirmLeave={() => void handleConfirmLeave()}
      />
    </div>
  );
}
