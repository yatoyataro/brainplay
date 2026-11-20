import { useState } from "preact/hooks";
import { ApiRequestError, apiFlagCard } from "../core/roomClient.ts";

interface FlagButtonProps {
  itemId: string;
  onFlaggedLocally: (itemId: string) => void;
}

const DAILY_FLAG_KEY = "prb005_flags_today";

function canFlagToday(): boolean {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const raw = localStorage.getItem(DAILY_FLAG_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { date: string; count: number };
    return parsed.date !== today || parsed.count < 5;
  } catch {
    return true;
  }
}

function recordLocalFlagCount(): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const raw = localStorage.getItem(DAILY_FLAG_KEY);
    let count = 1;
    if (raw) {
      const parsed = JSON.parse(raw) as { date: string; count: number };
      if (parsed.date === today) count = parsed.count + 1;
    }
    localStorage.setItem(DAILY_FLAG_KEY, JSON.stringify({ date: today, count }));
  } catch {
    // Ignore storage errors
  }
}

export function FlagButton({ itemId, onFlaggedLocally }: FlagButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<"typo" | "ambiguous" | "wrong_answer" | "offensive">("ambiguous");
  const [message, setMessage] = useState<string | null>(null);

  const submitFlag = async () => {
    if (!canFlagToday()) {
      setMessage("Daily report limit (5/day) reached. Card hidden locally.");
      onFlaggedLocally(itemId);
      setOpen(false);
      return;
    }
    recordLocalFlagCount();
    onFlaggedLocally(itemId);
    setOpen(false);
    setMessage("Card hidden locally and queued for review.");
    try {
      await apiFlagCard(itemId, reason);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.status === 429) {
          setMessage("Card hidden locally (daily server report limit reached).");
        } else if (err.status === 503) {
          setMessage("Card hidden locally (report service temporarily busy).");
        } else if (err.status === 403) {
          setMessage("Card hidden locally (server report blocked for this origin).");
        } else if (err.status === 0) {
          setMessage("Card hidden locally (offline — report not sent to server).");
        } else {
          setMessage("Card hidden locally (server report unavailable).");
        }
      } else {
        setMessage("Card hidden locally (server report unavailable).");
      }
    }
  };

  if (message) {
    return (
      <span class="muted" role="status">
        {message}
      </span>
    );
  }

  return (
    <div>
      {!open ? (
        <button type="button" class="btn-link" onClick={() => setOpen(true)}>
          Flag card
        </button>
      ) : (
        <div class="row" style="margin-top: 6px;">
          <label class="sr-only" htmlFor={`flag-reason-${itemId}`}>
            Flag reason
          </label>
          <select
            id={`flag-reason-${itemId}`}
            class="input"
            style="width: auto; min-width: 160px;"
            value={reason}
            onChange={(e) =>
              setReason((e.currentTarget as HTMLSelectElement).value as typeof reason)
            }
          >
            <option value="ambiguous">Ambiguous wording</option>
            <option value="typo">Typo / formatting</option>
            <option value="wrong_answer">Wrong answer</option>
            <option value="offensive">Inappropriate content</option>
          </select>
          <button type="button" class="btn btn-secondary" onClick={submitFlag}>
            Hide &amp; Report
          </button>
          <button type="button" class="btn-link" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
