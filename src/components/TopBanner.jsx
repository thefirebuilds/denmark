import { useMemo } from "react";

function formatLastReceived(ts) {
  if (!ts) return "—";

  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "—";

  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default function TopBanner({
  stats,
  loading = false,
  refreshing = false,
}) {
  const todayLabel = useMemo(() => {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
    }).format(new Date());
  }, []);

  return (
    <div className="top-banner">
      <div>
        <strong>Trip Dispatch Console</strong>{" "}
        Live operations view built around messages, returns, and timing risk.
      </div>

      <div className="top-banner-status">
        <span
          className={`top-banner-sync ${refreshing ? "is-refreshing" : ""}`}
          aria-hidden="true"
        />

        {refreshing && (
          <span className="top-banner-checking">
            checking<span className="top-banner-ellipsis">...</span>
          </span>
        )}

        <span>
          {loading
            ? "Loading…"
            : `${todayLabel} • ${stats?.unread ?? 0} unread • last received ${formatLastReceived(
                stats?.lastReceived
              )}`}
        </span>
      </div>
    </div>
  );
}