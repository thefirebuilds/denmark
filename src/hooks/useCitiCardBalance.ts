import { useEffect, useState } from "react";
import { API_BASE } from "../lib/apiClient";

export function useCitiCardBalance() {
  const [citiCardBalance, setCitiCardBalance] = useState({
    configured: null as boolean | null,
    found: null as boolean | null,
    loading: true,
    currentBalance: null as number | null,
    availableBalance: null as number | null,
    debtBalance: null as number | null,
    lastFour: "4483",
    fetchedAt: null as string | null,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadCitiCardBalance() {
      try {
        setCitiCardBalance((current) => ({ ...current, loading: true }));

        const res = await fetch(`${API_BASE}/api/teller/citi-4483/balance`, {
          headers: { Accept: "application/json" },
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data?.error || `Citi balance failed (${res.status})`);
        }

        if (!cancelled) {
          setCitiCardBalance({
            configured: Boolean(data.configured),
            found: Boolean(data.found),
            loading: false,
            currentBalance: data.currentBalance ?? null,
            availableBalance: data.availableBalance ?? null,
            debtBalance: data.debtBalance ?? null,
            lastFour: data.lastFour || "4483",
            fetchedAt: data.fetchedAt || null,
          });
        }
      } catch {
        if (!cancelled) {
          setCitiCardBalance((current) => ({
            ...current,
            loading: false,
          }));
        }
      }
    }

    loadCitiCardBalance();
    const interval = window.setInterval(loadCitiCardBalance, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return citiCardBalance;
}
