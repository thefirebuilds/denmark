import { useCallback, useEffect, useRef, useState } from "react";
import { APP_EVENTS } from "../app/appEvents";
import { API_BASE, isBackendUnavailableError } from "../lib/apiClient";

const APP_TITLE = "Trip Dispatch Console";

type UseMessageStatsOptions = {
  returnToStartup: (label?: string) => void;
  startupReady: boolean;
};

export function useMessageStats({
  returnToStartup,
  startupReady,
}: UseMessageStatsOptions) {
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

  const playMailChime = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.currentTime = 0;
    audio.play().catch((err) => {
      console.warn("Mail chime playback blocked or failed:", err);
    });
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) {
      window.__testMailChime = playMailChime;
    }

    return () => {
      if (import.meta.env.DEV && window.__testMailChime === playMailChime) {
        delete window.__testMailChime;
      }
    };
  }, [playMailChime]);

  useEffect(() => {
    const unread = messageStats?.unread ?? 0;
    document.title = unread > 0 ? `(${unread}) ${APP_TITLE}` : APP_TITLE;

    return () => {
      document.title = APP_TITLE;
    };
  }, [messageStats?.unread]);

  const loadMessageStats = useCallback(async (cancelled = false) => {
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
        const unreadIncreased = prevUnread !== null && nextUnread > prevUnread;
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
  }, [playMailChime, returnToStartup]);

  useEffect(() => {
    let cancelled = false;

    function handleStatsUpdated() {
      loadMessageStats(cancelled);
    }

    if (startupReady) {
      loadMessageStats(cancelled);
    }

    if (!startupReady) {
      return () => {
        cancelled = true;
      };
    }

    const interval = window.setInterval(() => {
      loadMessageStats(cancelled);
    }, 30000);

    window.addEventListener(APP_EVENTS.messageStatsUpdated, handleStatsUpdated);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(
        APP_EVENTS.messageStatsUpdated,
        handleStatsUpdated
      );
    };
  }, [loadMessageStats, startupReady]);

  return {
    messageStats,
    messageStatsLoading,
    messageStatsRefreshing,
    setMessageStatsLoading,
    setMessageStatsRefreshing,
  };
}
