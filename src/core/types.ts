export type LicenseId =
  | "CC0-1.0"
  | "CC-BY-2.0-FR"
  | "CC-BY-SA-4.0"
  | "PUBLIC-FACTUAL-API";

export type DifficultyTier = "beginner" | "intermediate" | "challenge";

export type TrackGroup = "phrases" | "trivia";

export type TrackKey =
  | "phrases-en-ko"
  | "phrases-ko-en"
  | "phrases-en-ja"
  | "phrases-ja-en"
  | "trivia-anime"
  | "trivia-anime-characters"
  | "trivia-world";

export type GameDifficulty = "standard" | "harder";
export type RomajiDisplayMode = "subtle" | "after_answer" | "off";
export type SessionLength = 5 | 10 | 15;

export type HubCategoryId =
  | "languages"
  | "trivia-anime"
  | "trivia-anime-characters"
  | "trivia-world";

export type LanguageSubtrackId =
  | "phrases-en-ko"
  | "phrases-ko-en"
  | "phrases-en-ja"
  | "phrases-ja-en";

export interface UserPreferencesV1 {
  schema_version: 1;
  selectedCategory: HubCategoryId;
  languageSubtrack: LanguageSubtrackId;
  difficulty: GameDifficulty;
  sessionLength: SessionLength;
  romajiMode: RomajiDisplayMode;
  shuffleCardsAndChoices: boolean;
}

export interface GameOptions {
  difficulty: GameDifficulty;
  shuffleCardsAndChoices: boolean;
  romajiMode: RomajiDisplayMode;
  sessionLength: SessionLength;
}

export interface ContentShardItem {
  item_id: string;
  track_id: TrackGroup;
  subtrack_id: TrackKey | string;
  difficulty: DifficultyTier;
  prompt: string;
  prompt_romanization?: string;
  options_4: [string, string, string, string];
  options_romanization?: [string, string, string, string];
  correct_index: 0 | 1 | 2 | 3;
  deterministic_note: string;
  source_name: string;
  source_author?: string;
  license_id: LicenseId;
}

export interface ShardMeta {
  shard_id: string;
  subtrack_id: string;
  track_id: TrackGroup;
  label: string;
  source_lang?: string;
  target_lang?: string;
  license_id: LicenseId;
  url: string;
  item_count: number;
  bytes: number;
  sha256: string;
}

export interface PackCatalog {
  schema_version: 1;
  generated_at: string;
  total_items: number;
  tracks: Array<{
    subtrack_id: string;
    track_id: TrackGroup;
    label: string;
    description: string;
    license_id: LicenseId;
    item_count: number;
    shards: string[];
  }>;
  shards: ShardMeta[];
  daily_dates: string[];
}

export interface DailyManifest {
  schema_version: 1;
  utc_date: string;
  subtrack_id: string;
  item_ids: string[];
  shard_urls: string[];
}

export type MasteryTier = "New" | "Learning" | "Familiar" | "Mastered";

export interface LocalMasteryItem {
  item_id: string;
  subtrack_id: string;
  tier: MasteryTier;
  streak_count: number;
  next_due_date: string;
  updated_at: string;
  flagged_hidden: boolean;
}

export interface LocalActiveDay {
  local_date: string;
  cards_completed: number;
  correct_count?: number;
  attempt_count?: number;
  daily_grid_summary?: string;
  subtrack_id?: string;
}

export type PacingMode = "live" | "async24h";
export type RoomStatus = "lobby" | "active" | "completed" | "expired";
export type RoundPhase = "lobby" | "question" | "reveal" | "completed";
export type PlayerRole = "host" | "guest";

export interface PublicRoomQuestion {
  round_index: number;
  item_id: string;
  subtrack_id: string;
  difficulty: DifficultyTier;
  prompt: string;
  prompt_romanization?: string;
  options_4: [string, string, string, string];
  options_romanization?: [string, string, string, string];
  source_name: string;
  license_id: LicenseId;
}

export interface RoomSubmissionRecord {
  idempotency_key: string;
  player_id: string;
  round_index: number;
  chosen_index: number;
  is_correct: boolean;
  points_awarded: number;
  submitted_at: string;
}

export interface RoomPlayerState {
  player_id: string;
  display_name: string;
  role: PlayerRole;
  color_index: number;
  score: number;
  last_completed_round: number; // -1 if none yet
  joined_at: string;
  has_left?: boolean;
  left_at?: string;
  results: Array<"correct" | "wrong" | "skipped" | "pending">;
}

export interface RoomSnapshot {
  room_code: string;
  track_id: string;
  pacing_mode: PacingMode;
  max_players: number;
  round_seconds: number;
  question_count?: SessionLength;
  difficulty?: GameDifficulty;
  status: RoomStatus;
  round_phase: RoundPhase;
  current_round: number; // 0..question_count-1
  seeded_item_ids: string[];
  shuffle_salt?: string;
  round_option_orders?: Array<[0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3]>;
  round_deadline_at: string | null;
  ready_player_ids: string[];
  created_at: string;
  expires_at: string;
  players: RoomPlayerState[];
  submissions: RoomSubmissionRecord[];
}

export interface RoundRevealPayload {
  round_index: number;
  correct_index: 0 | 1 | 2 | 3;
  deterministic_note: string;
  player_results: Array<{
    player_id: string;
    display_name: string;
    color_index: number;
    chosen_index: number | null;
    is_correct: boolean;
    points_awarded: number;
    total_score: number;
  }>;
}

export interface ClientRoomHydration {
  room_code: string;
  track_id: string;
  pacing_mode: PacingMode;
  max_players: number;
  round_seconds: number;
  question_count: number;
  difficulty: GameDifficulty;
  status: RoomStatus;
  round_phase: RoundPhase;
  current_round: number;
  round_deadline_at: string | null;
  expires_at: string;
  self_player_id: string;
  self_role: PlayerRole;
  players: Array<{
    player_id: string;
    display_name: string;
    role: PlayerRole;
    color_index: number;
    score: number;
    is_connected: boolean;
    answered_current_round: boolean;
    ready_for_next: boolean;
    completed_all_rounds: boolean;
    has_left?: boolean;
    results: Array<"correct" | "wrong" | "skipped" | "pending">;
  }>;
  current_question: PublicRoomQuestion | null;
  completed_reveals: RoundRevealPayload[];
}

export interface ApiErrorPayload {
  code: string;
  error: string;
  fallback?: "solo";
  resetAtUtc?: string;
  retryAfterSec?: number;
}

export type RoomWsClientEvent =
  | { type: "host_start_round" }
  | {
      type: "submit_answer";
      roundIndex: number;
      chosenIndex: number;
      idempotencyKey: string;
    }
  | { type: "player_ready"; roundIndex: number }
  | { type: "leave_room" }
  | { type: "ping" };

export type RoomWsServerEvent =
  | { type: "room_state"; hydration: ClientRoomHydration }
  | { type: "round_started"; question: PublicRoomQuestion; deadlineEpochMs: number }
  | { type: "player_progress"; playerId: string; roundIndex: number; answered: boolean }
  | { type: "player_ready_progress"; playerId: string; roundIndex: number; readyCount: number; totalPlayers: number }
  | { type: "round_revealed"; reveal: RoundRevealPayload; nextRoundIndex: number | null }
  | { type: "room_completed"; hydration: ClientRoomHydration }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };
