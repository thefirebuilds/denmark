import { useEffect, useState } from "react";
import { API_BASE } from "../lib/apiClient";

export function useMercuryBalance() {
  const [mercuryBalance, setMercuryBalance] = useState({
    configured: null as boolean | null,
    loading: true,
    availableBalance: null as number | null,
    currentBalance: null as number | null,
    accountCount: 0,
    fetchedAt: null as string | null,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadMercuryBalance() {
      try {
        setMercuryBalance((current) => ({ ...current, loading: true }));

        const res = await fetch(`${API_BASE}/api/banking/mercury/balance`, {
          headers: { Accept: "application/json" },
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data?.error || `Mercury balance failed (${res.status})`);
        }

        if (!cancelled) {
          setMercuryBalance({
            configured: Boolean(data.configured),
            loading: false,
            availableBalance: data.availableBalance ?? null,
            currentBalance: data.currentBalance ?? null,
            accountCount: Number(data.accountCount || 0),
            fetchedAt: data.fetchedAt || null,
          });
        }
      } catch {
        if (!cancelled) {
          setMercuryBalance((current) => ({
            ...current,
            loading: false,
          }));
        }
      }
    }

    loadMercuryBalance();
    const interval = window.setInterval(loadMercuryBalance, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return mercuryBalance;
}
