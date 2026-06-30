import { useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const DEFAULT_TIME_ZONE = "America/Chicago";

function getTodayInputValue() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0";
  return number.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatTripTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getTripLabel(trip) {
  return [trip.vehicleNickname || trip.vehicleName, trip.guestName]
    .filter(Boolean)
    .join(" / ");
}

function StatTile({ label, value, detail }) {
  return (
    <div className="daily-brief-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <em>{detail}</em> : null}
    </div>
  );
}

function TripList({ title, trips, timeKey }) {
  const rows = Array.isArray(trips) ? trips.slice(0, 5) : [];
  return (
    <div className="daily-brief-mini-list">
      <div className="daily-brief-mini-title">
        <span>{title}</span>
        <strong>{rows.length}</strong>
      </div>
      {rows.length ? (
        rows.map((trip) => (
          <div key={`${title}:${trip.id}`} className="daily-brief-mini-row">
            <span>{getTripLabel(trip) || `Trip #${trip.id}`}</span>
            <strong>{formatTripTime(trip[timeKey])}</strong>
          </div>
        ))
      ) : (
        <div className="daily-brief-empty-row">Nothing scheduled.</div>
      )}
    </div>
  );
}

export default function DailyBriefPanel() {
  const [briefDate, setBriefDate] = useState(getTodayInputValue);
  const [context, setContext] = useState(null);
  const [brief, setBrief] = useState("");
  const [loadingContext, setLoadingContext] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const stats = useMemo(() => {
    const finance = context?.finance || {};
    const trips = context?.trips || {};
    const tasks = context?.tasks || {};
    const messages = context?.messages || {};
    return {
      openings: Array.isArray(trips.opening) ? trips.opening.length : 0,
      closings: Array.isArray(trips.closing) ? trips.closing.length : 0,
      closeouts: Array.isArray(trips.pendingCloseouts)
        ? trips.pendingCloseouts.length
        : Number(finance.openCloseoutCount || 0),
      taskBlockers: Array.isArray(tasks.blockers) ? tasks.blockers.length : 0,
      unreadGuests: Number(messages.unreadGuestCount || 0),
      mtdRevenue: formatMoney(finance.monthToDateRevenue),
      closeoutTolls: formatMoney(finance.openCloseoutTolls),
    };
  }, [context]);

  async function loadContext() {
    setLoadingContext(true);
    setError("");
    try {
      const params = new URLSearchParams({
        date: briefDate,
        timeZone: DEFAULT_TIME_ZONE,
      });
      const res = await fetch(
        `${API_BASE}/api/metrics/daily-brief/context?${params.toString()}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Failed to load brief context (${res.status})`);
      }
      setContext(data);
    } catch (err) {
      setError(err.message || "Failed to load daily brief context");
    } finally {
      setLoadingContext(false);
    }
  }

  async function generateBrief() {
    setGenerating(true);
    setError("");
    setCopied(false);
    try {
      const res = await fetch(`${API_BASE}/api/metrics/daily-brief`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          date: briefDate,
          timeZone: DEFAULT_TIME_ZONE,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Failed to generate brief (${res.status})`);
      }
      setBrief(String(data?.brief || "").trim());
      setContext(data?.context || null);
    } catch (err) {
      setError(err.message || "Failed to generate daily brief");
    } finally {
      setGenerating(false);
    }
  }

  async function copyBrief() {
    const text = brief.trim();
    if (!text) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not copy the brief from this browser");
    }
  }

  useEffect(() => {
    loadContext();
  }, [briefDate]);

  const openingTrips = context?.trips?.opening || [];
  const closingTrips = context?.trips?.closing || [];
  const pendingCloseouts = context?.trips?.pendingCloseouts || [];
  const taskSample = context?.tasks?.sample || [];

  return (
    <section className="daily-brief-shell">
      <div className="daily-brief-main">
        <div className="daily-brief-toolbar">
          <div>
            <h2>Daily Brief</h2>
            <p>AM operations, money, and blockers in paste-ready form.</p>
          </div>
          <div className="daily-brief-controls">
            <label>
              <span>Date</span>
              <input
                type="date"
                value={briefDate}
                onChange={(event) => setBriefDate(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="daily-brief-button"
              disabled={loadingContext}
              onClick={loadContext}
            >
              {loadingContext ? "Refreshing..." : "Refresh"}
            </button>
            <button
              type="button"
              className="daily-brief-button daily-brief-button--primary"
              disabled={generating}
              onClick={generateBrief}
            >
              {generating ? "Generating..." : "Generate brief"}
            </button>
          </div>
        </div>

        {error ? <div className="daily-brief-error">{error}</div> : null}

        <div className="daily-brief-stats">
          <StatTile label="Opening" value={stats.openings} />
          <StatTile label="Closing" value={stats.closings} />
          <StatTile label="Closeout" value={stats.closeouts} detail={stats.closeoutTolls} />
          <StatTile label="Task blockers" value={stats.taskBlockers} />
          <StatTile label="Guest unread" value={stats.unreadGuests} />
          <StatTile label="MTD revenue" value={stats.mtdRevenue} />
        </div>

        <div className="daily-brief-output">
          <div className="daily-brief-output-head">
            <span>Brief copy</span>
            <button
              type="button"
              className="daily-brief-button"
              disabled={!brief}
              onClick={copyBrief}
            >
              {copied ? "Copied" : "Copy text"}
            </button>
          </div>
          {brief ? (
            <pre>{brief}</pre>
          ) : (
            <div className="daily-brief-placeholder">
              Generate the AM brief when you are ready to post it.
            </div>
          )}
        </div>
      </div>

      <aside className="daily-brief-side">
        <TripList title="Opening trips" trips={openingTrips} timeKey="start" />
        <TripList title="Closing trips" trips={closingTrips} timeKey="end" />
        <TripList title="Pending closeouts" trips={pendingCloseouts} timeKey="end" />

        <div className="daily-brief-mini-list">
          <div className="daily-brief-mini-title">
            <span>Task sample</span>
            <strong>{taskSample.length}</strong>
          </div>
          {taskSample.length ? (
            taskSample.slice(0, 6).map((task) => (
              <div key={task.id} className="daily-brief-mini-row">
                <span>{task.vehicleName || "Vehicle"}: {task.title}</span>
                <strong>{task.priority || "task"}</strong>
              </div>
            ))
          ) : (
            <div className="daily-brief-empty-row">No open maintenance tasks.</div>
          )}
        </div>
      </aside>
    </section>
  );
}
