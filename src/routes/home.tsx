// --------------------------------------------------------------
// /src/routes/home.tsx
// file to hold the main home page of the app, which includes the rail,
// top banner, and panels for trips, messages, fleet maintenance,
// expenses, inbox, ledger, metrics, and marketplace
// --------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import "../styles/styles.css";
import "../styles/trips.css";
import "../styles/maintenance.css";
import "../styles/expenses.css";
import "../styles/tripSummary.css";
import "../styles/inbox.css";
import "../styles/metrics.css";
import "../styles/marketplace.css";
import "../styles/settings.css";

import Rail from "../components/Rail";
import TopBanner from "../components/TopBanner";
import TripsPanel from "../components/TripsPanel";
import MessagesPanel from "../components/MessagesPanel";
import FleetListPanel from "../components/maintenance/FleetListPanel";
import FleetMaintenancePanel from "../components/maintenance/FleetMaintenancePanel";
import DetailPanel from "../components/detail-panel/DetailPanel";
import MaintenanceQueuePanel from "../components/maintenance/MaintenanceQueuePanel";
import ExpensesVehicleListPanel from "../components/expenses/ExpensesVehicleListPanel";
import ExpensesPanel from "../components/expenses/ExpensesPanel";
import ExpensesSummaryPanel from "../components/expenses/ExpensesSummaryPanel.jsx";
import TripSummary from "../components/TripSummary";
import InboxPanel from "../components/inbox/InboxPanel";
import MetricsPanel from "../components/MetricsPanel";
import MarketplacePanel from "../components/MarketplacePanel";
import SettingsPanel from "../components/settings/SettingsPanel";
import MobileMaintenanceShell from "../components/mobile/MobileMaintenanceShell";

const APP_TITLE = "Trip Dispatch Console";
const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";
const LAYOUT_MODE_STORAGE_KEY = "denmark.layoutMode";
const MOBILE_LAYOUT_QUERY = "(max-width: 900px)";
const LOCAL_API_ORIGINS = new Set([
  "http://localhost:5000",
  "http://127.0.0.1:5000",
]);
const TRIP_LEDGER_FOCUS_STORAGE_KEY = "denmark.tripLedgerFocus";
const EXPENSE_LEDGER_FOCUS_STORAGE_KEY = "denmark.expenseLedgerFocus";

const DEFAULT_DISPATCH_SETTINGS = {
  openTripsSort: "priority",
  pinOverdue: true,
  showCanceled: false,
  visibleBuckets: {
    needs_closeout: true,
    in_progress: true,
    unconfirmed: true,
    upcoming: true,
    canceled: false,
    closed: false,
  },
  bucketOrder: [
    "needs_closeout",
    "in_progress",
    "unconfirmed",
    "upcoming",
    "canceled",
    "closed",
  ],
};

