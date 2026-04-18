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

const APP_TITLE = "Trip Dispatch Console";
const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

const DEFAULT_DISPATCH_SETTINGS = {
  openTripsSort: "priority",
  pinOverdue: true,
  showCanceled: false,
  bucketOrder: [
    "needs_closeout",
    "in_progress",
    "unconfirmed",
    "upcoming",
    "canceled",
    "closed",
  ],
};

export default function Home() {
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [trips, setTrips] = useState([]);
  const [activeView, setActiveView] = useState("dispatch");
  const [selectedVehicleId, setSelectedVehicleId] = useState("belle");
  const [selectedExpenseVehicleId, setSelectedExpenseVehicleId] = useState<number | null>(null);
  const [dispatchSettings, setDispatchSettings] = useState(DEFAULT_DISPATCH_SETTINGS);

  const [messageStats, setMessageStats] = useState({
    unread: 0,
    lastReceived: null as string | null,
  });
  const [messageStatsLoading, setMessageStatsLoading] = useState(true);
  const [messageStatsRefreshing, setMessageStatsRefreshing] = useState(false);

  const previousUnreadRef = useRef<number | null>(null);
  const lastChimeAtRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

    async function loadDispatchSettings() {
      try {
        const res = await fetch(`${API_BASE}/api/settings/ui.dispatch`);
        if (!res.ok) throw new Error(`Settings request failed: ${res.status}`);
        const data = await res.json();

        if (!cancelled) {
          setDispatchSettings({
            ...DEFAULT_DISPATCH_SETTINGS,
            ...(data?.value || {}),
          });
        }
      } catch (err) {
        console.warn("Dispatch settings load failed:", err);
      }
    }

    loadDispatchSettings();

    return () => {
      cancelled = true;
    };
  }, []);

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

    loadMessageStats(cancelled);

    const interval = window.setInterval(() => {
      loadMessageStats(cancelled);
    }, 30000);

    window.addEventListener("messages:stats-updated", handleStatsUpdated);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("messages:stats-updated", handleStatsUpdated);
    };
  }, []);

  function handleTripUpdated(savedTrip) {
    setSelectedTrip((prev) =>
      prev?.id === savedTrip?.id ? savedTrip : prev
    );
  }

  return (
    <div className="app">
      <Rail activeView={activeView} onChangeView={setActiveView} />

      <TopBanner
        stats={messageStats}
        loading={messageStatsLoading}
        refreshing={messageStatsRefreshing}
      />

      {activeView === "maintenance" ? (
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
            onSelectTrip={setSelectedTrip}
            trips={trips}
            setTrips={setTrips}
            dispatchSettings={dispatchSettings}
          />

          <MessagesPanel
            selectedTrip={selectedTrip}
            onClearSelectedTrip={() => setSelectedTrip(null)}
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
