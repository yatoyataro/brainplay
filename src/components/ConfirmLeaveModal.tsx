import { useEffect, useRef } from "preact/hooks";

export type LeaveGuardContext = "solo" | "room-lobby" | "room-live" | "room-async";

export interface LeaveGuardConfig {
  active: boolean;
  context: LeaveGuardContext;
  roomCode?: string;
  onConfirmLeave?: () => Promise<void> | void;
}

export interface ConfirmLeaveModalProps {
  open: boolean;
  context: LeaveGuardContext;
  roomCode?: string;
  onStay: () => void;
  onConfirmLeave: () => void;
}

function getContextDetail(context: LeaveGuardContext, roomCode?: string): string {
  const codeLabel = roomCode ? ` ${roomCode}` : "";
  switch (context) {
    case "solo":
      return "Leaving now exits your active solo round.";
    case "room-lobby":
      return `Leaving exits Room${codeLabel} lobby and frees your spot for other players.`;
    case "room-live":
      return `Leaving exits Live Sync Room${codeLabel} so remaining players can continue without waiting.`;
    case "room-async":
      return `Your completed cards in 24h Async Room${codeLabel} stay saved so you can return within 24 hours.`;
  }
}

export function ConfirmLeaveModal({
  open,
  context,
  roomCode,
  onStay,
  onConfirmLeave,
}: ConfirmLeaveModalProps) {
  const stayBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const onStayRef = useRef(onStay);
  onStayRef.current = onStay;

  useEffect(() => {
    if (!open) {
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev && prev.isConnected) {
        prev.focus();
      }
      return;
    }

    prevFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stayBtnRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onStayRef.current();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const stayEl = stayBtnRef.current;
        const confirmEl = confirmBtnRef.current;
        if (!stayEl || !confirmEl) return;
        const active = document.activeElement;
        if (e.shiftKey) {
          (active === stayEl ? confirmEl : stayEl).focus();
        } else {
          (active === confirmEl ? stayEl : confirmEl).focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div
      class="modal-backdrop modal-backdrop-animated"
      role="presentation"
      data-testid="confirm-leave-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onStay();
      }}
    >
      <div
        class="modal-card stack"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-leave-title"
        aria-describedby="confirm-leave-desc"
        data-testid="confirm-leave-dialog"
      >
        <h2 id="confirm-leave-title" class="h2">
          Leave current session?
        </h2>
        <p id="confirm-leave-desc" class="muted">
          Unfinished round progress will be lost. {getContextDetail(context, roomCode)}
        </p>
        <div class="modal-actions">
          <button
            ref={stayBtnRef}
            type="button"
            class="btn btn-primary"
            data-testid="leave-stay-btn"
            onClick={onStay}
          >
            Stay in Game
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            class="btn btn-danger"
            data-testid="leave-confirm-btn"
            onClick={onConfirmLeave}
          >
            Leave Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
