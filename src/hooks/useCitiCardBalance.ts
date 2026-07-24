import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../lib/apiClient";

function numberOrNull(value: unknown) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? null : number;
}

export function useCitiCardBalance() {
  const [citiCardBalance, setCitiCardBalance] = useState({
    configured: null as boolean | null,
    found: null as boolean | null,
    loading: true,
    currentBalance: null as number | null,
    availableBalance: null as number | null,
    debtBalance: null as number | null,
    lastFour: "4483",
    balanceSource: null as string | null,
    fetchedAt: null as string | null,
    lastCheckedAt: null as string | null,
    reconciledAt: null as string | null,
    anchorSource: null as string | null,
    reconciling: false,
  });

  const applyBalance = useCallback((data: Record<string, unknown>) => {
    setCitiCardBalance((current) => ({
      ...current,
      configured: Boolean(data.configured),
      found: Boolean(data.found),
      loading: false,
      currentBalance: numberOrNull(data.currentBalance),
      availableBalance: numberOrNull(data.availableBalance),
      debtBalance: numberOrNull(data.debtBalance),
      lastFour: String(data.lastFour || "4483"),
      balanceSource: data.balanceSource ? String(data.balanceSource) : null,
      fetchedAt: data.fetchedAt ? String(data.fetchedAt) : null,
      lastCheckedAt: data.lastCheckedAt
        ? String(data.lastCheckedAt)
        : data.fetchedAt
          ? String(data.fetchedAt)
          : null,
      reconciledAt: data.reconciledAt ? String(data.reconciledAt) : null,
      anchorSource: data.anchorSource ? String(data.anchorSource) : null,
    }));
  }, []);

  const loadCitiCardBalance = useCallback(async () => {
    try {
      setCitiCardBalance((current) => ({ ...current, loading: true }));

      const res = await fetch(`${API_BASE}/api/plaid/citi-4483/balance`, {
        headers: { Accept: "application/json" },
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data?.error || `Citi balance failed (${res.status})`);
      }

      applyBalance(data);
    } catch {
      setCitiCardBalance((current) => ({
        ...current,
        loading: false,
      }));
    }
  }, [applyBalance]);

  const reconcileBalance = useCallback(async (currentBalance: number) => {
    setCitiCardBalance((current) => ({ ...current, reconciling: true }));
    try {
      const res = await fetch(`${API_BASE}/api/plaid/citi-4483/balance`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ currentBalance }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Citi reconciliation failed (${res.status})`);
      applyBalance(data);
      return data;
    } finally {
      setCitiCardBalance((current) => ({ ...current, reconciling: false }));
    }
  }, [applyBalance]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (cancelled) return;
      await loadCitiCardBalance();
    }
    load();
    const interval = window.setInterval(load, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadCitiCardBalance]);

  return {
    ...citiCardBalance,
    reconcileBalance,
    refresh: loadCitiCardBalance,
  };
}
