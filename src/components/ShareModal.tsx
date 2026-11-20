import { useEffect, useRef, useState } from "preact/hooks";

interface ShareModalProps {
  shareText: string;
  onClose?: () => void;
}

export function ShareBox({ shareText }: ShareModalProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "fallback">("idle");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (status === "fallback") {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [status]);

  useEffect(() => {
    if (status !== "fallback") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setStatus("idle");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status]);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(shareText);
        setStatus("copied");
        return;
      }
      setStatus("fallback");
    } catch {
      setStatus("fallback");
    }
  };

  return (
    <div class="stack">
      <div class="share-box" data-testid="share-preview">
        {shareText}
      </div>
      <div class="row">
        <button type="button" class="btn btn-primary" onClick={handleCopy}>
          {status === "copied" ? "✓ Copied Spoiler-Free Grid" : "Copy Spoiler-Free Grid"}
        </button>
      </div>

      {status === "fallback" && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="copy-modal-title">
          <div class="modal-card stack">
            <h3 id="copy-modal-title" class="h2">
              Copy Result Manually
            </h3>
            <p class="muted">
              Clipboard access is restricted in this browser. Select and copy the grid below:
            </p>
            <textarea
              ref={textareaRef}
              class="input"
              rows={4}
              readOnly
              value={shareText}
              aria-label="Spoiler-free share grid text"
              onClick={(e) => (e.currentTarget as HTMLTextAreaElement).select()}
            />
            <button type="button" class="btn btn-secondary" onClick={() => setStatus("idle")}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
