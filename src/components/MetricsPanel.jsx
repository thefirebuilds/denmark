//----------------------------------------------
// /src/components/MetricsPanel.jsx
//----------------------------------------------

import { useEffect, useMemo, useState } from "react";
import ExpenseModal from "./expenses/ExpenseModal";
import MetricCard from "./metrics/MetricCard";
import OffTripMilesDrawer from "./metrics/OffTripMilesDrawer";
import TollStat from "./metrics/TollStat";
import TollAuditDrawer from "./metrics/TollAuditDrawer";
import VehicleComparisonRow from "./metrics/VehicleComparisonRow";
import VehicleFinancialDrawer from "./metrics/VehicleFinancialDrawer";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

const RANGE_OPTIONS = [
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All" },
];
const TRIP_LEDGER_FOCUS_STORAGE_KEY = "denmark.tripLedgerFocus";

function safeDivide(numerator, denominator) {
  const num = Number(numerator ?? 0);
  const den = Number(denominator ?? 0);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

function formatCurrency(value) {
  const num = Number(value ?? 0);
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatCurrencyCompact(value) {
  const num = Number(value ?? 0);
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSignedCurrency(value) {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num === 0) return formatCurrencyCompact(0);
  return `${num > 0 ? "+" : "-"}${formatCurrencyCompact(Math.abs(num))}`;
}

function formatNumber(value, digits = 0) {
  const num = Number(value ?? 0);
  return num.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value, digits = 0) {
  const num = Number(value ?? 0) * 100;
  return `${num.toFixed(digits)}%`;
}

function formatValueTrend(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount === 0) return "Flat";
  return `${amount > 0 ? "▲" : "▼"} ${formatCurrencyCompact(Math.abs(amount))}`;
}

function formatUpdatedLabel(value) {
  if (!value) return "Updated: --";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Updated: --";
  return `Updated: ${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function formatShortDate(value) {
  if (!value) return "--";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatConfidenceLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "Confidence: --";
  return `Confidence: ${text}`;
}

function formatInputValue(value) {
  return value == null ? "" : String(value);
}

function normalizeDateInputValue(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function buildYearMakeModel(profile) {
  return [profile?.year, profile?.make, profile?.model].filter(Boolean).join(" ");
}

function normalizeVehicleProfileForForm(profile) {
  return {
    ...profile,
    purchase_date: normalizeDateInputValue(profile?.purchase_date),
    placed_in_service_date: normalizeDateInputValue(
      profile?.placed_in_service_date
    ),
  };
}

function formatBusinessInputDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatFlagTitle(flag) {
  const expenseVendor = String(flag?.expense_vendor || "").trim();
  const expenseCategory = String(flag?.expense_category || "").trim();
  const guestName = String(flag?.guest_name || "").trim();
  const vehicleName = String(flag?.vehicle_name || "").trim();
  const reservationId = flag?.reservation_id;

  if (expenseVendor && flag?.expense_id) {
    return `${expenseVendor} · Expense #${flag.expense_id}`;
  }
  if (expenseCategory && flag?.expense_id) {
    return `${expenseCategory} · Expense #${flag.expense_id}`;
  }
  if (guestName && vehicleName) {
    return `${guestName} · ${vehicleName}`;
  }
  if (guestName && reservationId) {
    return `${guestName} · Reservation #${reservationId}`;
  }
  if (vehicleName && reservationId) {
    return `${vehicleName} · Reservation #${reservationId}`;
  }
  if (reservationId) {
    return `Reservation #${reservationId}`;
  }
  return String(flag?.flag_code || "")
    .replaceAll("_", " ")
    .trim();
}

function formatFlagMeta(flag) {
  const parts = [];
  if (flag?.expense_id) {
    parts.push(`Expense #${flag.expense_id}`);
  }
  if (flag?.reservation_id) {
    parts.push(`Reservation #${flag.reservation_id}`);
  }
  if (Array.isArray(flag?.missing_fields) && flag.missing_fields.length) {
    parts.push(`Missing ${flag.missing_fields.join(" + ")}`);
  }
  return parts.join(" · ");
}

function getVehicleTollRiskScore(vehicle) {
  const paid = Number(vehicle?.tolls_paid ?? 0);
  const recovered = Number(vehicle?.tolls_recovered ?? 0);
  const outstanding = Number(vehicle?.tolls_attributed_outstanding ?? 0);
  const unattributed = Number(vehicle?.tolls_unattributed ?? 0);

  const recoveryRate = paid > 0 ? recovered / paid : 1;
  const effectiveRecoveryRate = paid > 0 ? (recovered + outstanding) / paid : 1;
  const leakageShare = paid > 0 ? unattributed / paid : 0;

  if (paid <= 0 && unattributed <= 0) return 0;
  if (
    unattributed >= 75 ||
    leakageShare >= 0.35 ||
    effectiveRecoveryRate < 0.5
  ) {
    return 2;
  }
  if (
    unattributed > 0 ||
    recoveryRate < 0.8 ||
    effectiveRecoveryRate < 0.9
  ) {
    return 1;
  }
  return 0;
}

function getCapitalRecoveryPct(vehicle) {
  if (vehicle?.capital_recovery_pct != null) {
    return Number(vehicle.capital_recovery_pct) / 100;
  }

  const basis = Number(vehicle?.capital_basis ?? 0);
  const recovered = Number(vehicle?.capital_recovered ?? 0);

  if (basis <= 0) return 0;
  return recovered / basis;
}

