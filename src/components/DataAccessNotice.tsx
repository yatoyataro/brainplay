interface DataAccessNoticeProps {
  visible: boolean;
  onDismiss: () => void;
  onOpenPrivacy: () => void;
}

export function DataAccessNotice({
  visible,
  onDismiss,
  onOpenPrivacy,
}: DataAccessNoticeProps) {
  if (!visible) return null;

  return (
    <aside
      class="data-notice-dock"
      role="region"
      aria-label="Local storage and room data notice"
      data-testid="data-access-notice"
    >
      <div class="data-notice-card">
        <p class="data-notice-text">
          <strong>Local-first privacy:</strong> Solo mastery &amp; settings stay strictly in your
          browser (<code>IndexedDB</code> / <code>localStorage</code>) with zero tracking,
          analytics, or ads. Optional Multiplayer rooms temporarily store room nickname &amp; round
          answers (auto-deleted after 48h), plus short-lived keyed-hash rate-limit counters
          (1h–24h expiry, automatically purged) for room requests and card flags — no raw IPs,
          accounts, or PII stored.
        </p>
        <div class="row" style="gap: 8px; flex-shrink: 0;">
          <button type="button" class="btn btn-secondary btn-sm" onClick={onOpenPrivacy}>
            Privacy &amp; Licenses
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            data-testid="data-notice-dismiss"
            onClick={onDismiss}
          >
            Got it
          </button>
        </div>
      </div>
    </aside>
  );
}
