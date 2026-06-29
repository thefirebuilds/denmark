import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  DEFAULT_DISPATCH_SETTINGS,
  mergeDispatchSettings,
} from "../app/dispatchSettings";
import {
  API_BASE,
  delay,
  isBackendUnavailableError,
  timedStartupFetch,
} from "../lib/apiClient";
import type { MarkAuthenticatedInput } from "./useAuthStatus";
import type { TripLike, UnknownRecord } from "../app/appTypes";

type StartupState = {
  ready: boolean;
  label: string;
  error: string;
};

type UseStartupOptions = {
  markAuthenticated: (data: MarkAuthenticatedInput) => void;
  markAuthRequired: () => void;
  setSelectedTrip: Dispatch<SetStateAction<TripLike | null>>;
  setMessageMode: Dispatch<SetStateAction<"live" | "trip">>;
};

export function useStartup({
  markAuthenticated,
  markAuthRequired,
  setSelectedTrip,
  setMessageMode,
}: UseStartupOptions) {
  const [startup, setStartup] = useState<StartupState>({
    ready: false,
    label: "Starting Denmark",
    error: "",
  });
  const [trips, setTrips] = useState<TripLike[]>([]);
  const [startupVehicles, setStartupVehicles] = useState<UnknownRecord[]>([]);
  const [startupMessages, setStartupMessages] = useState<UnknownRecord[]>([]);
  const [dispatchSettings, setDispatchSettings] = useState(
    DEFAULT_DISPATCH_SETTINGS
  );

  const returnToStartup = useCallback((label = "Waiting for backend") => {
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
    setSelectedTrip(null);
    setMessageMode("live");
  }, [
    setMessageMode,
    setSelectedTrip,
  ]);

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
          const meRes = await timedStartupFetch("auth", `${API_BASE}/api/me`, {
            headers: { Accept: "application/json" },
          });

          if (meRes.status === 401) {
            if (cancelled) return;
            markAuthRequired();
            setStartup({
              ready: false,
              label: "Sign in required",
              error: "",
            });
            return;
          }

          if (!meRes.ok) {
            throw new Error(`Auth request failed: ${meRes.status}`);
          }

          const meData = (await meRes.json()) as MarkAuthenticatedInput;

          if (cancelled) return;
          markAuthenticated(meData);

          void timedStartupFetch(
            "background startup status",
            `${API_BASE}/api/startup/status`,
            {
              headers: { Accept: "application/json" },
            }
          )
            .then(async (statusRes) => {
              if (!statusRes.ok) return null;
              return statusRes.json();
            })
            .then((statusData) => {
              if (!statusData?.completed) {
                const running = Array.isArray(statusData?.running)
                  ? statusData.running
                  : [];
                const pending = Array.isArray(statusData?.pending)
                  ? statusData.pending
                  : [];
                const activeJobs = running.length ? running : pending;
                if (activeJobs.length) {
                  console.info(
                    `[startup] background jobs still running: ${activeJobs.join(
                      ", "
                    )}`
                  );
                }
              }
            })
            .catch((err) => {
              console.warn("Startup status check failed:", err);
            });

          setStartup({
            ready: false,
            label: "Loading dispatch settings",
            error: "",
          });

          const settingsRes = await timedStartupFetch(
            "dispatch settings",
            `${API_BASE}/api/settings/ui.dispatch`
          );
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

          const [tripsRes, vehiclesRes, messagesRes] = await Promise.all([
            timedStartupFetch("trips", `${API_BASE}/api/trips?scope=all`, {
              headers: { Accept: "application/json" },
            }),
            timedStartupFetch(
              "cached vehicle telemetry",
              `${API_BASE}/api/vehicles/cached-status`,
              {
                headers: { Accept: "application/json" },
              }
            ),
            timedStartupFetch(
              "dispatch tasks",
              `${API_BASE}/api/messages?limit=25&fast=1&light=1&debug=1`,
              {
                headers: { Accept: "application/json" },
              }
            ),
          ]);

          const failures = ([
            ["trips", tripsRes],
            ["vehicle telemetry", vehiclesRes],
            ["dispatch tasks", messagesRes],
          ] as Array<[string, Response]>).filter(([, res]) => !res.ok);

          if (failures.length > 0) {
            const [name, res] = failures[0];
            throw new Error(`${name} request failed: ${res.status}`);
          }

          const [tripsData, vehiclesData, messagesData] = await Promise.all([
            tripsRes.json(),
            vehiclesRes.json(),
            messagesRes.json(),
          ]);

          if (cancelled) return;

          const startupMessageItems = Array.isArray(messagesData)
            ? messagesData
            : messagesData?.items;
          if (messagesData?.debugTiming) {
            console.info(
              `[startup] dispatch tasks debug ${JSON.stringify(
                messagesData.debugTiming
              )}`
            );
          }

          setTrips(Array.isArray(tripsData) ? tripsData : []);
          setStartupVehicles(Array.isArray(vehiclesData) ? vehiclesData : []);
          setStartupMessages(
            Array.isArray(startupMessageItems)
              ? startupMessageItems.slice(0, 10)
              : []
          );
          setStartup({
            ready: true,
            label: "Ready",
            error: "",
          });
          return;
        } catch (err) {
          console.warn("Startup load failed, retrying:", err);

          if (cancelled) return;

          setStartup({
            ready: false,
            label: isBackendUnavailableError(err)
              ? "Waiting for backend"
              : "Waiting for startup data",
            error:
              err instanceof Error
                ? err.message
                : "Startup request failed. Retrying...",
          });

          await delay(1500);
          if (cancelled) return;
        }
      }
    }

    loadStartup();

    return () => {
      cancelled = true;
    };
  }, [markAuthRequired, markAuthenticated, startup.ready]);

  return {
    dispatchSettings,
    returnToStartup,
    setDispatchSettings,
    setTrips,
    startup,
    startupMessages,
    startupVehicles,
    trips,
  };
}