export default function MetricsPanel() {
  const [selectedRange, setSelectedRange] = useState("30d");
  const [summary, setSummary] = useState(null);
  const [businessMetrics, setBusinessMetrics] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fmvRefreshing, setFmvRefreshing] = useState(false);
  const [fmvRefreshStatus, setFmvRefreshStatus] = useState("");

  const [expandedVehicleId, setExpandedVehicleId] = useState(null);
  const [sortBy, setSortBy] = useState("profit_desc");
  const [filterBy, setFilterBy] = useState("all");
  const [offTripAuditOpen, setOffTripAuditOpen] = useState(false);
  const [offTripAudit, setOffTripAudit] = useState(null);
  const [offTripAuditLoading, setOffTripAuditLoading] = useState(false);
  const [offTripAuditError, setOffTripAuditError] = useState(null);
  const [tollAuditOpen, setTollAuditOpen] = useState(false);
  const [tollAuditFocus, setTollAuditFocus] = useState("unattributed");
  const [tollAudit, setTollAudit] = useState(null);
  const [tollAuditLoading, setTollAuditLoading] = useState(false);
  const [tollAuditError, setTollAuditError] = useState(null);
  const [assigningTollChargeId, setAssigningTollChargeId] = useState(null);
  const [financialDetailOpen, setFinancialDetailOpen] = useState(false);
  const [financialDetailVehicle, setFinancialDetailVehicle] = useState(null);
  const [financialDetailFocus, setFinancialDetailFocus] = useState("expenses");
  const [financialDetail, setFinancialDetail] = useState(null);
  const [financialDetailLoading, setFinancialDetailLoading] = useState(false);
  const [financialDetailError, setFinancialDetailError] = useState(null);
  const [editingExpense, setEditingExpense] = useState(null);
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [loadingExpenseId, setLoadingExpenseId] = useState(null);
  const [businessSettings, setBusinessSettings] = useState(null);
  const [vehicleProfiles, setVehicleProfiles] = useState([]);
  const [businessInputsLoading, setBusinessInputsLoading] = useState(true);
  const [businessInputsError, setBusinessInputsError] = useState("");
  const [businessInputsStatus, setBusinessInputsStatus] = useState("");
  const [savingBusinessSettings, setSavingBusinessSettings] = useState(false);
  const [savingVehicleId, setSavingVehicleId] = useState(null);
  const [businessInputsSectionOpen, setBusinessInputsSectionOpen] = useState(false);
  const [businessSettingsOpen, setBusinessSettingsOpen] = useState(false);
  const [expandedBusinessProfiles, setExpandedBusinessProfiles] = useState({});

  async function loadMetrics(
    range,
    { resetExpanded = true, showPageLoading = true } = {}
  ) {
    if (showPageLoading) {
      setLoading(true);
    }
    setError(null);

    const params = new URLSearchParams({ range });

    const [summaryRes, vehiclesRes, businessRes] = await Promise.all([
      fetch(`${API_BASE}/api/metrics/summary?${params.toString()}`, {
        headers: { Accept: "application/json" },
      }),
      fetch(`${API_BASE}/api/metrics/vehicles?${params.toString()}`, {
        headers: { Accept: "application/json" },
      }),
      fetch(`${API_BASE}/api/metrics/business/current?${params.toString()}`, {
        headers: { Accept: "application/json" },
      }),
    ]);

    const summaryText = await summaryRes.text();
    const vehiclesText = await vehiclesRes.text();
    const businessText = await businessRes.text();

    if (!summaryRes.ok) {
      throw new Error(
        `Summary request failed: ${summaryRes.status} ${summaryText}`
      );
    }

    if (!vehiclesRes.ok) {
      throw new Error(
        `Vehicles request failed: ${vehiclesRes.status} ${vehiclesText}`
      );
    }

    const summaryData = JSON.parse(summaryText);
    const vehiclesData = JSON.parse(vehiclesText);
    const businessData = businessRes.ok ? JSON.parse(businessText) : null;

    setSummary(summaryData);
    setBusinessMetrics(businessData);
    setVehicles(
      Array.isArray(vehiclesData)
        ? vehiclesData
        : Array.isArray(vehiclesData?.vehicles)
        ? vehiclesData.vehicles
        : []
    );

    if (resetExpanded) {
      setExpandedVehicleId(null);
    }
  }

  function toggleBusinessProfile(vehicleId) {
    setExpandedBusinessProfiles((current) => ({
      ...current,
      [vehicleId]: !current[vehicleId],
    }));
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        await loadMetrics(selectedRange, { showPageLoading: true });
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Unknown error");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [selectedRange]);

  async function loadBusinessInputs() {
    setBusinessInputsLoading(true);
    setBusinessInputsError("");

    try {
      const [settingsRes, profilesRes] = await Promise.all([
        fetch(`${API_BASE}/api/metrics/business/settings`, {
          headers: { Accept: "application/json" },
        }),
        fetch(`${API_BASE}/api/metrics/business/vehicle-profiles`, {
          headers: { Accept: "application/json" },
        }),
      ]);

      const settingsText = await settingsRes.text();
      const profilesText = await profilesRes.text();

      if (!settingsRes.ok) {
        throw new Error(
          `Business settings request failed: ${settingsRes.status} ${settingsText}`
        );
      }

      if (!profilesRes.ok) {
        throw new Error(
          `Vehicle profiles request failed: ${profilesRes.status} ${profilesText}`
        );
      }

      const settingsData = settingsText ? JSON.parse(settingsText) : {};
      const profilesData = profilesText ? JSON.parse(profilesText) : {};

      setBusinessSettings(settingsData || {});
      setVehicleProfiles(
        Array.isArray(profilesData?.profiles)
          ? profilesData.profiles.map(normalizeVehicleProfileForForm)
          : []
      );
    } finally {
      setBusinessInputsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadInputs() {
      try {
        await loadBusinessInputs();
      } catch (err) {
        if (!cancelled) {
          setBusinessInputsError(
            err.message || "Failed to load business input settings"
          );
          setBusinessInputsLoading(false);
        }
      }
    }

    loadInputs();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRefreshFmvNow() {
    try {
      setFmvRefreshing(true);
      setFmvRefreshStatus("");

      const response = await fetch(`${API_BASE}/api/vehicles/fmv-estimates/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({}),
      });

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to refresh fleet values");
      }

      await loadMetrics(selectedRange, {
        resetExpanded: false,
        showPageLoading: false,
      });

      const results = Array.isArray(data?.results) ? data.results : [];
      const succeeded = results.filter((item) => item?.ok).length;
      const failed = results.filter((item) => !item?.ok).length;
      setFmvRefreshStatus(
        results.length
          ? `Refreshed ${succeeded} vehicle${succeeded === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`
          : "Fleet values refreshed."
      );
    } catch (err) {
      setFmvRefreshStatus(err.message || "Failed to refresh fleet values.");
    } finally {
      setFmvRefreshing(false);
    }
  }

  useEffect(() => {
    if (!offTripAuditOpen) return undefined;

    let cancelled = false;

    async function loadOffTripAudit() {
      try {
        setOffTripAuditLoading(true);
        setOffTripAuditError(null);

        const params = new URLSearchParams({ range: selectedRange });
        const response = await fetch(
          `${API_BASE}/api/metrics/off-trip-audit?${params.toString()}`,
          {
            headers: { Accept: "application/json" },
          }
        );

        const text = await response.text();
        if (!response.ok) {
          throw new Error(`Off-trip audit request failed: ${response.status} ${text}`);
        }

        const data = JSON.parse(text);
        if (!cancelled) {
          setOffTripAudit(data);
        }
      } catch (err) {
        if (!cancelled) {
          setOffTripAuditError(err.message || "Failed to load off-trip audit");
        }
      } finally {
        if (!cancelled) {
          setOffTripAuditLoading(false);
        }
      }
    }

    loadOffTripAudit();

    return () => {
      cancelled = true;
    };
  }, [offTripAuditOpen, selectedRange]);

  useEffect(() => {
    if (!tollAuditOpen) return undefined;

    let cancelled = false;

    async function loadTollAudit() {
      try {
        setTollAuditLoading(true);
        setTollAuditError(null);

        const params = new URLSearchParams({ range: selectedRange });
        const response = await fetch(
          `${API_BASE}/api/metrics/tolls/detail?${params.toString()}`,
          {
            headers: { Accept: "application/json" },
          }
        );

        const text = await response.text();
        if (!response.ok) {
          throw new Error(`Toll detail request failed: ${response.status} ${text}`);
        }

        const data = JSON.parse(text);
        if (!cancelled) {
          setTollAudit(data);
        }
      } catch (err) {
        if (!cancelled) {
          setTollAuditError(err.message || "Failed to load toll detail");
        }
      } finally {
        if (!cancelled) {
          setTollAuditLoading(false);
        }
      }
    }

    loadTollAudit();

    return () => {
      cancelled = true;
    };
  }, [tollAuditOpen, selectedRange]);

  async function reloadTollAuditDetail(range = selectedRange) {
    const params = new URLSearchParams({ range });
    const response = await fetch(
      `${API_BASE}/api/metrics/tolls/detail?${params.toString()}`,
      {
        headers: { Accept: "application/json" },
      }
    );

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Toll detail request failed: ${response.status} ${text}`);
    }

    const data = JSON.parse(text);
    setTollAudit(data);
    return data;
  }

  async function handleAssignTollTrip(tollChargeId, selectedValue) {
    try {
      setAssigningTollChargeId(tollChargeId);
      setTollAuditError(null);

      const isOffTrip = selectedValue === "__off_trip__";
      const body = isOffTrip
        ? { disposition: "off_trip", trip_id: "__off_trip__" }
        : { trip_id: Number(selectedValue) };

      const response = await fetch(
        `${API_BASE}/api/metrics/tolls/charges/${tollChargeId}/assign-trip`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(data?.error || "Failed to assign toll charge");
      }

      await Promise.all([
        loadMetrics(selectedRange, {
          resetExpanded: false,
          showPageLoading: false,
        }),
        reloadTollAuditDetail(selectedRange),
      ]);
    } catch (err) {
      setTollAuditError(err.message || "Failed to assign toll charge");
    } finally {
      setAssigningTollChargeId(null);
    }
  }

  useEffect(() => {
    if (!financialDetailOpen || !financialDetailVehicle?.vehicle_id) {
      return undefined;
    }

    let cancelled = false;

    async function loadFinancialDetail() {
      try {
        setFinancialDetailLoading(true);
        setFinancialDetailError(null);
        const params = new URLSearchParams({ range: selectedRange });
        const response = await fetch(
          `${API_BASE}/api/metrics/vehicles/${financialDetailVehicle.vehicle_id}/financial-detail?${params.toString()}`,
          {
            headers: { Accept: "application/json" },
          }
        );

        const text = await response.text();
        if (!response.ok) {
          throw new Error(`Financial detail request failed: ${response.status} ${text}`);
        }

        const data = JSON.parse(text);
        if (!cancelled) {
          setFinancialDetail(data);
        }
      } catch (err) {
        if (!cancelled) {
          setFinancialDetailError(err.message || "Failed to load financial detail");
        }
      } finally {
        if (!cancelled) {
          setFinancialDetailLoading(false);
        }
      }
    }

    loadFinancialDetail();

    return () => {
      cancelled = true;
    };
  }, [financialDetailOpen, financialDetailVehicle, selectedRange]);

  function openFinancialDetail(vehicle, focus = "expenses") {
    setFinancialDetailVehicle(vehicle);
    setFinancialDetailFocus(focus);
    setFinancialDetail(null);
    setFinancialDetailError(null);
    setFinancialDetailOpen(true);
  }

  function closeFinancialDetail() {
    setFinancialDetailOpen(false);
    setFinancialDetailVehicle(null);
    setFinancialDetail(null);
    setFinancialDetailError(null);
    setFinancialDetailLoading(false);
  }

  function openTollAudit(focus = "unattributed") {
    setTollAuditFocus(focus);
    setTollAuditOpen(true);
    setTollAuditError(null);
  }

  async function handleSaveOffTripReview(payload) {
    const response = await fetch(`${API_BASE}/api/metrics/off-trip-audit/review`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new Error(data?.error || "Failed to save off-trip audit review");
    }

    const review = data?.review || null;

    setOffTripAudit((prev) => {
      if (!prev) return prev;

      function applyReview(items = []) {
        return items.map((item) =>
          item.audit_key === payload.audit_key
            ? {
                ...item,
                review_status: review?.review_status || null,
                review_reason: review?.review_reason || null,
                reconciled_off_trip_miles:
                  review?.reconciled_off_trip_miles == null
                    ? null
                    : Number(review.reconciled_off_trip_miles),
                reviewed_at: review?.reviewed_at || null,
                raw_off_trip_miles:
                  item.raw_off_trip_miles == null
                    ? Number(item.off_trip_miles ?? 0)
                    : item.raw_off_trip_miles,
                off_trip_miles:
                  review?.reconciled_off_trip_miles == null
                    ? item.raw_off_trip_miles == null
                      ? Number(item.off_trip_miles ?? 0)
                      : item.raw_off_trip_miles
                    : Number(review.reconciled_off_trip_miles),
                is_reviewed: Boolean(review?.review_status),
              }
            : item
        );
      }

      const segments = applyReview(prev.segments || []);
      const skippedTrips = applyReview(prev.skipped_trips || []);
      const reviewedCount =
        segments.filter((item) => item.is_reviewed).length +
        skippedTrips.filter((item) => item.is_reviewed).length;
      const vehicleTotals = new Map();
      for (const item of segments) {
        vehicleTotals.set(
          String(item.vehicle_id),
          (vehicleTotals.get(String(item.vehicle_id)) || 0) +
            Number(item.off_trip_miles ?? 0)
        );
      }

      segments.sort((a, b) => {
        if (Boolean(a.is_reviewed) !== Boolean(b.is_reviewed)) {
          return a.is_reviewed ? 1 : -1;
        }
        const milesDiff = Number(b?.off_trip_miles ?? 0) - Number(a?.off_trip_miles ?? 0);
        if (milesDiff !== 0) return milesDiff;
        const aStart = a.next_trip_start ? new Date(a.next_trip_start).getTime() : 0;
        const bStart = b.next_trip_start ? new Date(b.next_trip_start).getTime() : 0;
        return bStart - aStart;
      });

      skippedTrips.sort((a, b) => {
        if (Boolean(a.is_reviewed) !== Boolean(b.is_reviewed)) {
          return a.is_reviewed ? 1 : -1;
        }
        const aStart = a.trip_start ? new Date(a.trip_start).getTime() : 0;
        const bStart = b.trip_start ? new Date(b.trip_start).getTime() : 0;
        return bStart - aStart;
      });

      return {
        ...prev,
        summary: {
          ...(prev.summary || {}),
          reviewed_count: reviewedCount,
          total_off_trip_miles: segments.reduce(
            (sum, item) => sum + Number(item.off_trip_miles ?? 0),
            0
          ),
        },
        vehicles: (prev.vehicles || []).map((vehicle) => ({
          ...vehicle,
          off_trip_miles: vehicleTotals.get(String(vehicle.vehicle_id)) || 0,
        })),
        segments,
        skipped_trips: skippedTrips,
      };
    });

    return data;
  }

  const avgVehiclesBookedPerDay = useMemo(() => {
    if (!summary) return 0;
    const booked = Number(summary.booked_vehicle_days ?? 0);
    const days = Number(summary.calendar_days ?? 0);
    return days > 0 ? booked / days : 0;
  }, [summary]);

  const avgRevenuePerTrip = useMemo(() => {
    if (!summary) return 0;
    return Number(summary.revenue_per_overlapping_trip ?? 0);
  }, [summary]);

  const filteredAndSortedVehicles = useMemo(() => {
    const next = [...vehicles].filter((vehicle) => {
      const profit = Number(vehicle?.net_profit ?? 0);
      const bookedDays = Number(vehicle?.booked_vehicle_days ?? 0);
      const calendarDays = Number(
        vehicle?.calendar_days_available ?? summary?.calendar_days ?? 0
      );
      const occupancy = calendarDays > 0 ? bookedDays / calendarDays : 0;
      const tollRisk = getVehicleTollRiskScore(vehicle);

      const capitalBasis = Number(vehicle?.capital_basis ?? 0);
      const capitalRecovered = Number(vehicle?.capital_recovered ?? 0);
      const capitalRemaining = Number(vehicle?.capital_remaining ?? 0);
      const hasCapitalTracking =
        capitalBasis > 0 || capitalRecovered > 0 || capitalRemaining > 0;
      const recoveryPct = getCapitalRecoveryPct(vehicle);

      switch (filterBy) {
        case "profitable":
          return profit >= 0;
        case "losing":
          return profit < 0;
        case "toll_issues":
          return tollRisk >= 1;
        case "high_occupancy":
          return occupancy >= 0.75;
        case "low_occupancy":
          return occupancy < 0.5;
        case "payoff_in_progress":
          return hasCapitalTracking && recoveryPct < 1;
        default:
          return true;
      }
    });

    next.sort((a, b) => {
      const aProfit = Number(a?.net_profit ?? 0);
      const bProfit = Number(b?.net_profit ?? 0);
      const aRevenue = Number(a?.revenue_total ?? a?.trip_income ?? 0);
      const bRevenue = Number(b?.revenue_total ?? b?.trip_income ?? 0);
      const aRevDay = Number(a?.revenue_per_booked_day ?? a?.income_per_booked_day ?? 0);
      const bRevDay = Number(b?.revenue_per_booked_day ?? b?.income_per_booked_day ?? 0);
      const aRevMile = Number(a?.revenue_per_mile ?? 0);
      const bRevMile = Number(b?.revenue_per_mile ?? 0);
      const aTrips = Number(a?.trip_count_overlapping ?? 0);
      const bTrips = Number(b?.trip_count_overlapping ?? 0);
      const aValue = Number(a?.fmv_estimate_mid ?? 0);
      const bValue = Number(b?.fmv_estimate_mid ?? 0);
      const aOccupancy =
        Number(a?.calendar_days_available ?? summary?.calendar_days ?? 0) > 0
          ? Number(a?.booked_vehicle_days ?? 0) /
            Number(a?.calendar_days_available ?? summary?.calendar_days ?? 0)
          : 0;
      const bOccupancy =
        Number(b?.calendar_days_available ?? summary?.calendar_days ?? 0) > 0
          ? Number(b?.booked_vehicle_days ?? 0) /
            Number(b?.calendar_days_available ?? summary?.calendar_days ?? 0)
          : 0;

      const aTollRisk = getVehicleTollRiskScore(a);
      const bTollRisk = getVehicleTollRiskScore(b);

      const aRecoveryPct = getCapitalRecoveryPct(a);
      const bRecoveryPct = getCapitalRecoveryPct(b);

      const aCapitalRemaining = Number(a?.capital_remaining ?? 0);
      const bCapitalRemaining = Number(b?.capital_remaining ?? 0);

      const aPayoffDate = a?.projected_payoff_date
        ? new Date(a.projected_payoff_date).getTime()
        : Number.POSITIVE_INFINITY;

        const bPayoffDate = b?.projected_payoff_date
        ? new Date(b.projected_payoff_date).getTime()
        : Number.POSITIVE_INFINITY;

      switch (sortBy) {
        case "profit_asc":
          return aProfit - bProfit;
        case "revenue_desc":
          return bRevenue - aRevenue;
        case "occupancy_desc":
          return bOccupancy - aOccupancy;
        case "rev_day_desc":
          return bRevDay - aRevDay;
        case "rev_mile_desc":
          return bRevMile - aRevMile;
        case "trips_desc":
          return bTrips - aTrips;
        case "value_desc":
          return bValue - aValue;
        case "toll_risk_desc":
          return bTollRisk - aTollRisk || bProfit - aProfit;
        case "recovery_desc":
          return bRecoveryPct - aRecoveryPct;
        case "capital_remaining_asc":
          return aCapitalRemaining - bCapitalRemaining;
        case "payoff_date_asc":
            return aPayoffDate - bPayoffDate || bRecoveryPct - aRecoveryPct;
        case "profit_desc":
        default:
          return bProfit - aProfit;
      }
    });

    return next;
  }, [vehicles, summary, sortBy, filterBy]);

const mileageStats = useMemo(() => {
  const totalMiles = vehicles.reduce(
    (sum, vehicle) => sum + Number(vehicle?.total_miles ?? 0),
    0
  );

  const tripMiles = vehicles.reduce(
    (sum, vehicle) => sum + Number(vehicle?.trip_miles ?? 0),
    0
  );

  const offTripMiles = vehicles.reduce(
    (sum, vehicle) => sum + Number(vehicle?.off_trip_miles ?? 0),
    0
  );

  const revenue = Number(summary?.revenue ?? 0);
  const expenses = Number(summary?.expenses ?? 0);
  const netProfit = Number(summary?.net_profit ?? 0);
  const trips = Number(summary?.trip_count_overlapping ?? 0);

  return {
    totalMiles,
    tripMiles,
    offTripMiles,
    revenuePerTripMile: safeDivide(revenue, tripMiles),
    profitPerTripMile: safeDivide(netProfit, tripMiles),
    expensePerMile: safeDivide(expenses, totalMiles),
    expensePerTripMile: safeDivide(expenses, tripMiles),
    revenuePerTotalMile: safeDivide(revenue, totalMiles),
    profitPerTotalMile: safeDivide(netProfit, totalMiles),
    tripMileUtilization: safeDivide(tripMiles, totalMiles),
    offTripShare: safeDivide(offTripMiles, totalMiles),
    bookedMilesPerTrip: safeDivide(tripMiles, trips),
  };
}, [vehicles, summary]);

  const businessFlagPreview = useMemo(() => {
    const flags = Array.isArray(businessMetrics?.flags) ? businessMetrics.flags : [];
    return flags.slice(0, 4);
  }, [businessMetrics]);

  const derivedStartupTaxTotal = useMemo(
    () =>
      vehicleProfiles.reduce(
        (sum, profile) => sum + Number(profile?.derived_startup_tax_total ?? 0),
        0
      ),
    [vehicleProfiles]
  );

  function handleOpenTripFlag(flag) {
    if (typeof window === "undefined" || !flag?.reservation_id) return;

    const payload = {
      tripId: flag?.trip_id ?? null,
      reservationId: String(flag.reservation_id),
    };

    window.sessionStorage.setItem(
      TRIP_LEDGER_FOCUS_STORAGE_KEY,
      JSON.stringify(payload)
    );
    window.dispatchEvent(
      new CustomEvent("denmark:open-trip-ledger", { detail: payload })
    );
  }

  async function handleOpenExpenseFlag(flag) {
    if (!flag?.expense_id) return;

    try {
      setLoadingExpenseId(Number(flag.expense_id));

      const response = await fetch(`${API_BASE}/api/expenses/${flag.expense_id}`, {
        headers: { Accept: "application/json" },
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to load expense");
      }

      setEditingExpense(data);
      setExpenseModalOpen(true);
    } catch (err) {
      window.alert(err.message || "Failed to load expense");
    } finally {
      setLoadingExpenseId(null);
    }
  }

  function closeExpenseModal() {
    setExpenseModalOpen(false);
    setEditingExpense(null);
  }

  async function handleExpenseSaved() {
    await loadMetrics(selectedRange, {
      resetExpanded: false,
      showPageLoading: false,
    });
  }

  function updateBusinessSetting(key, value) {
    setBusinessSettings((current) => ({
      ...(current || {}),
      [key]: value,
    }));
  }

  function updateVehicleProfile(vehicleId, key, value) {
    setVehicleProfiles((current) =>
      current.map((profile) =>
        Number(profile.vehicle_id) === Number(vehicleId)
          ? {
              ...profile,
              [key]: value,
            }
          : profile
      )
    );
  }

  async function handleSaveBusinessSettings() {
    try {
      setSavingBusinessSettings(true);
      setBusinessInputsError("");

      const response = await fetch(`${API_BASE}/api/metrics/business/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(businessSettings || {}),
      });

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(data?.error || "Failed to save business settings");
      }

      setBusinessSettings(data || {});
      setBusinessInputsStatus("Business settings saved.");
      await loadMetrics(selectedRange, {
        resetExpanded: false,
        showPageLoading: false,
      });
    } catch (err) {
      setBusinessInputsError(err.message || "Failed to save business settings");
    } finally {
      setSavingBusinessSettings(false);
    }
  }

  async function handleSaveVehicleProfile(profile) {
    try {
      setSavingVehicleId(Number(profile.vehicle_id));
      setBusinessInputsError("");

      const payload = {
        purchase_price: profile.purchase_price,
        purchase_date: profile.purchase_date,
        placed_in_service_date: profile.placed_in_service_date,
        mileage_at_purchase: profile.mileage_at_purchase,
        loan_balance: profile.loan_balance,
        monthly_payment: profile.monthly_payment,
        interest_rate: profile.interest_rate,
        insurance_monthly: profile.insurance_monthly,
        tracker_monthly: profile.tracker_monthly,
        registration_annual: profile.registration_annual,
        inspection_annual: profile.inspection_annual,
        target_min_daily_rate: profile.target_min_daily_rate,
        target_utilization: profile.target_utilization,
        owner_hourly_rate_override: profile.owner_hourly_rate_override,
        notes: profile.notes,
      };

      const response = await fetch(
        `${API_BASE}/api/metrics/business/vehicle-profiles/${profile.vehicle_id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(data?.error || "Failed to save vehicle profile");
      }

      setVehicleProfiles((current) =>
        current.map((item) =>
          Number(item.vehicle_id) === Number(profile.vehicle_id)
            ? {
                ...item,
                ...normalizeVehicleProfileForForm(data),
              }
            : item
        )
      );

      setBusinessInputsStatus(`Saved ${profile.vehicle_name || "vehicle"} profile.`);
      await loadMetrics(selectedRange, {
        resetExpanded: false,
        showPageLoading: false,
      });
    } catch (err) {
      setBusinessInputsError(err.message || "Failed to save vehicle profile");
    } finally {
      setSavingVehicleId(null);
    }
  }

  return (
    <div className="metrics-panel">
      {loading && <div>Loading metrics…</div>}
      {error && <div>Failed to load metrics: {error}</div>}

      {!loading && !error && summary && (
        <>
          <div className="metrics-topbar">
            <div className="metrics-topbar__group">
              <div className="metrics-topbar__label">Range</div>
              <div className="metrics-range-chips">
                {RANGE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`metrics-range-chip ${
                      selectedRange === option.value ? "is-active" : ""
                    }`}
                    onClick={() => setSelectedRange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="metrics-topbar__group metrics-topbar__group--actions">
              {fmvRefreshStatus ? (
                <div className="metrics-topbar__status">{fmvRefreshStatus}</div>
              ) : null}
              <button
                type="button"
                className="metrics-topbar__button"
                onClick={handleRefreshFmvNow}
                disabled={fmvRefreshing}
              >
                {fmvRefreshing ? "Refreshing values..." : "Refresh values now"}
              </button>
            </div>
          </div>

          <div className="metrics-summary-row">
            <MetricCard
              label="Revenue"
              value={formatCurrency(summary.revenue)}
            />

            <MetricCard
              label="Net Profit"
              value={formatCurrency(summary.net_profit)}
              tone={Number(summary.net_profit) >= 0 ? "positive" : "negative"}
            />

            <MetricCard
              label="Expenses"
              value={formatCurrency(summary.expenses)}
            />

            <MetricCard
              label="Fleet Value"
              value={formatCurrency(summary.fleet_value)}
              subtitle={
                <>
                  <div>{formatValueTrend(summary.fleet_value_change)}</div>
                  <div>{formatUpdatedLabel(summary.fleet_value_updated_at)}</div>
                </>
              }
              tone={
                Number(summary.fleet_value_change ?? 0) > 0
                  ? "positive"
                  : Number(summary.fleet_value_change ?? 0) < 0
                  ? "negative"
                  : undefined
              }
            />

            <MetricCard
              label="Rev / Calendar Day"
              value={formatCurrencyCompact(summary.revenue_per_calendar_day)}
            />

            <MetricCard
              label="Rev / Booked Day"
              value={formatCurrencyCompact(summary.revenue_per_booked_day)}
            />
          </div>

          {businessMetrics?.fleet_summary ? (
            <section className="metrics-ops-row">
              <MetricCard
                label="Owner Cash In"
                value={
                  Number(
                    businessMetrics.fleet_summary?.owner_cash_invested ??
                      businessMetrics?.settings?.owner_cash_invested ??
                      0
                  ) > 0
                    ? formatCurrency(
                        businessMetrics.fleet_summary?.owner_cash_invested ??
                          businessMetrics?.settings?.owner_cash_invested
                      )
                    : "--"
                }
              />

              <MetricCard
                label="Cash Back"
                value={formatCurrency(
                  businessMetrics.fleet_summary.total_cash_returned
                )}
                subtitle={
                  businessMetrics.fleet_summary.cash_recovered_pct != null
                    ? `${formatPercent(
                        businessMetrics.fleet_summary.cash_recovered_pct,
                        0
                      )} recovered`
                    : "Set owner cash in for recovery %"
                }
                tone="positive"
              />

              <MetricCard
                label="Unrecovered Cash"
                value={formatCurrency(
                  businessMetrics.fleet_summary.unrecovered_owner_cash
                )}
                subtitle="Owner cash in minus cash back"
                tone={
                  Number(
                    businessMetrics.fleet_summary.unrecovered_owner_cash ?? 0
                  ) <= 0
                    ? "positive"
                    : "warning"
                }
              />

              <MetricCard
                label="Fleet Market Value"
                value={formatCurrency(
                  businessMetrics.fleet_summary.current_fleet_market_value
                )}
                subtitle={formatConfidenceLabel(
                  businessMetrics.fleet_summary.data_confidence
                )}
              />

              <MetricCard
                label="Capital Coverage"
                value={
                  businessMetrics.fleet_summary.owner_capital_coverage_pct != null
                    ? formatPercent(
                        businessMetrics.fleet_summary.owner_capital_coverage_pct,
                        0
                      )
                    : "--"
                }
                subtitle="Cash back plus fleet equity vs owner cash in"
                tone={
                  Number(
                    businessMetrics.fleet_summary.owner_capital_coverage_pct ?? 0
                  ) >= 1
                    ? "positive"
                    : "warning"
                }
              />
            </section>
          ) : null}

          {businessMetrics?.fleet_summary ? (
            <section className="metrics-ops-row">
              <MetricCard
                label="Operating Profit"
                value={formatCurrency(businessMetrics.fleet_summary.net_operating_profit)}
                subtitle={formatConfidenceLabel(businessMetrics.fleet_summary.data_confidence)}
                tone={
                  Number(businessMetrics.fleet_summary.net_operating_profit ?? 0) >= 0
                    ? "positive"
                    : "negative"
                }
              />

              <MetricCard
                label="After Debt Service"
                value={formatCurrency(
                  businessMetrics.fleet_summary.net_profit_after_debt_service
                )}
                tone={
                  Number(
                    businessMetrics.fleet_summary.net_profit_after_debt_service ?? 0
                  ) >= 0
                    ? "positive"
                    : "negative"
                }
              />

              <MetricCard
                label="After Owner Labor"
                value={formatCurrency(
                  businessMetrics.fleet_summary.net_profit_after_owner_labor
                )}
                subtitle={`${formatNumber(
                  businessMetrics.fleet_summary.estimated_owner_hours,
                  1
                )} owner hrs`}
                tone={
                  Number(
                    businessMetrics.fleet_summary.net_profit_after_owner_labor ?? 0
                  ) >= 0
                    ? "positive"
                    : "negative"
                }
              />

              <MetricCard
                label="Fleet Equity"
                value={formatCurrency(
                  businessMetrics.fleet_summary.current_fleet_equity
                )}
              />

              <MetricCard
                label="Profit / Owner Hour"
                value={formatCurrencyCompact(
                  businessMetrics.fleet_summary.avg_profit_per_owner_hour
                )}
              />

              <MetricCard
                label="Data Flags"
                value={`${formatNumber(
                  Number(businessMetrics.fleet_summary.flag_counts?.high ?? 0) +
                    Number(businessMetrics.fleet_summary.flag_counts?.medium ?? 0) +
                    Number(businessMetrics.fleet_summary.flag_counts?.low ?? 0)
                )} flags`}
                subtitle={`High ${formatNumber(
                  businessMetrics.fleet_summary.flag_counts?.high ?? 0
                )} · Med ${formatNumber(
                  businessMetrics.fleet_summary.flag_counts?.medium ?? 0
                )}`}
                tone={
                  Number(businessMetrics.fleet_summary.flag_counts?.high ?? 0) > 0
                    ? "negative"
                    : Number(businessMetrics.fleet_summary.flag_counts?.medium ?? 0) > 0
                    ? "warning"
                    : "positive"
                }
              />
            </section>
          ) : null}

          {businessFlagPreview.length ? (
            <section className="toll-panel">
              <div className="toll-panel__header">
                <div className="toll-panel__title">Business Watchlist</div>
                <div className="toll-panel__subtitle">
                  Highest-signal gaps still lowering confidence in profit and scale decisions
                </div>
              </div>
              <div className="metrics-financial-list">
                {businessFlagPreview.map((flag) => (
                  <article
                    key={`${flag.entity_type}:${flag.entity_id}:${flag.flag_code}`}
                    className="metrics-financial-line-item"
                  >
                    <div className="metrics-financial-line-top">
                      <div>
                        <div className="metrics-financial-line-title">
                          {formatFlagTitle(flag)}
                        </div>
                        <div className="metrics-financial-line-meta">
                          {formatFlagMeta(flag) || `${flag.entity_type} #${flag.entity_id}`}
                        </div>
                      </div>
                      <div className="metrics-financial-line-amount">
                        {String(flag.severity || "").toUpperCase()}
                      </div>
                    </div>
                    <div className="metrics-financial-line-split">
                      <span>{flag.note}</span>
                    </div>
                    {flag.mapping_reason ? (
                      <div className="metrics-financial-line-split">
                        <span>Why: {flag.mapping_reason}</span>
                      </div>
                    ) : null}
                    {flag.suggested_action ? (
                      <div className="metrics-financial-line-split">
                        <span>Next: {flag.suggested_action}</span>
                      </div>
                    ) : null}
                    {flag.suggested_vehicle_name ? (
                      <div className="metrics-financial-line-split">
                        <span>Likely vehicle: {flag.suggested_vehicle_name}</span>
                      </div>
                    ) : null}
                    {flag.entity_type === "trip" && flag.reservation_id ? (
                      <div className="metrics-financial-line-actions">
                        <button
                          type="button"
                          className="metrics-inline-button"
                          onClick={() => handleOpenTripFlag(flag)}
                        >
                          Open trip
                        </button>
                      </div>
                    ) : flag.entity_type === "expense" && flag.expense_id ? (
                      <div className="metrics-financial-line-actions">
                        <button
                          type="button"
                          className="metrics-inline-button"
                          onClick={() => handleOpenExpenseFlag(flag)}
                          disabled={loadingExpenseId === Number(flag.expense_id)}
                        >
                          {loadingExpenseId === Number(flag.expense_id)
                            ? "Opening..."
                            : "Edit expense"}
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {false ? (
          <section className="toll-panel">
            <div className="toll-panel__header">
              <div className="toll-panel__title">Business Inputs</div>
              <div className="toll-panel__subtitle">
                Fill in the real business assumptions so profit after debt, labor, and equity means something
              </div>
            </div>

            {businessInputsLoading ? (
              <div className="message-empty">Loading business inputs…</div>
            ) : businessInputsError ? (
              <div className="expenses-error-state">{businessInputsError}</div>
            ) : (
              <div className="metrics-business-inputs">
                {businessInputsStatus ? (
                  <div className="detail-sub">{businessInputsStatus}</div>
                ) : null}
                <div className="metrics-business-card">
                  <div className="metrics-business-card__header">
                    <div>
                      <div className="metrics-business-card__title">Business Settings</div>
                      <div className="metrics-business-profile__meta">
                        Owner cash {formatCurrencyCompact(businessSettings?.owner_cash_invested)} · 401k{" "}
                        {formatCurrencyCompact(businessSettings?.loan_401k_amount)} · startup tax{" "}
                        {formatCurrencyCompact(derivedStartupTaxTotal)} · hourly{" "}
                        {formatCurrencyCompact(
                          businessSettings?.target_owner_hourly_rate
                        )}
                      </div>
                    </div>
                    <div className="metrics-business-card__actions">
                      <button
                        type="button"
                        className="metrics-inline-button"
                        onClick={() => setBusinessSettingsOpen((open) => !open)}
                      >
                        {businessSettingsOpen ? "Collapse" : "Edit"}
                      </button>
                      <button
                        type="button"
                        className="metrics-inline-button"
                        onClick={handleSaveBusinessSettings}
                        disabled={savingBusinessSettings}
                      >
                        {savingBusinessSettings ? "Saving..." : "Save settings"}
                      </button>
                    </div>
                  </div>
                  {businessSettingsOpen ? (
                  <div className="metrics-business-grid">
                    <label className="metrics-business-field">
                      <span>Owner Cash Invested</span>
                      <input
                        value={formatInputValue(businessSettings?.owner_cash_invested)}
                        onChange={(e) =>
                          updateBusinessSetting("owner_cash_invested", e.target.value)
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>401k Loan Used</span>
                      <input
                        value={formatInputValue(businessSettings?.loan_401k_amount)}
                        onChange={(e) =>
                          updateBusinessSetting("loan_401k_amount", e.target.value)
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>Other Business Loan</span>
                      <input
                        value={formatInputValue(
                          businessSettings?.other_business_loan_amount
                        )}
                        onChange={(e) =>
                          updateBusinessSetting(
                            "other_business_loan_amount",
                            e.target.value
                          )
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>Owner Hourly Rate</span>
                      <input
                        value={formatInputValue(
                          businessSettings?.target_owner_hourly_rate
                        )}
                        onChange={(e) =>
                          updateBusinessSetting(
                            "target_owner_hourly_rate",
                            e.target.value
                          )
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>Target Profit / Car / Month</span>
                      <input
                        value={formatInputValue(
                          businessSettings?.target_minimum_monthly_profit_per_car
                        )}
                        onChange={(e) =>
                          updateBusinessSetting(
                            "target_minimum_monthly_profit_per_car",
                            e.target.value
                          )
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>Target Cash-on-Cash Return</span>
                      <input
                        value={formatInputValue(
                          businessSettings?.target_cash_on_cash_return
                        )}
                        onChange={(e) =>
                          updateBusinessSetting(
                            "target_cash_on_cash_return",
                            e.target.value
                          )
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>Target Payback Months</span>
                      <input
                        value={formatInputValue(
                          businessSettings?.target_payback_period_months
                        )}
                        onChange={(e) =>
                          updateBusinessSetting(
                            "target_payback_period_months",
                            e.target.value
                          )
                        }
                      />
                    </label>
                  </div>
                  ) : null}
                </div>

                <div className="metrics-business-card">
                  <div className="metrics-business-card__header">
                    <div className="metrics-business-card__title">Vehicle Financial Profiles</div>
                  </div>
                  <div className="metrics-business-profile-list">
                    {vehicleProfiles.map((profile) => (
                      <article
                        key={profile.vehicle_id}
                        className="metrics-business-profile"
                      >
                        <div className="metrics-business-profile__header">
                          <div>
                            <div className="metrics-business-profile__title">
                              {profile.vehicle_name}
                            </div>
                            <div className="metrics-business-profile__meta">
                              {buildYearMakeModel(profile) || "Vehicle"} · Turo ID{" "}
                              {profile.turo_vehicle_id || "--"} · Odo{" "}
                              {formatNumber(profile.current_odometer_miles ?? 0)}
                            </div>
                            <div className="metrics-business-profile__summary">
                              Cash layout {formatCurrencyCompact(
                                profile.derived_startup_total ?? profile.purchase_price
                              )} · Tax{" "}
                              {formatCurrencyCompact(profile.derived_startup_tax_total)} · Loan{" "}
                              {formatCurrencyCompact(profile.loan_balance)} · Insurance{" "}
                              {formatCurrencyCompact(profile.insurance_monthly)}/mo · Service{" "}
                              {formatBusinessInputDate(profile.placed_in_service_date)}
                            </div>
                          </div>
                          <div className="metrics-business-card__actions">
                            <button
                              type="button"
                              className="metrics-inline-button"
                              onClick={() => toggleBusinessProfile(profile.vehicle_id)}
                            >
                              {expandedBusinessProfiles[profile.vehicle_id]
                                ? "Collapse"
                                : "Edit"}
                            </button>
                            <button
                              type="button"
                              className="metrics-inline-button"
                              onClick={() => handleSaveVehicleProfile(profile)}
                              disabled={savingVehicleId === Number(profile.vehicle_id)}
                            >
                              {savingVehicleId === Number(profile.vehicle_id)
                                ? "Saving..."
                                : "Save vehicle"}
                            </button>
                          </div>
                        </div>
                        {expandedBusinessProfiles[profile.vehicle_id] ? (
                        <div className="metrics-business-grid">
                          <label className="metrics-business-field">
                            <span>Cash Layout From Expenses</span>
                            <input
                              value={formatInputValue(
                                formatCurrencyCompact(
                                  profile.derived_startup_total ?? profile.purchase_price
                                )
                              )}
                              readOnly
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Onboard Tax From Expenses</span>
                            <input
                              value={formatInputValue(
                                formatCurrencyCompact(profile.derived_startup_tax_total)
                              )}
                              readOnly
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Purchase Date</span>
                            <input
                              type="date"
                              value={formatInputValue(profile.purchase_date)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "purchase_date",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Placed In Service</span>
                            <input
                              type="date"
                              value={formatInputValue(profile.placed_in_service_date)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "placed_in_service_date",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Miles At Purchase</span>
                            <input
                              value={formatInputValue(profile.mileage_at_purchase)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "mileage_at_purchase",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Loan Balance</span>
                            <input
                              value={formatInputValue(profile.loan_balance)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "loan_balance",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Monthly Payment</span>
                            <input
                              value={formatInputValue(profile.monthly_payment)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "monthly_payment",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Interest Rate</span>
                            <input
                              value={formatInputValue(profile.interest_rate)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "interest_rate",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Insurance / Month</span>
                            <input
                              value={formatInputValue(profile.insurance_monthly)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "insurance_monthly",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Tracker / Month</span>
                            <input
                              value={formatInputValue(profile.tracker_monthly)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "tracker_monthly",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Registration / Year</span>
                            <input
                              value={formatInputValue(profile.registration_annual)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "registration_annual",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Inspection / Year</span>
                            <input
                              value={formatInputValue(profile.inspection_annual)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "inspection_annual",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Target Min Daily Rate</span>
                            <input
                              value={formatInputValue(profile.target_min_daily_rate)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "target_min_daily_rate",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Target Utilization</span>
                            <input
                              value={formatInputValue(profile.target_utilization)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "target_utilization",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Owner Hourly Override</span>
                            <input
                              value={formatInputValue(
                                profile.owner_hourly_rate_override
                              )}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "owner_hourly_rate_override",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field metrics-business-field--full">
                            <span>Notes</span>
                            <textarea
                              rows={2}
                              value={formatInputValue(profile.notes)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "notes",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                        </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>
          ) : null}

          <div className="metrics-ops-row">
            <MetricCard
              label="Trips"
              value={`${formatNumber(summary.trip_count_overlapping)} trips`}
              subtitle={`${formatNumber(summary.trip_count_prorated, 2)} effective trips`}
            />

            <MetricCard
              label="Avg Vehicles Booked / Day"
              value={formatNumber(avgVehiclesBookedPerDay, 1)}
              subtitle={`${formatNumber(summary.booked_vehicle_days)} booked days across ${formatNumber(summary.calendar_days)} calendar days`}
            />

            <MetricCard
              label="Cleaning / Trip"
              value={`${formatCurrencyCompact(summary.cleaning_cost_per_overlapping_trip)} actual`}
              subtitle={`${formatCurrencyCompact(summary.cleaning_cost_per_prorated_trip)} effective`}
            />

            <MetricCard
              label="Avg Rev / Trip"
              value={formatCurrencyCompact(avgRevenuePerTrip)}
              subtitle={`${formatNumber(summary.trip_count_overlapping)} overlapping trips`}
            />

            <MetricCard
              label="Expected Turo vs Income"
              value={formatSignedCurrency(summary.income_category_variance)}
              subtitle={
                <>
                  <div>
                    {formatCurrencyCompact(
                      summary.scheduled_turo_output_total ?? summary.turo_output_total
                    )} expected / {formatCurrencyCompact(
                      summary.income_category_total
                    )} income / {formatCurrencyCompact(
                      summary.turo_output_deferred_total
                    )} deferred
                  </div>
                  {summary.income_reconciliation_largest_gap ? (
                    <div>
                      Largest gap {formatShortDate(
                        summary.income_reconciliation_largest_gap.date
                      )}: {formatSignedCurrency(
                        summary.income_reconciliation_largest_gap.variance
                      )}
                    </div>
                  ) : null}
                </>
              }
              tone={
                Math.abs(Number(summary.income_category_variance ?? 0)) < 1
                  ? "positive"
                  : Number(summary.income_category_variance ?? 0) < 0
                  ? "warning"
                  : "default"
              }
            />
          </div>

          <section className="metrics-mileage-row">
            <MetricCard
              label="Trip Miles"
              value={`${formatNumber(mileageStats.tripMiles)} mi`}
              subtitle={`${formatPercent(mileageStats.tripMileUtilization, 0)} of total miles`}
            />

            <MetricCard
              label="Off-Trip Miles"
              value={`${formatNumber(mileageStats.offTripMiles)} mi`}
              tone={
                mileageStats.offTripShare >= 0.35
                  ? "negative"
                  : mileageStats.offTripShare >= 0.2
                  ? "warning"
                  : "positive"
              }
              subtitle={`${formatPercent(mileageStats.offTripShare, 0)} of total miles`}
              onClick={() => setOffTripAuditOpen(true)}
            />

            <MetricCard
              label="Rev / Trip Mile"
              value={formatCurrencyCompact(mileageStats.revenuePerTripMile)}
              subtitle={`${formatCurrencyCompact(mileageStats.revenuePerTotalMile)} / total mile`}
            />

            <MetricCard
              label="Profit / Trip Mile"
              value={formatCurrencyCompact(mileageStats.profitPerTripMile)}
              tone={
                mileageStats.profitPerTripMile >= 0.25
                  ? "positive"
                  : mileageStats.profitPerTripMile >= 0.1
                  ? "warning"
                  : "negative"
              }
              subtitle={`${formatCurrencyCompact(mileageStats.profitPerTotalMile)} / total mile`}
            />

            <MetricCard
              label="Expense / Mile"
              value={formatCurrencyCompact(mileageStats.expensePerMile)}
              subtitle={`${formatCurrencyCompact(mileageStats.expensePerTripMile)} / trip mile`}
            />
          </section>

      <OffTripMilesDrawer
        open={offTripAuditOpen}
        loading={offTripAuditLoading}
        error={offTripAuditError}
        audit={offTripAudit}
        onSaveReview={handleSaveOffTripReview}
        onClose={() => setOffTripAuditOpen(false)}
      />

      <TollAuditDrawer
        open={tollAuditOpen}
        loading={tollAuditLoading}
        error={tollAuditError}
        detail={tollAudit}
        focus={tollAuditFocus}
        assigningChargeId={assigningTollChargeId}
        onAssignTrip={handleAssignTollTrip}
        onClose={() => setTollAuditOpen(false)}
      />

          <section className="toll-panel">
            <div className="toll-panel__header">
              <div className="toll-panel__title">Tolls</div>
              <div className="toll-panel__subtitle">
                Recovery and leakage across the selected range
              </div>
            </div>

            <div className="toll-panel__grid">
              <TollStat
                label="Paid"
                value={formatCurrencyCompact(summary.tolls_paid)}
              />

              <TollStat
                label="Recovered"
                value={formatCurrencyCompact(summary.tolls_recovered)}
                tone="positive"
              />

              <TollStat
                label="Outstanding"
                value={formatCurrencyCompact(summary.tolls_attributed_outstanding)}
                tone="warning"
                onClick={() => openTollAudit("outstanding")}
              />

              <TollStat
                label="Unattributed"
                value={formatCurrencyCompact(summary.tolls_unattributed)}
                tone="negative"
                emphasis="strong"
                onClick={() => openTollAudit("unattributed")}
              />
            </div>

            <div className="toll-panel__rates">
              <TollStat
                label="Recovery Rate"
                value={formatPercent(summary.toll_recovery_rate, 0)}
                tone={
                  Number(summary.toll_recovery_rate) >= 0.75
                    ? "positive"
                    : Number(summary.toll_recovery_rate) >= 0.5
                    ? "warning"
                    : "negative"
                }
              />

              <TollStat
                label="Effective Recovery Rate"
                value={formatPercent(summary.toll_effective_recovery_rate, 0)}
                tone={
                  Number(summary.toll_effective_recovery_rate) >= 0.85
                    ? "positive"
                    : Number(summary.toll_effective_recovery_rate) >= 0.65
                    ? "warning"
                    : "negative"
                }
              />
            </div>
          </section>

          <section className="metrics-vehicles-section">
            <div className="metrics-section-header">
              <div className="metrics-section-title">Vehicles</div>
              <div className="metrics-section-subtitle">
                Compare fleet performance across the selected range
              </div>
            </div>

            <div className="metrics-toolbar">
              <div className="metrics-toolbar__group">
                <label className="metrics-toolbar__label" htmlFor="metrics-sort">
                  Sort
                </label>
                <select
                  id="metrics-sort"
                  className="metrics-toolbar__select"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                >
                  <option value="profit_desc">Profit ↓</option>
                  <option value="profit_asc">Profit ↑</option>
                  <option value="revenue_desc">Revenue ↓</option>
                  <option value="value_desc">Value ↓</option>
                  <option value="occupancy_desc">Occupancy ↓</option>
                  <option value="rev_day_desc">Rev / Day ↓</option>
                  <option value="rev_mile_desc">Rev / Mile ↓</option>
                  <option value="trips_desc">Trips ↓</option>
                  <option value="toll_risk_desc">Toll Risk ↓</option>
                  <option value="recovery_desc">Recovery % ↓</option>
                  <option value="capital_remaining_asc">Capital Remaining ↑</option>
                  <option value="payoff_date_asc">Payoff Soonest</option>
                </select>
              </div>

              <div className="metrics-filter-chips">
                {[
                  ["all", "All"],
                  ["profitable", "Profitable"],
                  ["losing", "Losing"],
                  ["toll_issues", "Toll Issues"],
                  ["high_occupancy", "High Occupancy"],
                  ["low_occupancy", "Low Occupancy"],
                  ["payoff_in_progress", "Payoff In Progress"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`metrics-filter-chip ${
                      filterBy === value ? "is-active" : ""
                    }`}
                    onClick={() => setFilterBy(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="vehicle-compare-header" aria-hidden="true">
              <div className="vehicle-compare-header__cell vehicle-compare-header__cell--vehicle">
                Vehicle
              </div>
              <div className="vehicle-compare-header__cell">Profit</div>
              <div className="vehicle-compare-header__cell">Revenue</div>
              <div className="vehicle-compare-header__cell">Value</div>
              <div className="vehicle-compare-header__cell">Rented / Available</div>
              <div className="vehicle-compare-header__cell">Occupancy</div>
              <div className="vehicle-compare-header__cell">Rev / Day</div>
              <div className="vehicle-compare-header__cell">Rev / Mile</div>
              <div className="vehicle-compare-header__cell">Trips</div>
              <div className="vehicle-compare-header__cell">Toll Risk</div>
              <div className="vehicle-compare-header__cell"></div>
            </div>

            <div className="vehicle-compare-list">
              {filteredAndSortedVehicles.map((vehicle) => {
                const vehicleKey =
                  vehicle.vehicle_id || vehicle.vin || vehicle.nickname;

                return (
                  <VehicleComparisonRow
                    key={vehicleKey}
                    vehicle={vehicle}
                    isExpanded={expandedVehicleId === vehicleKey}
                    onToggle={() =>
                      setExpandedVehicleId((prev) =>
                        prev === vehicleKey ? null : vehicleKey
                      )
                    }
                    onOpenFinancialDetail={openFinancialDetail}
                    formatCurrency={formatCurrency}
                    formatCurrencyCompact={formatCurrencyCompact}
                    formatNumber={formatNumber}
                    formatValueTrend={formatValueTrend}
                    calendarDays={summary.calendar_days}
                  />
                );
              })}
            </div>

            <div className="metrics-business-card">
              <div className="metrics-business-card__header">
                <div>
                  <div className="metrics-business-card__title">Vehicle Economics Inputs</div>
                  <div className="metrics-business-profile__meta">
                    Cash layout, tax, financing, insurance, and service dates alongside the cars they belong to
                  </div>
                </div>
                <button
                  type="button"
                  className="metrics-inline-button"
                  onClick={() => setBusinessInputsSectionOpen((open) => !open)}
                >
                  {businessInputsSectionOpen ? "Collapse" : "Expand"}
                </button>
              </div>

              {businessInputsSectionOpen ? (
                businessInputsLoading ? (
                  <div className="message-empty">Loading business inputsâ€¦</div>
                ) : businessInputsError ? (
                  <div className="expenses-error-state">{businessInputsError}</div>
                ) : (
                  <div className="metrics-business-inputs">
                    {businessInputsStatus ? (
                      <div className="detail-sub">{businessInputsStatus}</div>
                    ) : null}
                    <div className="metrics-business-card">
                      <div className="metrics-business-card__header">
                        <div>
                          <div className="metrics-business-card__title">Business Settings</div>
                          <div className="metrics-business-profile__meta">
                            Owner cash {formatCurrencyCompact(businessSettings?.owner_cash_invested)} · 401k{" "}
                            {formatCurrencyCompact(businessSettings?.loan_401k_amount)} · startup tax{" "}
                            {formatCurrencyCompact(derivedStartupTaxTotal)} · hourly{" "}
                            {formatCurrencyCompact(
                              businessSettings?.target_owner_hourly_rate
                            )}
                          </div>
                        </div>
                        <div className="metrics-business-card__actions">
                          <button
                            type="button"
                            className="metrics-inline-button"
                            onClick={() => setBusinessSettingsOpen((open) => !open)}
                          >
                            {businessSettingsOpen ? "Collapse" : "Edit"}
                          </button>
                          <button
                            type="button"
                            className="metrics-inline-button"
                            onClick={handleSaveBusinessSettings}
                            disabled={savingBusinessSettings}
                          >
                            {savingBusinessSettings ? "Saving..." : "Save settings"}
                          </button>
                        </div>
                      </div>
                      {businessSettingsOpen ? (
                        <div className="metrics-business-grid">
                          <label className="metrics-business-field">
                            <span>Owner Cash Invested</span>
                            <input
                              value={formatInputValue(businessSettings?.owner_cash_invested)}
                              onChange={(e) =>
                                updateBusinessSetting("owner_cash_invested", e.target.value)
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>401k Loan Used</span>
                            <input
                              value={formatInputValue(businessSettings?.loan_401k_amount)}
                              onChange={(e) =>
                                updateBusinessSetting("loan_401k_amount", e.target.value)
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Other Business Loan</span>
                            <input
                              value={formatInputValue(
                                businessSettings?.other_business_loan_amount
                              )}
                              onChange={(e) =>
                                updateBusinessSetting(
                                  "other_business_loan_amount",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Owner Hourly Rate</span>
                            <input
                              value={formatInputValue(
                                businessSettings?.target_owner_hourly_rate
                              )}
                              onChange={(e) =>
                                updateBusinessSetting(
                                  "target_owner_hourly_rate",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Target Profit / Car / Month</span>
                            <input
                              value={formatInputValue(
                                businessSettings?.target_minimum_monthly_profit_per_car
                              )}
                              onChange={(e) =>
                                updateBusinessSetting(
                                  "target_minimum_monthly_profit_per_car",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Target Cash-on-Cash Return</span>
                            <input
                              value={formatInputValue(
                                businessSettings?.target_cash_on_cash_return
                              )}
                              onChange={(e) =>
                                updateBusinessSetting(
                                  "target_cash_on_cash_return",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Target Payback Months</span>
                            <input
                              value={formatInputValue(
                                businessSettings?.target_payback_period_months
                              )}
                              onChange={(e) =>
                                updateBusinessSetting(
                                  "target_payback_period_months",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                        </div>
                      ) : null}
                    </div>

                    <div className="metrics-business-card">
                      <div className="metrics-business-card__header">
                        <div className="metrics-business-card__title">Vehicle Financial Profiles</div>
                      </div>
                      <div className="metrics-business-profile-list">
                        {vehicleProfiles.map((profile) => (
                          <article
                            key={profile.vehicle_id}
                            className="metrics-business-profile"
                          >
                            <div className="metrics-business-profile__header">
                              <div>
                                <div className="metrics-business-profile__title">
                                  {profile.vehicle_name}
                                </div>
                                <div className="metrics-business-profile__meta">
                                  {buildYearMakeModel(profile) || "Vehicle"} · Turo ID{" "}
                                  {profile.turo_vehicle_id || "--"} · Odo{" "}
                                  {formatNumber(profile.current_odometer_miles ?? 0)}
                                </div>
                                <div className="metrics-business-profile__summary">
                                  Cash layout {formatCurrencyCompact(
                                    profile.derived_startup_total ?? profile.purchase_price
                                  )} · Tax{" "}
                                  {formatCurrencyCompact(profile.derived_startup_tax_total)} · Loan{" "}
                                  {formatCurrencyCompact(profile.loan_balance)} · Insurance{" "}
                                  {formatCurrencyCompact(profile.insurance_monthly)}/mo · Service{" "}
                                  {formatBusinessInputDate(profile.placed_in_service_date)}
                                </div>
                              </div>
                              <div className="metrics-business-card__actions">
                                <button
                                  type="button"
                                  className="metrics-inline-button"
                                  onClick={() => toggleBusinessProfile(profile.vehicle_id)}
                                >
                                  {expandedBusinessProfiles[profile.vehicle_id]
                                    ? "Collapse"
                                    : "Edit"}
                                </button>
                                <button
                                  type="button"
                                  className="metrics-inline-button"
                                  onClick={() => handleSaveVehicleProfile(profile)}
                                  disabled={savingVehicleId === Number(profile.vehicle_id)}
                                >
                                  {savingVehicleId === Number(profile.vehicle_id)
                                    ? "Saving..."
                                    : "Save vehicle"}
                                </button>
                              </div>
                            </div>
                            {expandedBusinessProfiles[profile.vehicle_id] ? (
                              <div className="metrics-business-grid">
                                <label className="metrics-business-field">
                                  <span>Cash Layout From Expenses</span>
                                  <input
                                    value={formatInputValue(
                                      formatCurrencyCompact(
                                        profile.derived_startup_total ?? profile.purchase_price
                                      )
                                    )}
                                    readOnly
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Onboard Tax From Expenses</span>
                                  <input
                                    value={formatInputValue(
                                      formatCurrencyCompact(profile.derived_startup_tax_total)
                                    )}
                                    readOnly
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Purchase Date</span>
                                  <input
                                    type="date"
                                    value={formatInputValue(profile.purchase_date)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "purchase_date",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Placed In Service</span>
                                  <input
                                    type="date"
                                    value={formatInputValue(profile.placed_in_service_date)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "placed_in_service_date",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Miles At Purchase</span>
                                  <input
                                    value={formatInputValue(profile.mileage_at_purchase)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "mileage_at_purchase",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Loan Balance</span>
                                  <input
                                    value={formatInputValue(profile.loan_balance)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "loan_balance",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Monthly Payment</span>
                                  <input
                                    value={formatInputValue(profile.monthly_payment)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "monthly_payment",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Interest Rate</span>
                                  <input
                                    value={formatInputValue(profile.interest_rate)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "interest_rate",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Insurance / Month</span>
                                  <input
                                    value={formatInputValue(profile.insurance_monthly)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "insurance_monthly",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Tracker / Month</span>
                                  <input
                                    value={formatInputValue(profile.tracker_monthly)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "tracker_monthly",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Registration / Year</span>
                                  <input
                                    value={formatInputValue(profile.registration_annual)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "registration_annual",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Inspection / Year</span>
                                  <input
                                    value={formatInputValue(profile.inspection_annual)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "inspection_annual",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Target Min Daily Rate</span>
                                  <input
                                    value={formatInputValue(profile.target_min_daily_rate)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "target_min_daily_rate",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Target Utilization</span>
                                  <input
                                    value={formatInputValue(profile.target_utilization)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "target_utilization",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Owner Hourly Override</span>
                                  <input
                                    value={formatInputValue(
                                      profile.owner_hourly_rate_override
                                    )}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "owner_hourly_rate_override",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field metrics-business-field--full">
                                  <span>Notes</span>
                                  <textarea
                                    rows={2}
                                    value={formatInputValue(profile.notes)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "notes",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                              </div>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              ) : null}
            </div>
          </section>

          <VehicleFinancialDrawer
            open={financialDetailOpen}
            loading={financialDetailLoading}
            error={financialDetailError}
            detail={financialDetail}
            focus={financialDetailFocus}
            onClose={closeFinancialDetail}
          />

          <ExpenseModal
            open={expenseModalOpen}
            expense={editingExpense}
            selectedVehicleId={editingExpense?.vehicle_id ?? null}
            onClose={closeExpenseModal}
            onSaved={handleExpenseSaved}
          />
        </>
      )}
    </div>
  );
}
