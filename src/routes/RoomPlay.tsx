import { useEffect, useRef, useState } from "preact/hooks";
import type { LeaveGuardConfig, LeaveGuardContext } from "../components/ConfirmLeaveModal.tsx";
import { lazyComponent } from "../core/lazyRoute.tsx";
import { isLanguageTrack } from "../core/options.ts";
import {
  ApiRequestError,
  apiHydrateRoom,
  apiJoinRoom,
  apiLeaveRoom,
  apiMarkReady,
  apiStartRound,
  apiSubmitAnswer,
  buildRoomWsUrl,
  clearSavedRoomToken,
  getOrCreateRoundIdempotencyKey,
  getSavedRoomToken,
} from "../core/roomClient.ts";
import { buildEmojiRow, buildSpoilerFreeShareText } from "../core/shareGrid.ts";
import type {
  ClientRoomHydration,
  PublicRoomQuestion,
  RomajiDisplayMode,
  RoomWsServerEvent,
  RoundRevealPayload,
} from "../core/types.ts";

const LazyShareBox = lazyComponent(
  () => import("../components/ShareModal.tsx").then((m) => m.ShareBox),
  "Loading share box"
);

interface RoomPlayProps {
  roomCode: string;
  onNavigate: (path: string) => void;
  onForceNavigate?: (path: string) => void;
  onSetLeaveGuard?: (guard: LeaveGuardConfig | null) => void;
}

type RoomBlocker =
  | { kind: "invalid_code" }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "full" }
  | { kind: "already_started" }
  | { kind: "completed" }
  | { kind: "quota"; resetAtUtc?: string; message: string }
  | { kind: "origin"; message: string }
  | { kind: "network"; message: string };

const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const FATAL_WS_CLOSE_CODES = new Set([1008, 4001, 4401, 4004, 4404]);
const MAX_WS_RECONNECT_ATTEMPTS = 5;

function playerInitial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