function mergeDispatchSettings(settings: any) {
  const visibleBuckets = {
    ...DEFAULT_DISPATCH_SETTINGS.visibleBuckets,
    ...(settings?.visibleBuckets || {}),
  };

  if (!settings?.visibleBuckets && settings?.showCanceled !== undefined) {
    visibleBuckets.canceled = Boolean(settings.showCanceled);
  }

  return {
    ...DEFAULT_DISPATCH_SETTINGS,
    ...(settings || {}),
    visibleBuckets,
    showCanceled: Boolean(visibleBuckets.canceled),
    bucketOrder:
      Array.isArray(settings?.bucketOrder) && settings.bucketOrder.length
        ? settings.bucketOrder
        : DEFAULT_DISPATCH_SETTINGS.bucketOrder,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isBackendUnavailableError(err: unknown) {
  if (err instanceof TypeError) return true;

  const message = err instanceof Error ? err.message : String(err || "");
  return (
    /failed to fetch/i.test(message) ||
    /networkerror/i.test(message) ||
    /request failed:\s*5\d\d/i.test(message) ||
    /http\s*5\d\d/i.test(message) ||
    /\b5\d\d\b/.test(message)
  );
}

function getFetchUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isApiFetch(input: RequestInfo | URL) {
  const url = getFetchUrl(input);
  return url.startsWith(API_BASE) || url.startsWith("/api/");
}

function rewriteDevApiRequest(input: RequestInfo | URL) {
  if (typeof window === "undefined") return input;

  if (typeof input !== "string" && !(input instanceof URL)) {
    return input;
  }

  const rawUrl = typeof input === "string" ? input : input.toString();
  if (!rawUrl) return input;

  try {
    const parsed = new URL(rawUrl, window.location.origin);
    const isLegacyLocalApi = LOCAL_API_ORIGINS.has(parsed.origin);
    const sameOriginFrontend = parsed.origin === window.location.origin;

    if (!isLegacyLocalApi || sameOriginFrontend) {
      return input;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return input;
  }
}

function getSavedLayoutMode() {
  if (typeof window === "undefined") return "auto";

  const saved = window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY);
  return saved === "desktop" || saved === "mobile" || saved === "auto"
    ? saved
    : "auto";
}

function getIsCompactViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

export default function Home() {
  const [authInfo, setAuthInfo] = useState<{
    authEnforced: boolean;
    displayName: string | null;
    role: string | null;
  } | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [trips, setTrips] = useState([]);
  const [startupVehicles, setStartupVehicles] = useState([]);
  const [startupMessages, setStartupMessages] = useState([]);
  const [activeView, setActiveView] = useState("dispatch");
  const [messageMode, setMessageMode] = useState<"live" | "trip">("live");
  const [selectedVehicleId, setSelectedVehicleId] = useState("belle");
  const [selectedExpenseVehicleId, setSelectedExpenseVehicleId] = useState<number | null>(null);
  const [dispatchSettings, setDispatchSettings] = useState(DEFAULT_DISPATCH_SETTINGS);
  const [layoutMode, setLayoutMode] = useState<"auto" | "desktop" | "mobile">(
    getSavedLayoutMode
  );
  const [isCompactViewport, setIsCompactViewport] = useState(getIsCompactViewport);
  const [startup, setStartup] = useState({
    ready: false,
    label: "Starting Denmark",
    error: "",
  });

  const [messageStats, setMessageStats] = useState({
    unread: 0,
    lastReceived: null as string | null,
  });
  const [messageStatsLoading, setMessageStatsLoading] = useState(true);
  const [messageStatsRefreshing, setMessageStatsRefreshing] = useState(false);

  const previousUnreadRef = useRef<number | null>(null);
  const lastChimeAtRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function returnToStartup(label = "Waiting for backend") {
    setStartup((current) => {
      if (!current.ready && current.label === label && !current.error) {
        return current;
      }

      return {
        ready: false,
        label,
        error: "",
      };
    });
    setMessageStatsLoading(true);
    setMessageStatsRefreshing(false);
    setSelectedTrip(null);
    setMessageMode("live");
  }

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input, init) => {
      const rewrittenInput = rewriteDevApiRequest(input);
      const apiRequest = isApiFetch(rewrittenInput);

      try {
        const response = await originalFetch(rewrittenInput, init);

        if (apiRequest && response.status >= 500) {
          window.dispatchEvent(new CustomEvent("denmark:backend-unavailable"));
        }

        return response;
      } catch (err) {
        if (apiRequest) {
          window.dispatchEvent(new CustomEvent("denmark:backend-unavailable"));
        }

        throw err;
      }
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  useEffect(() => {
    function handleOpenExpenseLedger(event: Event) {
      const customEvent = event as CustomEvent;
      const detail = customEvent?.detail || null;
      if (detail && typeof window !== "undefined") {
        window.sessionStorage.setItem(
          EXPENSE_LEDGER_FOCUS_STORAGE_KEY,
          JSON.stringify(detail)
        );
      }

      if (detail?.vehicleId != null) {
        setSelectedExpenseVehicleId(Number(detail.vehicleId));
      } else {
        setSelectedExpenseVehicleId(null);
      }

      setActiveView("expenses");
    }

    window.addEventListener(
      "denmark:open-expense-ledger",
      handleOpenExpenseLedger as EventListener
    );

    return () => {
      window.removeEventListener(
        "denmark:open-expense-ledger",
        handleOpenExpenseLedger as EventListener
      );
    };
  }, []);

  useEffect(() => {
    function handleBackendUnavailable() {
      returnToStartup("Waiting for backend");
    }

    window.addEventListener(
      "denmark:backend-unavailable",
      handleBackendUnavailable
    );

    return () => {
      window.removeEventListener(
        "denmark:backend-unavailable",
        handleBackendUnavailable
      );
    };
  }, []);

  useEffect(() => {
    function handleOpenTripLedger(event: Event) {
      const customEvent = event as CustomEvent;
      const detail = customEvent?.detail || null;
      if (detail && typeof window !== "undefined") {
        window.sessionStorage.setItem(
          TRIP_LEDGER_FOCUS_STORAGE_KEY,
          JSON.stringify(detail)
        );
      }
      setActiveView("ledger");
    }

    window.addEventListener(
      "denmark:open-trip-ledger",
      handleOpenTripLedger as EventListener
    );

    return () => {
      window.removeEventListener(
        "denmark:open-trip-ledger",
        handleOpenTripLedger as EventListener
      );
    };
  }, []);

  useEffect(() => {
    audioRef.current = new Audio("boop.mp3");
    audioRef.current.preload = "auto";

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (startup.ready) {
      return () => {
        cancelled = true;
      };
    }

    async function loadStartup() {
      for (;;) {
        try {
          const meRes = await fetch(`${API_BASE}/api/me`, {
            headers: { Accept: "application/json" },
          });

          if (meRes.status === 401) {
            if (cancelled) return;
            setAuthRequired(true);
            setStartup({
              ready: false,
              label: "Sign in required",
              error: "",
            });
            setMessageStatsLoading(false);
            return;
          }

          if (!meRes.ok) {
            throw new Error(`Auth request failed: ${meRes.status}`);
          }

          const meData = await meRes.json();

          if (cancelled) return;
          setAuthRequired(false);
          setAuthInfo({
            authEnforced: meData?.auth_enforced !== false,
            displayName: meData?.display_name ?? null,
            role: meData?.role ?? null,
          });

          setStartup({
            ready: false,
            label: "Waiting for startup jobs",
            error: "",
          });

          for (;;) {
            const statusRes = await fetch(`${API_BASE}/api/startup/status`, {
              headers: { Accept: "application/json" },
            });

            if (!statusRes.ok) {
              throw new Error(
                `Startup status request failed: ${statusRes.status}`
              );
            }

            const statusData = await statusRes.json();
            if (statusData?.completed) break;

            const running = Array.isArray(statusData?.running)
              ? statusData.running
              : [];
            const pending = Array.isArray(statusData?.pending)
              ? statusData.pending
              : [];
            const activeJobs = running.length ? running : pending;

            if (cancelled) return;
            setStartup({
              ready: false,
              label: activeJobs.length
                ? `Running ${activeJobs.join(", ")}`
                : "Waiting for startup jobs",
              error: "",
            });

            await delay(900);
            if (cancelled) return;
          }

          setStartup({
            ready: false,
            label: "Loading dispatch settings",
            error: "",
          });

          const settingsRes = await fetch(`${API_BASE}/api/settings/ui.dispatch`);
          if (!settingsRes.ok) {
            throw new Error(`Settings request failed: ${settingsRes.status}`);
          }

          const settingsData = await settingsRes.json();
          const mergedSettings = mergeDispatchSettings(settingsData?.value);

          if (cancelled) return;
          setDispatchSettings(mergedSettings);
          setStartup({
            ready: false,
            label: "Loading trips, vehicles, and tasks",
            error: "",
          });

          const [statsRes, tripsRes, vehiclesRes, messagesRes] =
            await Promise.all([
              fetch(`${API_BASE}/api/messages/stats`, {
                headers: { Accept: "application/json" },
              }),
              fetch(`${API_BASE}/api/trips?scope=all`, {
                headers: { Accept: "application/json" },
              }),
              fetch(`${API_BASE}/api/vehicles/live-status`, {
                headers: { Accept: "application/json" },
              }),
              fetch(`${API_BASE}/api/messages`, {
                headers: { Accept: "application/json" },
              }),
            ]);

          const failures = [
            ["message stats", statsRes],
            ["trips", tripsRes],
            ["vehicle telemetry", vehiclesRes],
            ["dispatch tasks", messagesRes],
          ].filter(([, res]) => !res.ok);

          if (failures.length > 0) {
            const [name, res] = failures[0];
            throw new Error(`${name} request failed: ${res.status}`);
          }

          const [statsData, tripsData, vehiclesData, messagesData] =
            await Promise.all([
              statsRes.json(),
              tripsRes.json(),
              vehiclesRes.json(),
              messagesRes.json(),
            ]);

          if (cancelled) return;

          const nextUnread = Number(statsData?.unread ?? 0);
          previousUnreadRef.current = nextUnread;
          setMessageStats({
            unread: nextUnread,
            lastReceived: statsData?.lastReceived ?? null,
          });
          setMessageStatsLoading(false);
          setTrips(Array.isArray(tripsData) ? tripsData : []);
          setStartupVehicles(Array.isArray(vehiclesData) ? vehiclesData : []);
          setStartupMessages(
            Array.isArray(messagesData) ? messagesData.slice(0, 5) : []
          );
          setStartup({
            ready: true,
            label: "Ready",
            error: "",
          });
          setAuthRequired(false);
          return;
        } catch (err) {
          console.warn("Startup load failed, retrying:", err);

          if (cancelled) return;

          setStartup({
            ready: false,
            label: isBackendUnavailableError(err)
              ? "Waiting for backend"
              : "Waiting for startup data",
            error: "",
          });
          setMessageStatsLoading(true);

          await delay(1500);
          if (cancelled) return;
        }
      }
    }

    loadStartup();

    return () => {
      cancelled = true;
    };
  }, [startup.ready]);

  function playMailChime() {
    const audio = audioRef.current;
    if (!audio) return;

    audio.currentTime = 0;
    audio.play().catch((err) => {
      console.warn("Mail chime playback blocked or failed:", err);
    });
  }

  useEffect(() => {
    if (import.meta.env.DEV) {
      window.__testMailChime = playMailChime;
    }

    return () => {
      if (import.meta.env.DEV && window.__testMailChime === playMailChime) {
        delete window.__testMailChime;
      }
    };
  }, []);

  useEffect(() => {
    const unread = messageStats?.unread ?? 0;
    document.title = unread > 0 ? `(${unread}) ${APP_TITLE}` : APP_TITLE;

    return () => {
      document.title = APP_TITLE;
    };
  }, [messageStats?.unread]);

  async function loadMessageStats(cancelled = false) {
    try {
      if (!cancelled) {
        setMessageStatsRefreshing(true);
      }

      const res = await fetch(`${API_BASE}/api/messages/stats`, {
        headers: { Accept: "application/json" },
      });

      const text = await res.text();

      if (!res.ok) {
        throw new Error(`Failed to load message stats: ${res.status} ${text}`);
      }

      const data = JSON.parse(text);
      const nextUnread = Number(data?.unread ?? 0);

      if (!cancelled) {
        const prevUnread = previousUnreadRef.current;
        const now = Date.now();

        const unreadIncreased =
          prevUnread !== null && nextUnread > prevUnread;

        const enoughTimePassed = now - lastChimeAtRef.current > 1500;

        if (unreadIncreased && enoughTimePassed) {
          lastChimeAtRef.current = now;
          playMailChime();
        }

        previousUnreadRef.current = nextUnread;

        setMessageStats({
          unread: nextUnread,
          lastReceived: data?.lastReceived ?? null,
        });
      }
    } catch (err) {
      console.error("Message stats load failed:", err);

      if (!cancelled) {
        if (isBackendUnavailableError(err)) {
          returnToStartup("Waiting for backend");
          return;
        }

        setMessageStats({
          unread: 0,
          lastReceived: null,
        });
      }
    } finally {
      if (!cancelled) {
        setMessageStatsLoading(false);
        setMessageStatsRefreshing(false);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;

    function handleStatsUpdated() {
      loadMessageStats(cancelled);
    }

    if (startup.ready) {
      loadMessageStats(cancelled);
    }

    if (!startup.ready) {
      return () => {
        cancelled = true;
      };
    }

    const interval = window.setInterval(() => {
      loadMessageStats(cancelled);
    }, 30000);

    window.addEventListener("messages:stats-updated", handleStatsUpdated);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("messages:stats-updated", handleStatsUpdated);
    };
  }, [startup.ready]);

  function handleTripUpdated(savedTrip) {
    setSelectedTrip((prev) =>
      prev?.id === savedTrip?.id ? savedTrip : prev
    );
    setTrips((prev) =>
      prev.map((trip) => (trip.id === savedTrip?.id ? savedTrip : trip))
    );
  }

  function handleTripFocused(trip) {
    if (!trip?.id) return;

    setMessageMode("trip");
    setSelectedTrip(trip);
    setTrips((prev) =>
      prev.map((candidate) => (candidate.id === trip.id ? trip : candidate))
    );
  }

  function handleTripSelectedFromQueue(trip) {
    setSelectedTrip(trip);
    setMessageMode(trip?.id ? "trip" : "live");
  }

  function handleClearSelectedTrip() {
    setSelectedTrip(null);
    setMessageMode("live");
  }

  function handleOpenMaintenanceVehicle(vehicleId) {
    if (!vehicleId) return;

    setSelectedVehicleId(String(vehicleId).trim().toLowerCase().replace(/\s+/g, "_"));
    setActiveView("maintenance");
  }

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mediaQuery = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const handleChange = (event) => {
      setIsCompactViewport(event.matches);
    };

    setIsCompactViewport(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, layoutMode);
  }, [layoutMode]);

  const effectiveLayoutMode =
    layoutMode === "auto" ? (isCompactViewport ? "mobile" : "desktop") : layoutMode;
  const useMobileMaintenanceShell =
    activeView === "maintenance" && effectiveLayoutMode === "mobile";

  if (!startup.ready) {
    return (
      <div className="startup-screen">
        <div className="startup-card">
          <div className="startup-brand">
            <img
              src="/Fresh Coast-R3-05.png"
              alt="Fresh Coast"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          </div>
          <div>
            <div className="startup-eyebrow">Denmark</div>
            <h1>Bringing the dispatch board online</h1>
            <p>
              {startup.error
                ? startup.error
                : `${startup.label}. Hold tight while the queue gets its facts straight.`}
            </p>
          </div>

          {startup.error ? (
            <button
              type="button"
              className="startup-action"
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
          ) : authRequired ? (
            <button
              type="button"
              className="startup-action"
              onClick={() => {
                window.location.assign("/api/login");
              }}
            >
              Sign in
            </button>
          ) : (
            <div className="startup-progress" aria-label="Loading">
              <span />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${useMobileMaintenanceShell ? "app--mobile-maintenance" : ""}`}>
      <Rail activeView={activeView} onChangeView={setActiveView} />

      <TopBanner
        stats={messageStats}
        loading={messageStatsLoading}
        refreshing={messageStatsRefreshing}
        authInfo={authInfo}
        layoutMode={layoutMode}
        effectiveLayoutMode={effectiveLayoutMode}
        onChangeLayoutMode={setLayoutMode}
      />

      {useMobileMaintenanceShell ? (
        <MobileMaintenanceShell
          selectedVehicleId={selectedVehicleId}
          onSelectVehicle={setSelectedVehicleId}
        />
      ) : activeView === "maintenance" ? (
        <>
          <FleetListPanel
            selectedVehicleId={selectedVehicleId}
            onSelectVehicle={setSelectedVehicleId}
          />

          <FleetMaintenancePanel selectedVehicleId={selectedVehicleId} />

          <MaintenanceQueuePanel selectedVehicleId={selectedVehicleId} />
        </>
      ) : activeView === "expenses" ? (
        <>
          <ExpensesVehicleListPanel
            selectedVehicleId={selectedExpenseVehicleId}
            onSelectVehicle={setSelectedExpenseVehicleId}
          />

          <ExpensesPanel selectedVehicleId={selectedExpenseVehicleId} />

          <ExpensesSummaryPanel selectedVehicleId={selectedExpenseVehicleId} />
        </>
      ) : activeView === "ledger" ? (
        <div className="ledger-view-shell">
          <TripSummary />
        </div>
      ) : activeView === "inbox" ? (
        <InboxPanel />
      ) : activeView === "metrics" ? (
        <MetricsPanel />
            ) : activeView === "marketplace" ? (
            <div className="marketplace-view-shell">
              <MarketplacePanel />
            </div>
      ) : activeView === "settings" ? (
        <SettingsPanel
          dispatchSettings={dispatchSettings}
          onDispatchSettingsSaved={setDispatchSettings}
        />
      ) : (
        <>
          <TripsPanel
            selectedTrip={selectedTrip}
            onSelectTrip={handleTripSelectedFromQueue}
            trips={trips}
            setTrips={setTrips}
            dispatchSettings={dispatchSettings}
            initialVehicles={startupVehicles}
            initialLoadComplete={startup.ready}
          />

          <MessagesPanel
            selectedTrip={selectedTrip}
            messageMode={messageMode}
            onClearSelectedTrip={handleClearSelectedTrip}
            onSelectTrip={handleTripFocused}
            onOpenMaintenanceVehicle={handleOpenMaintenanceVehicle}
            initialMessages={startupMessages}
            initialUnreadCount={messageStats.unread}
            initialLoadComplete={startup.ready}
          />

          <DetailPanel
            selectedTrip={selectedTrip}
            onTripUpdated={handleTripUpdated}
            trips={trips}
          />
        </>
      )}
    </div>
  );
}
