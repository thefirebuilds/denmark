import { useMemo, useState } from "react";

function formatLastReceived(ts) {
  if (!ts) return "-";

  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";

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

function money(value) {
  if (value == null || value === "") return "--";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "--";

  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatBalanceTimestamp(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default function TopBanner({
  stats,
  mercuryBalance = null,
  citiCardBalance = null,
  loading = false,
  refreshing = false,
  authInfo = null,
  layoutMode = "auto",
  effectiveLayoutMode = "desktop",
  onChangeLayoutMode,
}) {
  const [editingCitiBalance, setEditingCitiBalance] = useState(false);
  const [citiBalanceDraft, setCitiBalanceDraft] = useState("");
  const todayLabel = useMemo(() => {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
    }).format(new Date());
  }, []);
  const serverFreshnessLabel =
    stats?.deploymentLabel || stats?.serverUptimeLabel || "server";

  function beginCitiBalanceReconciliation() {
    const current = citiCardBalance?.debtBalance ?? citiCardBalance?.currentBalance;
    setCitiBalanceDraft(current == null ? "" : Number(current).toFixed(2));
    setEditingCitiBalance(true);
  }

  async function handleReconcileCitiBalance(event) {
    event?.preventDefault?.();
    if (typeof citiCardBalance?.reconcileBalance !== "function") return;
    const amount = Number(String(citiBalanceDraft).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amount) || amount < 0) {
      window.alert("Enter a valid non-negative Citi balance.");
      return;
    }
    try {
      await citiCardBalance.reconcileBalance(amount);
      setEditingCitiBalance(false);
    } catch (error) {
      window.alert(error?.message || "Could not reconcile the Citi balance.");
    }
  }

  const mercuryBalanceTooltip = `Mercury last checked: ${formatBalanceTimestamp(
    mercuryBalance?.fetchedAt
  )}`;
  const citiBalanceTooltip = [
    `Citi last checked by Plaid: ${formatBalanceTimestamp(
      citiCardBalance?.lastCheckedAt || citiCardBalance?.fetchedAt
    )}`,
    citiCardBalance?.reconciledAt
      ? `Manually reconciled: ${formatBalanceTimestamp(citiCardBalance.reconciledAt)}`
      : null,
    "Click to reconcile the current balance.",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="top-banner">
      <div className="top-banner-copy">
        <strong>Trip Dispatch Console</strong>{" "}
        Live operations view built around messages, returns, and timing risk.
      </div>

      <div className="top-banner-side">
        <div className="layout-mode-switch" aria-label="Layout mode">
          {[
            { key: "auto", label: "Auto" },
            { key: "desktop", label: "Desktop" },
            { key: "mobile", label: "Mobile" },
          ].map((option) => (
            <button
              key={option.key}
              type="button"
              className={`layout-mode-btn ${
                layoutMode === option.key ? "is-active" : ""
              }`}
              onClick={() => onChangeLayoutMode?.(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="top-banner-status">
          {authInfo?.authEnforced === false && (
            <span className="top-banner-auth top-banner-auth--bypass">
              Auth bypassed (local dev)
            </span>
          )}

          {authInfo?.authEnforced === true && authInfo?.displayName && (
            <span className="top-banner-auth">
              {authInfo.displayName} · {authInfo.role}
            </span>
          )}

          <span
            className={`top-banner-sync ${refreshing ? "is-refreshing" : ""}`}
            aria-hidden="true"
          />

          {refreshing && (
            <span className="top-banner-checking">
              checking<span className="top-banner-ellipsis">...</span>
            </span>
          )}

          <span className="top-banner-balance" title={mercuryBalanceTooltip}>
            Mercury {mercuryBalance?.configured === false
              ? "not configured"
              : mercuryBalance?.loading
                ? "loading"
                : money(mercuryBalance?.availableBalance ?? mercuryBalance?.currentBalance)}
          </span>

          {editingCitiBalance ? (
            <form
              className="top-banner-balance top-banner-balance--debt top-banner-balance-editor"
              title={citiBalanceTooltip}
              onSubmit={handleReconcileCitiBalance}
            >
              <span>Citi {citiCardBalance?.lastFour || "4483"} $</span>
              <input
                autoFocus
                type="number"
                min="0"
                step="0.01"
                value={citiBalanceDraft}
                disabled={citiCardBalance?.reconciling}
                aria-label="Current Citi balance owed"
                onChange={(event) => setCitiBalanceDraft(event.target.value)}
              />
              <button type="submit" disabled={citiCardBalance?.reconciling}>
                {citiCardBalance?.reconciling ? "..." : "Save"}
              </button>
              <button
                type="button"
                disabled={citiCardBalance?.reconciling}
                onClick={() => setEditingCitiBalance(false)}
              >
                ×
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="top-banner-balance top-banner-balance--debt top-banner-balance--action"
              title={citiBalanceTooltip}
              disabled={
                citiCardBalance?.loading ||
                citiCardBalance?.configured === false ||
                citiCardBalance?.found === false
              }
              onClick={beginCitiBalanceReconciliation}
            >
              Citi {citiCardBalance?.lastFour || "4483"}{" "}
              {citiCardBalance?.configured === false
                ? "not configured"
                : citiCardBalance?.loading
                  ? "loading"
                  : citiCardBalance?.found === false
                    ? "not found"
                    : money(citiCardBalance?.debtBalance ?? citiCardBalance?.currentBalance)}
            </button>
          )}

          <span>
            {loading
              ? "Loading..."
              : `${todayLabel} • ${stats?.unread ?? 0} unread • last received ${formatLastReceived(
                  stats?.lastReceived
                )} • ${serverFreshnessLabel} • ${effectiveLayoutMode} view`}
          </span>
        </div>
      </div>
    </div>
  );
}