export function RoomPlay({
  roomCode,
  onNavigate,
  onForceNavigate,
  onSetLeaveGuard,
}: RoomPlayProps) {
  const code = roomCode.toUpperCase();
  const isValidCode = ROOM_CODE_RE.test(code);
  const [token, setToken] = useState<string | null>(() =>
    isValidCode ? getSavedRoomToken(code) : null
  );
  const [hydration, setHydration] = useState<ClientRoomHydration | null>(null);
  const [guestName, setGuestName] = useState("");
  const [loading, setLoading] = useState<boolean>(() =>
    Boolean(isValidCode && getSavedRoomToken(code))
  );
  const [roomBlocker, setRoomBlocker] = useState<RoomBlocker | null>(() =>
    isValidCode ? null : { kind: "invalid_code" }
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [retryAfterSec, setRetryAfterSec] = useState<number | null>(null);
  const [hydrateNonce, setHydrateNonce] = useState(0);
  const [wsNonce, setWsNonce] = useState(0);
  const [connState, setConnState] = useState<"connected" | "reconnecting" | "paused" | "http">(
    "http"
  );
  const [inviteCopied, setInviteCopied] = useState(false);
  const [chosenOpt, setChosenOpt] = useState<number | null>(null);
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [liveReveal, setLiveReveal] = useState<RoundRevealPayload | null>(null);
  const [revealedQuestion, setRevealedQuestion] = useState<PublicRoomQuestion | null>(null);
  const [asyncStepReveal, setAsyncStepReveal] = useState<RoundRevealPayload | null>(null);
  const [readySubmitting, setReadySubmitting] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const wsClosedByUserRef = useRef(false);
  const lastQuestionRef = useRef<PublicRoomQuestion | null>(null);
  const hydrationRef = useRef<ClientRoomHydration | null>(hydration);
  hydrationRef.current = hydration;
  const leaveCallbackRef = useRef<() => Promise<void>>(async () => {});

  const applyHydration = (h: ClientRoomHydration) => {
    setRoomBlocker(null);
    const prev = hydrationRef.current;
    if (prev && prev.room_code === h.room_code && prev.pacing_mode === "live") {
      if (prev.status === "completed" && h.status !== "completed") return;
      if (prev.completed_reveals.length > h.completed_reveals.length) return;
      if (
        h.current_question &&
        prev.completed_reveals.some((r) => r.round_index === h.current_question!.round_index)
      ) {
        return;
      }
    }
    if (h.current_question) {
      lastQuestionRef.current = h.current_question;
    }
    const curRound = h.current_question?.round_index ?? h.current_round;
    const latestReveal = h.completed_reveals.find((r) => r.round_index === curRound) ?? null;
    if (h.pacing_mode === "live" && h.round_phase === "reveal" && h.completed_reveals.length > 0) {
      setLiveReveal(h.completed_reveals[h.completed_reveals.length - 1] ?? null);
      if (lastQuestionRef.current) setRevealedQuestion(lastQuestionRef.current);
    } else if (latestReveal && h.pacing_mode === "async24h") {
      setLiveReveal(latestReveal);
    } else if (h.current_question) {
      setLiveReveal(null);
    }
    hydrationRef.current = h;
    setHydration(h);
  };

  const mapApiError = (err: unknown, mode: "hydrate" | "join" | "action") => {
    if (err instanceof ApiRequestError) {
      if (err.status === 404 || err.payload.code === "NOT_FOUND") {
        clearSavedRoomToken(code);
        setToken(null);
        setRoomBlocker({ kind: "not_found" });
        return;
      }
      if (err.status === 410 || err.payload.code === "ROOM_EXPIRED") {
        clearSavedRoomToken(code);
        setToken(null);
        setRoomBlocker({ kind: "expired" });
        return;
      }
      if (err.status === 401 || err.payload.code === "UNAUTHORIZED") {
        clearSavedRoomToken(code);
        setToken(null);
        setErrorMsg("Your room session expired. Join again or start a fresh room.");
        return;
      }
      if (err.status === 403) {
        if (err.payload?.code === "ORIGIN_FORBIDDEN") {
          setRoomBlocker({
            kind: "origin",
            message: "Request blocked by origin security check. Reload from the main app URL.",
          });
        } else if (err.payload?.code === "ROOM_LEFT") {
          clearSavedRoomToken(code);
          setToken(null);
          setHydration(null);
          hydrationRef.current = null;
          setErrorMsg(
            err.payload.error ||
              "You already left this live room. Join with a display name if spots remain, or start a fresh room."
          );
        } else {
          clearSavedRoomToken(code);
          setToken(null);
          setHydration(null);
          hydrationRef.current = null;
          setErrorMsg(err.payload?.error || "You are no longer a member of this room.");
        }
        return;
      }
      if (err.status === 409) {
        if (err.payload.code === "ROOM_FULL") {
          setRoomBlocker({ kind: "full" });
          return;
        }
        if (err.payload.code === "ROOM_ALREADY_STARTED") {
          setRoomBlocker({ kind: "already_started" });
          return;
        }
        if (err.payload.code === "ROOM_COMPLETED") {
          setRoomBlocker({ kind: "completed" });
          return;
        }
      }
      if (
        err.status === 503 ||
        err.payload.code === "DAILY_QUOTA_REACHED" ||
        err.payload.code === "SERVICE_UNAVAILABLE" ||
        err.payload.fallback === "solo"
      ) {
        setRoomBlocker({
          kind: "quota",
          resetAtUtc: err.payload.resetAtUtc,
          message: err.payload.error,
        });
        return;
      }
      if (err.status === 429 || err.payload.code === "RATE_LIMITED") {
        setRetryAfterSec(err.payload.retryAfterSec ?? 60);
        setErrorMsg(err.payload.error);
        return;
      }
      if (err.status === 0 || err.payload.code === "NETWORK_ERROR") {
        if (mode === "hydrate" && !hydration) {
          setRoomBlocker({
            kind: "network",
            message: "Could not reach the room server. Check your connection and retry.",
          });
        } else {
          setErrorMsg("Network error — check your connection and try again.");
        }
        return;
      }
      setErrorMsg(err.payload.error || "Room request failed.");
      return;
    }
    setErrorMsg(err instanceof Error ? err.message : "Room request failed.");
  };

  useEffect(() => {
    if (retryAfterSec === null || retryAfterSec <= 0) return;
    const id = window.setInterval(() => {
      setRetryAfterSec((s) => (s !== null && s > 1 ? s - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [retryAfterSec]);

  useEffect(() => {
    if (!isValidCode) {
      setToken(null);
      setLoading(false);
      setRoomBlocker({ kind: "invalid_code" });
      return;
    }
    const saved = getSavedRoomToken(code);
    setToken(saved);
    setRoomBlocker(null);
    if (!saved) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiHydrateRoom(code, saved)
      .then((res) => {
        if (!cancelled) {
          applyHydration(res.hydration);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        mapApiError(err, "hydrate");
      });
    return () => {
      cancelled = true;
    };
  }, [code, isValidCode, hydrateNonce]);

  useEffect(() => {
    if (!token || !isValidCode) return;
    let closedByUser = false;
    wsClosedByUserRef.current = false;
    let retryTimer: number | undefined;
    let attempt = 0;

    const connect = () => {
      try {
        const ws = new WebSocket(buildRoomWsUrl(code, token));
        wsRef.current = ws;
        setConnState(attempt > 0 ? "reconnecting" : "http");

        ws.onopen = () => {
          attempt = 0;
          setConnState("connected");
          setAnnouncement("Connected to room.");
        };

        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(String(evt.data)) as RoomWsServerEvent;
            if (msg.type === "room_state" || msg.type === "room_completed") {
              applyHydration(msg.hydration);
              if (msg.hydration.round_phase === "question") {
                setChosenOpt(null);
                setReadySubmitting(false);
              }
            } else if (msg.type === "round_started") {
              setChosenOpt(null);
              setLiveReveal(null);
              setRevealedQuestion(null);
              setReadySubmitting(false);
              lastQuestionRef.current = msg.question;
              const prev = hydrationRef.current;
              if (prev) {
                const next: ClientRoomHydration = {
                  ...prev,
                  status: "active",
                  round_phase: "question",
                  current_round: msg.question.round_index,
                  round_deadline_at: new Date(msg.deadlineEpochMs).toISOString(),
                  current_question: msg.question,
                  players: prev.players.map((p) => ({
                    ...p,
                    answered_current_round: false,
                    ready_for_next: false,
                  })),
                };
                hydrationRef.current = next;
                setHydration(next);
              }
              setAnnouncement(`Round ${msg.question.round_index + 1} started: ${msg.question.prompt}`);
            } else if (msg.type === "player_progress") {
              const prev = hydrationRef.current;
              if (prev) {
                const next: ClientRoomHydration = {
                  ...prev,
                  players: prev.players.map((p) =>
                    p.player_id === msg.playerId ? { ...p, answered_current_round: true } : p
                  ),
                };
                hydrationRef.current = next;
                setHydration(next);
              }
            } else if (msg.type === "round_revealed") {
              setLiveReveal(msg.reveal);
              if (lastQuestionRef.current) setRevealedQuestion(lastQuestionRef.current);
              setReadySubmitting(false);
              const prev = hydrationRef.current;
              if (prev) {
                const selfRes = msg.reveal.player_results.find(
                  (x) => x.player_id === prev.self_player_id
                );
                const selfRight = selfRes?.chosen_index === msg.reveal.correct_index;
                setAnnouncement(
                  selfRight
                    ? `Round ${msg.reveal.round_index + 1} revealed. Correct!`
                    : `Round ${msg.reveal.round_index + 1} revealed. Your answer was wrong or missed.`
                );
                const next: ClientRoomHydration = {
                  ...prev,
                  round_phase: "reveal",
                  current_question: null,
                  round_deadline_at: null,
                  completed_reveals: [
                    ...prev.completed_reveals.filter((r) => r.round_index !== msg.reveal.round_index),
                    msg.reveal,
                  ],
                  players: prev.players.map((p) => {
                    const pr = msg.reveal.player_results.find((x) => x.player_id === p.player_id);
                    return pr
                      ? { ...p, score: pr.total_score, ready_for_next: false }
                      : { ...p, ready_for_next: false };
                  }),
                };
                hydrationRef.current = next;
                setHydration(next);
              }
            } else if (msg.type === "error") {
              setErrorMsg(msg.message);
            }
          } catch {
            // Ignore malformed message
          }
        };

        ws.onclose = (evt) => {
          if (closedByUser || wsClosedByUserRef.current) return;
          if (FATAL_WS_CLOSE_CODES.has(evt.code)) {
            clearSavedRoomToken(code);
            setToken(null);
            if (evt.code === 4004 || evt.code === 4404) {
              setRoomBlocker({ kind: "not_found" });
            } else {
              setErrorMsg("Room session ended or unauthorized. Join again or start a fresh room.");
            }
            return;
          }
          attempt += 1;
          if (attempt > MAX_WS_RECONNECT_ATTEMPTS) {
            setConnState("paused");
            setAnnouncement("Connection paused. Tap Reconnect to try again.");
            return;
          }
          setConnState("reconnecting");
          setAnnouncement("Reconnecting...");
          const delay = Math.min(8000, 800 * Math.pow(1.6, attempt - 1));
          retryTimer = window.setTimeout(connect, delay);
        };
      } catch {
        setConnState("paused");
      }
    };

    connect();
    return () => {
      closedByUser = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [code, token, isValidCode, wsNonce]);

  useEffect(() => {
    if (!hydration?.round_deadline_at) {
      setSecondsLeft(null);
      return;
    }
    const update = () => {
      const diff = Math.max(0, Math.ceil((Date.parse(hydration.round_deadline_at!) - Date.now()) / 1000));
      setSecondsLeft(diff);
    };
    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, [hydration?.round_deadline_at]);

  const handleJoin = async (e: Event) => {
    e.preventDefault();
    setErrorMsg(null);
    setRetryAfterSec(null);
    const trimmed = guestName.trim();
    if (trimmed.length < 2 || trimmed.length > 20) {
      setErrorMsg("Enter a display name (2 to 20 characters).");
      return;
    }
    setLoading(true);
    try {
      const res = await apiJoinRoom(code, { displayName: trimmed });
      setToken(res.playerToken);
      applyHydration(res.hydration);
    } catch (err) {
      mapApiError(err, "join");
    } finally {
      setLoading(false);
    }
  };

  const handleStartGame = async () => {
    if (!token) return;
    setErrorMsg(null);
    try {
      const res = await apiStartRound(code, token);
      applyHydration(res.hydration);
      setLiveReveal(null);
      setChosenOpt(null);
    } catch (err) {
      mapApiError(err, "action");
    }
  };

  const handleAnswer = async (optIdx: number) => {
    if (!token || !hydration?.current_question || submittingAnswer) return;
    const q = hydration.current_question;
    lastQuestionRef.current = q;
    const idempotencyKey = getOrCreateRoundIdempotencyKey(code, q.round_index);
    setChosenOpt(optIdx);
    setSubmittingAnswer(true);
    setErrorMsg(null);
    try {
      const res = await apiSubmitAnswer(code, token, {
        roundIndex: q.round_index,
        chosenIndex: optIdx,
        idempotencyKey,
      });
      applyHydration(res.hydration);
      if (res.reveal) {
        if (hydration.pacing_mode === "async24h") {
          setRevealedQuestion(q);
          setAsyncStepReveal(res.reveal);
        } else {
          setRevealedQuestion(q);
          setLiveReveal(res.reveal);
        }
      }
    } catch (err) {
      mapApiError(err, "action");
    } finally {
      setSubmittingAnswer(false);
    }
  };

  const handleReadyNext = async () => {
    if (!token || !liveReveal || readySubmitting) return;
    setReadySubmitting(true);
    setErrorMsg(null);
    try {
      const res = await apiMarkReady(code, token, liveReveal.round_index);
      applyHydration(res.hydration);
      if (res.advanced) {
        setLiveReveal(null);
        setRevealedQuestion(null);
        setChosenOpt(null);
      }
    } catch (err) {
      mapApiError(err, "action");
    } finally {
      setReadySubmitting(false);
    }
  };

  const handleManualReconnect = () => {
    if (!token) return;
    setConnState("reconnecting");
    setWsNonce((n) => n + 1);
    void apiHydrateRoom(code, token)
      .then((res) => applyHydration(res.hydration))
      .catch((err) => mapApiError(err, "action"));
  };

  const handleCopyInvite = async () => {
    const url = `${window.location.origin}/room/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2500);
    } catch {
      setInviteCopied(false);
    }
  };

  useEffect(() => {
    if (!hydration?.current_question) return;
    if (asyncStepReveal) return;
    const selfP = hydration.players.find((p) => p.player_id === hydration.self_player_id);
    if (hydration.pacing_mode === "live" && selfP?.answered_current_round) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4") {
        e.preventDefault();
        void handleAnswer(Number(e.key) - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hydration?.current_question, hydration?.players, submittingAnswer, asyncStepReveal]);

  const selfPlayer = hydration?.players.find((p) => p.player_id === hydration.self_player_id);
  const selfDone = Boolean(selfPlayer?.completed_all_rounds);
  const isRoomDone = Boolean(
    hydration &&
      (hydration.status === "completed" || (hydration.pacing_mode === "async24h" && selfDone))
  );
  const isMultiplayerActiveSession = Boolean(token && hydration && !roomBlocker && !isRoomDone);
  const leaveContext: LeaveGuardContext =
    hydration?.pacing_mode === "live" && hydration.status === "lobby"
      ? "room-lobby"
      : hydration?.pacing_mode === "live"
      ? "room-live"
      : "room-async";

  leaveCallbackRef.current = async () => {
    wsClosedByUserRef.current = true;
    const ws = wsRef.current;
    if (hydration?.pacing_mode === "live") {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "leave_room" }));
        } catch {
          // Ignore send failure
        }
        try {
          ws.close(1000, "Player left");
        } catch {
          // Ignore close error
        }
      } else {
        try {
          ws?.close(1000, "Player left");
        } catch {
          // Ignore close error
        }
        if (token) {
          await apiLeaveRoom(code, token).catch(() => {});
        }
      }
      clearSavedRoomToken(code);
    } else {
      try {
        ws?.close(1000, "Player paused async room");
      } catch {
        // Ignore close error
      }
    }
  };

  useEffect(() => {
    onSetLeaveGuard?.(
      isMultiplayerActiveSession
        ? {
            active: true,
            context: leaveContext,
            roomCode: code,
            onConfirmLeave: () => leaveCallbackRef.current(),
          }
        : null
    );
  }, [isMultiplayerActiveSession, leaveContext, code, onSetLeaveGuard]);

  useEffect(() => {
    return () => {
      onSetLeaveGuard?.(null);
    };
  }, [onSetLeaveGuard]);

  if (roomBlocker) {
    const blockerCopy: Record<
      RoomBlocker["kind"],
      { title: string; body: string; showRetry?: boolean }
    > = {
      invalid_code: {
        title: "Invalid room code",
        body: "Room codes use 6 characters (letters A–Z excluding I/O and digits 2–9). Check your invite link or start a fresh room.",
      },
      not_found: {
        title: "Room not found",
        body: "This room code does not exist or has already been removed. Start a fresh room or play today's Solo 5-Card Ritual.",
      },
      expired: {
        title: "Room expired",
        body: "Rooms expire automatically after 48 hours for privacy. Start a fresh room or play today's Solo 5-Card Ritual.",
      },
      full: {
        title: "Room is full",
        body: "This room has reached its player capacity. Start a fresh room with friends or play Solo Daily.",
      },
      already_started: {
        title: "Game already started",
        body: "This Live Sync room is already in progress. Start a fresh room or jump into Solo Daily.",
      },
      completed: {
        title: "Room already completed",
        body: "This room has finished all rounds. Start a fresh room for a rematch or play Solo Daily.",
      },
      quota: {
        title: "Live rooms at today's free-tier cap",
        body: roomBlocker.kind === "quota" ? roomBlocker.message : "",
      },
      origin: {
        title: "Origin security restriction",
        body: roomBlocker.kind === "origin" ? roomBlocker.message : "",
      },
      network: {
        title: "Unable to connect to room",
        body: roomBlocker.kind === "network" ? roomBlocker.message : "",
        showRetry: true,
      },
    };
    const info = blockerCopy[roomBlocker.kind];
    const formattedReset =
      roomBlocker.kind === "quota" &&
      roomBlocker.resetAtUtc &&
      !Number.isNaN(Date.parse(roomBlocker.resetAtUtc))
        ? new Date(roomBlocker.resetAtUtc).toUTCString()
        : roomBlocker.kind === "quota"
        ? roomBlocker.resetAtUtc
        : undefined;

    return (
      <div class="play-stage">
        <section class="card stack" role="alert" data-testid={`room-blocker-${roomBlocker.kind}`}>
          <span class="pill">Room {code}</span>
          <h1 class="h1">{info.title}</h1>
          <p class="muted">{info.body}</p>
          {formattedReset && (
            <p class="muted" style="font-size: 0.85rem;">
              Daily reset (UTC): {formattedReset}
            </p>
          )}
          <div class="row">
            {info.showRetry && (
              <button
                type="button"
                class="btn btn-primary"
                onClick={() => {
                  setRoomBlocker(null);
                  setHydrateNonce((n) => n + 1);
                }}
              >
                Retry
              </button>
            )}
            <button type="button" class="btn btn-primary" onClick={() => onNavigate("/room/new")}>
              Start a Fresh Room
            </button>
            <button type="button" class="btn btn-secondary" onClick={() => onNavigate("/")}>
              Play Solo Daily
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (loading && !hydration) {
    return (
      <div class="play-stage">
        <div class="card stack" aria-busy="true" data-testid="room-skeleton">
          <div class="skeleton skeleton-pill" />
          <div class="skeleton skeleton-title" />
          <div class="skeleton skeleton-line" />
          <div class="skeleton skeleton-box" />
        </div>
      </div>
    );
  }

  if (!token || !hydration) {
    return (
      <div class="play-stage">
        <section class="card stack" aria-labelledby="guest-join-title">
          <span class="pill">Room {code}</span>
          <h1 id="guest-join-title" class="h1">
            Join in 1 Tap — No Account Needed
          </h1>
          <p class="muted">Only your display name is shared in this room for up to 48 hours.</p>
          {errorMsg && (
            <div class="banner banner-err stack" role="alert">
              <span>{errorMsg}</span>
              {retryAfterSec !== null && (
                <span class="muted" style="font-size: 0.85rem;">
                  {retryAfterSec > 0
                    ? `Try again in ${retryAfterSec}s.`
                    : "Cooldown complete — you can retry now."}
                </span>
              )}
            </div>
          )}
          <form class="stack" onSubmit={handleJoin} novalidate>
            <div>
              <label class="field-label" htmlFor="guest-display-name">
                Display Name (2–20 chars)
              </label>
              <input
                id="guest-display-name"
                class="input"
                type="text"
                maxLength={20}
                placeholder="Your name"
                value={guestName}
                onInput={(e) => setGuestName((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <button
              type="submit"
              class="btn btn-primary btn-block"
              disabled={retryAfterSec !== null && retryAfterSec > 0}
            >
              Join Room
            </button>
          </form>
        </section>
      </div>
    );
  }

  const activePlayers = hydration.players.filter((p) => !p.has_left);
  const needsMorePlayers = activePlayers.length < 2;
  const totalRounds = hydration.question_count || 5;
  const lastRoundIdx = Math.max(0, totalRounds - 1);

  const langTrack = isLanguageTrack(hydration.track_id);
  let romajiPref: RomajiDisplayMode = "subtle";
  if (langTrack) {
    try {
      const savedRom = sessionStorage.getItem(`prb005_rom_${code}`);
      if (savedRom === "subtle" || savedRom === "after_answer" || savedRom === "off") {
        romajiPref = savedRom;
      }
    } catch {
      // Ignore storage error
    }
  }
  const showQuestionRomaji = langTrack && romajiPref === "subtle";
  const showRevealRomaji = langTrack && romajiPref !== "off";

  return (
    <div class="stack">
      <div class="sr-only" aria-live="polite">
        {announcement}
      </div>

      <div class="momentum-strip">
        <div class="row">
          <span class="pill">Room {hydration.room_code}</span>
          <span class="pill">
            {hydration.pacing_mode === "live" ? "Live Sync" : "24h Async"} · {totalRounds} cards
            {hydration.difficulty === "harder" ? " · Harder" : ""}
          </span>
          <span class="pill">
            {activePlayers.length} / {hydration.max_players} players
          </span>
        </div>
        <div class="row" style="gap: 8px;">
          <span
            class={`pill ${
              connState === "paused"
                ? "pill-err"
                : connState === "reconnecting"
                ? "pill-warn"
                : "pill-ok"
            }`}
            data-testid="conn-pill"
          >
            {connState === "paused"
              ? "Connection paused"
              : connState === "reconnecting"
              ? "Reconnecting..."
              : "Connected"}
          </span>
          {connState === "paused" && (
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-testid="ws-reconnect-btn"
              onClick={handleManualReconnect}
            >
              Reconnect
            </button>
          )}
          <button
            type="button"
            class="btn btn-secondary btn-sm btn-leave"
            data-testid="room-leave-btn"
            onClick={() => onNavigate("/")}
          >
            Leave
          </button>
        </div>
      </div>

      {errorMsg && (
        <div class="banner banner-err stack" role="alert">
          <span>{errorMsg}</span>
          {retryAfterSec !== null && (
            <span class="muted" style="font-size: 0.85rem;">
              {retryAfterSec > 0
                ? `Try again in ${retryAfterSec}s.`
                : "Cooldown complete — you can retry now."}
            </span>
          )}
        </div>
      )}

      <div class="bento-grid">
        <div class="bento-primary">

      {/* Lobby View */}
      {hydration.status === "lobby" && hydration.pacing_mode === "live" && (
        <section class="card stack" aria-labelledby="lobby-title">
          <h1 id="lobby-title" class="h1">
            Waiting in Lobby
          </h1>
          <p class="muted">
            Share invite link <code>/room/{code}</code> or code <strong>{code}</strong>.
          </p>

          {needsMorePlayers && (
            <div class="banner banner-warn stack" role="status" data-testid="min-players-notice">
              <strong>At least 2 players are required to start a Live Sync game</strong>
              <span>
                Share the invite link with a friend to unlock Start, or jump into Solo Daily / Practice if you&apos;re playing alone.
              </span>
              <div class="row">
                <button
                  type="button"
                  class="btn btn-secondary"
                  onClick={() => {
                    void (async () => {
                      await leaveCallbackRef.current();
                      onSetLeaveGuard?.(null);
                      const target = `/play/daily?track=${encodeURIComponent(hydration.track_id)}`;
                      if (onForceNavigate) onForceNavigate(target);
                      else onNavigate(target);
                    })();
                  }}
                >
                  Play Solo Mode Instead
                </button>
              </div>
            </div>
          )}

          <div class="row">
            <button type="button" class="btn btn-secondary" onClick={handleCopyInvite}>
              {inviteCopied ? "✓ Invite Link Copied" : "Copy Invite Link"}
            </button>
            {hydration.self_role === "host" ? (
              <button
                type="button"
                class="btn btn-primary"
                disabled={needsMorePlayers}
                onClick={handleStartGame}
              >
                Start Round 1
              </button>
            ) : (
              <span class="muted">Waiting for host to start Round 1...</span>
            )}
          </div>

          <div class="stack">
            <span class="field-label">Joined Players ({activePlayers.length})</span>
            {activePlayers.map((p) => (
              <div key={p.player_id} class="player-row" data-testid={`lobby-player-${p.player_id}`}>
                <span class="player-identity">
                  <span class={`player-avatar player-color-${p.color_index % 8}`} aria-hidden="true">
                    {playerInitial(p.display_name)}
                  </span>
                  <span>
                    {p.display_name} {p.role === "host" ? "(Host)" : ""}
                  </span>
                </span>
                <span class={`pill ${p.is_connected ? "pill-ok" : "pill-warn"}`}>
                  {p.is_connected ? "Ready in Lobby" : "Joining..."}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Async 24h Per-Card Instant Feedback */}
      {hydration.pacing_mode === "async24h" && asyncStepReveal && (
        <section
          key={`async-${asyncStepReveal.round_index}`}
          class="card stack card-stage"
          aria-label="Async card feedback"
        >
          {(() => {
            const myRes = asyncStepReveal.player_results.find(
              (r) => r.player_id === hydration.self_player_id
            );
            const isRight = myRes?.chosen_index === asyncStepReveal.correct_index;
            const correctText =
              revealedQuestion?.options_4[asyncStepReveal.correct_index] ?? "";
            return (
              <div class={`banner ${isRight ? "banner-ok" : "banner-err"} stack`}>
                <strong>
                  {isRight
                    ? `✓ Correct! Card ${asyncStepReveal.round_index + 1} (+100 pts)`
                    : `✗ Your answer is wrong — correct answer: "${correctText}"`}
                </strong>
                <span>{asyncStepReveal.deterministic_note}</span>
              </div>
            );
          })()}
          <button
            type="button"
            class="btn btn-primary"
            onClick={() => {
              setAsyncStepReveal(null);
              setChosenOpt(null);
            }}
          >
            {asyncStepReveal.round_index >= lastRoundIdx
              ? "View Group Standings"
              : `Next Card (${asyncStepReveal.round_index + 2}/${totalRounds})`}
          </button>
        </section>
      )}

      {/* Active Question View */}
      {hydration.current_question && !isRoomDone && !asyncStepReveal && (
        <section
          key={`q-${hydration.current_question.round_index}`}
          class="card stack card-stage"
          aria-label="Room active round"
        >
          <div class="runner-header">
            <span class="pill">
              Card {hydration.current_question.round_index + 1} / {totalRounds}
            </span>
            {secondsLeft !== null && (
              <span class={`pill ${secondsLeft <= 5 ? "pill-warn" : ""}`}>
                Timer: {secondsLeft}s
              </span>
            )}
          </div>

          <div>
            <h1 class="prompt-text">{hydration.current_question.prompt}</h1>
            {showQuestionRomaji && hydration.current_question.prompt_romanization && (
              <span class="romanization" data-testid="room-prompt-romanization">
                {hydration.current_question.prompt_romanization}
              </span>
            )}
          </div>

          {selfPlayer?.answered_current_round && hydration.pacing_mode === "live" ? (
            <div class="stack" data-testid="locked-in-waiting">
              <div class="banner banner-ok stack">
                <strong>✓ Locked in — waiting for other players</strong>
                <span>Answers stay hidden until everyone submits or the timer finishes.</span>
              </div>
              <div class="stack">
                {activePlayers.map((p) => (
                  <div key={p.player_id} class="player-row">
                    <span class="player-identity">
                      <span
                        class={`player-avatar player-color-${p.color_index % 8}`}
                        aria-hidden="true"
                      >
                        {playerInitial(p.display_name)}
                      </span>
                      <span>{p.display_name}</span>
                    </span>
                    <span
                      class={`pill ${
                        p.answered_current_round
                          ? "pill-ok"
                          : p.is_connected
                          ? ""
                          : "pill-warn"
                      }`}
                    >
                      {p.answered_current_round
                        ? "✓ Locked in"
                        : p.is_connected
                        ? "Thinking..."
                        : "Reconnecting..."}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div class="options-list" role="group" aria-label="Room answer choices">
              {hydration.current_question.options_4.map((opt, idx) => {
                const optRom = hydration.current_question!.options_romanization?.[idx];
                return (
                  <button
                    key={`${hydration.current_question!.round_index}-${idx}`}
                    type="button"
                    class={`option-btn ${chosenOpt === idx ? "selected" : ""}`}
                    disabled={submittingAnswer}
                    onClick={() => void handleAnswer(idx)}
                  >
                    <span class="option-kbd">{idx + 1}</span>
                    <span>
                      <span>{opt}</span>
                      {showQuestionRomaji && optRom && (
                        <span class="option-romanization">{optRom}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Synchronized Live Round Reveal + Ready Gate */}
      {hydration.pacing_mode === "live" &&
        hydration.round_phase === "reveal" &&
        liveReveal &&
        !hydration.current_question && (
          <section
            key={`rev-${liveReveal.round_index}`}
            class="card stack card-stage"
            aria-label="Round reveal"
          >
            <div class="runner-header">
              <span class="pill pill-ok">Round {liveReveal.round_index + 1} Revealed</span>
              <span class="pill">
                {activePlayers.filter((p) => p.ready_for_next).length} /{" "}
                {activePlayers.length} Ready
              </span>
            </div>

            {revealedQuestion && (
              <div>
                <h2 class="h2">{revealedQuestion.prompt}</h2>
                {showRevealRomaji && revealedQuestion.prompt_romanization && (
                  <span class="romanization">{revealedQuestion.prompt_romanization}</span>
                )}
              </div>
            )}

            {(() => {
              const myRes = liveReveal.player_results.find(
                (r) => r.player_id === hydration.self_player_id
              );
              const myPick = myRes?.chosen_index ?? null;
              const isRight = myPick === liveReveal.correct_index;
              const timedOut = myPick === null;
              const correctLabel =
                revealedQuestion?.options_4[liveReveal.correct_index] ??
                `Option ${liveReveal.correct_index + 1}`;
              const correctRom = revealedQuestion?.options_romanization?.[liveReveal.correct_index];
              const correctRomNote = showRevealRomaji && correctRom ? ` (${correctRom})` : "";

              return (
                <div class="stack">
                  <div
                    class={`banner ${
                      isRight ? "banner-ok" : timedOut ? "banner-warn" : "banner-err"
                    } stack`}
                    data-testid="reveal-verdict-banner"
                  >
                    <strong>
                      {isRight
                        ? "✓ Correct! +100 pts"
                        : timedOut
                        ? `⏱ Time's up — correct answer: "${correctLabel}"${correctRomNote}`
                        : `✗ Your answer is wrong — correct answer: "${correctLabel}"${correctRomNote}`}
                    </strong>
                    <span>{liveReveal.deterministic_note}</span>
                  </div>

                  {revealedQuestion && (
                    <div class="options-list" aria-label="Revealed answer comparison">
                      {revealedQuestion.options_4.map((opt, idx) => {
                        const isCorrectOpt = idx === liveReveal.correct_index;
                        const isMyWrongOpt = myPick === idx && !isCorrectOpt;
                        const optRom = revealedQuestion.options_romanization?.[idx];
                        const cls = isCorrectOpt
                          ? "option-btn correct"
                          : isMyWrongOpt
                          ? "option-btn wrong"
                          : "option-btn";
                        return (
                          <div key={`reveal-${liveReveal.round_index}-${idx}`} class={cls}>
                            <span class="option-kbd">{idx + 1}</span>
                            <span>
                              <span>
                                {opt}
                                {isCorrectOpt ? " ✓ Correct Answer" : isMyWrongOpt ? " ✗ Your Pick" : ""}
                              </span>
                              {showRevealRomaji && optRom && (
                                <span class="option-romanization">{optRom}</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            <div class="stack">
              <span class="field-label">Round Scores &amp; Ready Status</span>
              {liveReveal.player_results.map((r) => {
                const pState = hydration.players.find((p) => p.player_id === r.player_id);
                return (
                  <div key={r.player_id} class="player-row">
                    <span class="player-identity">
                      <span
                        class={`player-avatar player-color-${r.color_index % 8}`}
                        aria-hidden="true"
                      >
                        {playerInitial(r.display_name)}
                      </span>
                      <span>
                        {r.display_name} {r.is_correct ? "✓" : "✗"} · {r.total_score} pts
                      </span>
                    </span>
                    {pState?.has_left ? (
                      <span class="pill">Left</span>
                    ) : (
                      <span class={`pill ${pState?.ready_for_next ? "pill-ok" : ""}`}>
                        {pState?.ready_for_next ? "✓ Ready" : "Reading..."}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {selfPlayer?.ready_for_next ? (
              <div class="banner banner-ok" data-testid="waiting-ready-banner">
                ✓ You are ready — waiting for remaining players (
                {activePlayers.filter((p) => p.ready_for_next).length} /{" "}
                {activePlayers.length})...
              </div>
            ) : (
              <button
                type="button"
                class="btn btn-primary btn-block"
                disabled={readySubmitting}
                onClick={() => void handleReadyNext()}
              >
                {liveReveal.round_index >= lastRoundIdx
                  ? "Ready for final results"
                  : "Ready for next round"}
              </button>
            )}
          </section>
        )}

      {/* Group Summary & Blind-Until-Completed Async Standings */}
      {isRoomDone && !asyncStepReveal && (
        <section class="card stack" aria-labelledby="room-summary-title">
          <span class="pill pill-ok">Round Complete!</span>
          <h1 id="room-summary-title" class="h1">
            {hydration.pacing_mode === "async24h" ? "24h Async Run Complete" : "Group Summary"}
          </h1>

          {selfPlayer && (
            <LazyShareBox
              shareText={buildSpoilerFreeShareText({
                title: `BrainPlay Room ${code}`,
                dateOrRoom: hydration.track_id,
                outcomes: selfPlayer.results,
                url: `${window.location.origin}/room/${code}`,
              })}
            />
          )}

          <div class="stack">
            <h2 class="h2">Group Standings</h2>
            {[...hydration.players]
              .sort((a, b) => b.score - a.score)
              .map((p) => (
                <div key={p.player_id} class="player-row">
                  <span class="player-identity">
                    <span
                      class={`player-avatar player-color-${p.color_index % 8}`}
                      aria-hidden="true"
                    >
                      {playerInitial(p.display_name)}
                    </span>
                    <span>
                      {p.display_name}
                      {p.has_left ? " (Left)" : ""}
                    </span>
                  </span>
                  {hydration.pacing_mode === "async24h" && !p.completed_all_rounds ? (
                    <span class="muted">Playing today...</span>
                  ) : (
                    <span>
                      {buildEmojiRow(p.results)} · <strong>{p.score} pts</strong>
                    </span>
                  )}
                </div>
              ))}
          </div>

          <div class="row">
            <button type="button" class="btn btn-primary" onClick={() => onNavigate("/room/new")}>
              Play Rematch
            </button>
            <button type="button" class="btn btn-secondary" onClick={() => onNavigate("/")}>
              Back to Hub
            </button>
          </div>
        </section>
      )}
        </div>

        {/* Right / Companion Column: Live Room Guide & Scoreboard */}
        <aside class="bento-companion" aria-label="Room status and standings">
          <section class="card stack">
            <h2 class="h2">
              {hydration.pacing_mode === "live" ? "Live Sync Rules" : "24h Micro-Async Rules"}
            </h2>
            <p class="muted" style="font-size: 0.875rem;">
              {hydration.pacing_mode === "live"
                ? "Answers stay hidden until everyone locks in. After reveal, all players click Ready to move to the next card together."
                : "Go at your own pace anytime within 24 hours. Peer scores stay blind until you finish your full run."}
            </p>
            <div class="card-subtle stack" style="gap: 6px;">
              <strong style="font-size: 0.875rem;">
                Scoreboard ({activePlayers.length} active)
              </strong>
              {hydration.players.map((p) => (
                <div key={`aside-${p.player_id}`} class="row" style="justify-content: space-between; font-size: 0.875rem;">
                  <span>
                    {p.display_name}
                    {p.player_id === hydration.self_player_id ? " (You)" : ""}
                    {p.has_left ? " (Left)" : ""}
                  </span>
                  <strong>
                    {hydration.pacing_mode === "async24h" && !selfDone && p.player_id !== hydration.self_player_id
                      ? "Blind"
                      : `${p.score} pts`}
                  </strong>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
