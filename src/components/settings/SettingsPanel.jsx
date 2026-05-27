import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

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

const DEFAULT_VISIBLE_BUCKETS = DEFAULT_DISPATCH_SETTINGS.visibleBuckets;
const DEFAULT_BRIDGE_ALERT_SETTINGS = {
  heartbeatStaleMinutes: 25,
  turoNotificationStaleHours: 12,
};

const SORT_OPTIONS = [
  { value: "priority", label: "Priority queue" },
  { value: "trip_start_asc", label: "Trip start, soonest first" },
  { value: "trip_start_desc", label: "Trip start, latest first" },
  { value: "trip_end_asc", label: "Trip end, soonest first" },
  { value: "trip_end_desc", label: "Trip end, latest first" },
  { value: "vehicle_name", label: "Vehicle name" },
  { value: "guest_name", label: "Guest name" },
  { value: "status_bucket", label: "Status bucket" },
];
const DEFAULT_EXPENSE_CATEGORIES = [
  "Vehicle Onboard",
  "Operating Expense",
  "Maintenance",
  "Insurance",
  "Cleaning",
  "Interest",
  "Fuel",
  "Tools",
  "Tolls",
  "Tires",
  "Hospitality",
  "Parking",
  "Research / Travel",
  "Delivery",
  "Marketing",
];

const BUCKET_LABELS = {
  needs_closeout: "Needs closeout",
  in_progress: "In progress",
  unconfirmed: "Unconfirmed",
  upcoming: "Upcoming",
  canceled: "Canceled",
  closed: "Closed",
};

const EMPTY_VEHICLE = {
  nickname: "",
  vin: "",
  year: "",
  make: "",
  model: "",
  standard_engine: "",
  license_plate: "",
  license_state: "",
  turo_vehicle_id: "",
  turo_vehicle_name: "",
  bouncie_vehicle_id: "",
  dimo_token_id: "",
  provider_vehicle_id: "",
  external_vehicle_key: "",
  imei: "",
  oil_type: "",
  oil_capacity_quarts: "",
  oil_capacity_liters: "",
  rockauto_url: "",
  lockbox_pin: "",
  registration_month: "",
  registration_year: "",
  onboarding_date: "",
  first_trip_start: "",
  effective_onboarding_date: "",
  onboarding_date_source: "",
  acquisition_cost: "",
  retired_at: "",
  in_service: true,
  is_active: true,
};

function loadTellerConnectScript() {
  if (window.TellerConnect) return Promise.resolve(window.TellerConnect);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-teller-connect]");

    if (existing) {
      existing.addEventListener("load", () => resolve(window.TellerConnect));
      existing.addEventListener("error", reject);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.teller.io/connect/connect.js";
    script.dataset.tellerConnect = "true";
    script.onload = () => resolve(window.TellerConnect);
    script.onerror = () => reject(new Error("Failed to load Teller Connect"));
    document.body.appendChild(script);
  });
}

function mergeDispatchSettings(settings) {
  const merged = {
    ...DEFAULT_DISPATCH_SETTINGS,
    ...(settings || {}),
    bucketOrder:
      Array.isArray(settings?.bucketOrder) && settings.bucketOrder.length
        ? settings.bucketOrder
        : DEFAULT_DISPATCH_SETTINGS.bucketOrder,
  };

  merged.visibleBuckets = {
    ...DEFAULT_VISIBLE_BUCKETS,
    ...(settings?.visibleBuckets || {}),
  };

  if (!settings?.visibleBuckets && settings?.showCanceled !== undefined) {
    merged.visibleBuckets.canceled = Boolean(settings.showCanceled);
  }

  merged.showCanceled = Boolean(merged.visibleBuckets.canceled);
  return merged;
}

function mergeBridgeAlertSettings(settings) {
  const heartbeatStaleMinutes = Number(settings?.heartbeatStaleMinutes);
  const turoNotificationStaleHours = Number(settings?.turoNotificationStaleHours);

  return {
    heartbeatStaleMinutes:
      Number.isFinite(heartbeatStaleMinutes) && heartbeatStaleMinutes >= 5
        ? Math.min(heartbeatStaleMinutes, 240)
        : DEFAULT_BRIDGE_ALERT_SETTINGS.heartbeatStaleMinutes,
    turoNotificationStaleHours:
      Number.isFinite(turoNotificationStaleHours) && turoNotificationStaleHours >= 1
        ? Math.min(turoNotificationStaleHours, 168)
        : DEFAULT_BRIDGE_ALERT_SETTINGS.turoNotificationStaleHours,
  };
}

function moveItem(items, index, direction) {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= items.length) return items;

  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(nextIndex, 0, item);
  return next;
}

function toPayloadVehicle(form) {
  const vehicleFields = { ...form };
  delete vehicleFields.first_trip_start;
  delete vehicleFields.effective_onboarding_date;
  delete vehicleFields.onboarding_date_source;
  delete vehicleFields.provider_vehicle_id;
  delete vehicleFields.external_vehicle_key;

  return {
    ...vehicleFields,
    year: vehicleFields.year === "" ? null : Number(vehicleFields.year),
    dimo_token_id:
      vehicleFields.dimo_token_id === ""
        ? null
        : Number(vehicleFields.dimo_token_id),
    acquisition_cost:
      vehicleFields.acquisition_cost === ""
        ? null
        : Number(vehicleFields.acquisition_cost),
    registration_month:
      vehicleFields.registration_month === ""
        ? null
        : Number(vehicleFields.registration_month),
    registration_year:
      vehicleFields.registration_year === ""
        ? null
        : Number(vehicleFields.registration_year),
    oil_capacity_quarts:
      vehicleFields.oil_capacity_quarts === ""
        ? null
        : Number(vehicleFields.oil_capacity_quarts),
    oil_capacity_liters:
      vehicleFields.oil_capacity_liters === ""
        ? null
        : Number(vehicleFields.oil_capacity_liters),
  };
}

function SectionList({ activeSection, onChange }) {
  const sections = [
    { key: "dispatch", title: "Dispatch", sub: "Open trip ordering" },
    { key: "alerts", title: "Alerts", sub: "Bridge warning timing" },
    { key: "fleet", title: "Fleet", sub: "Add and identify cars" },
    { key: "expenses", title: "Expenses", sub: "Categories and imports" },
    { key: "database", title: "Database", sub: "Backup and restore" },
    { key: "telemetry", title: "Telemetry", sub: "Coming next" },
    { key: "logs", title: "Logs", sub: "Server console tail" },
    { key: "maintenance", title: "Maintenance", sub: "Template defaults" },
    { key: "integrations", title: "Integrations", sub: "External systems" },
  ];

  return (
    <section className="panel settings-section-panel">
      <div className="panel-header">
        <div>
          <h2>Settings</h2>
          <span>configure the console</span>
        </div>
      </div>

      <div className="settings-section-list">
        {sections.map((section) => (
          <button
            key={section.key}
            type="button"
            className={`settings-section-row ${
              activeSection === section.key ? "is-active" : ""
            }`}
            onClick={() => onChange(section.key)}
          >
            <strong>{section.title}</strong>
            <span>{section.sub}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function DispatchSettingsPanel({ settings, onSaved }) {
  const [form, setForm] = useState(() => mergeDispatchSettings(settings));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const dirtyRef = useRef(false);
  const saveSeqRef = useRef(0);

  useEffect(() => {
    dirtyRef.current = false;
    setForm(mergeDispatchSettings(settings));
  }, [settings]);

  useEffect(() => {
    if (!dirtyRef.current) return undefined;

    const payload = mergeDispatchSettings(form);
    const saveSeq = saveSeqRef.current + 1;
    saveSeqRef.current = saveSeq;

    setSaving(true);
    setMessage("Saving...");

    const timeoutId = window.setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/settings/ui.dispatch`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: payload }),
        });

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(json?.error || "Failed to save dispatch settings");
        }

        if (saveSeq !== saveSeqRef.current) return;

        dirtyRef.current = false;
        onSaved?.(mergeDispatchSettings(json.value || payload));
        setMessage("Saved");
      } catch (err) {
        if (saveSeq !== saveSeqRef.current) return;

        setMessage(err.message || "Failed to save");
      } finally {
        if (saveSeq === saveSeqRef.current) {
          setSaving(false);
        }
      }
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [form, onSaved]);

  function updateForm(updater) {
    dirtyRef.current = true;
    setForm((current) =>
      mergeDispatchSettings(
        typeof updater === "function" ? updater(current) : updater
      )
    );
  }

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Dispatch</h2>
          <span>open trip queue behavior</span>
        </div>
        <div className="settings-autosave-state">
          {saving ? "Saving..." : message || "Autosaves"}
        </div>
      </div>

      <div className="settings-form">
        <label className="settings-field">
          <span>Default sort</span>
          <select
            value={form.openTripsSort}
            onChange={(e) =>
              updateForm((current) => ({
                ...current,
                openTripsSort: e.target.value,
              }))
            }
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={Boolean(form.pinOverdue)}
            onChange={(e) =>
              updateForm((current) => ({
                ...current,
                pinOverdue: e.target.checked,
              }))
            }
          />
          <span>Keep overdue in-progress trips pinned to the top</span>
        </label>

        <div className="settings-group">
          <div className="settings-group-title">Priority bucket order and visibility</div>
          <div className="settings-bucket-list">
            {form.bucketOrder.map((bucket, index) => (
              <div key={bucket} className="settings-bucket-row">
                <span className="settings-bucket-label">
                  {BUCKET_LABELS[bucket] || bucket}
                </span>
                <div className="settings-bucket-controls">
                  <div className="settings-bucket-actions">
                    <button
                      type="button"
                      onClick={() =>
                        updateForm((current) => ({
                          ...current,
                          bucketOrder: moveItem(current.bucketOrder, index, -1),
                        }))
                      }
                      disabled={index === 0}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateForm((current) => ({
                          ...current,
                          bucketOrder: moveItem(current.bucketOrder, index, 1),
                        }))
                      }
                      disabled={index === form.bucketOrder.length - 1}
                    >
                      Down
                    </button>
                  </div>
                  <button
                    type="button"
                    className={`settings-visibility-pill ${
                      form.visibleBuckets?.[bucket] !== false ? "is-visible" : ""
                    }`}
                    aria-pressed={form.visibleBuckets?.[bucket] !== false}
                    onClick={() =>
                      updateForm((current) => {
                        const currentlyVisible =
                          current.visibleBuckets?.[bucket] !== false;
                        const visibleBuckets = {
                          ...DEFAULT_VISIBLE_BUCKETS,
                          ...(current.visibleBuckets || {}),
                          [bucket]: !currentlyVisible,
                        };

                        return {
                          ...current,
                          visibleBuckets,
                          showCanceled: Boolean(visibleBuckets.canceled),
                        };
                      })
                    }
                  >
                    <span className="settings-visibility-knob" />
                    <span className="settings-visibility-text">
                      {form.visibleBuckets?.[bucket] !== false ? "Visible" : "Hidden"}
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {message && !saving && message !== "Saved" ? (
          <div className="settings-message">{message}</div>
        ) : null}
      </div>
    </section>
  );
}

function AlertSettingsPanel() {
  const [form, setForm] = useState(DEFAULT_BRIDGE_ALERT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const dirtyRef = useRef(false);
  const saveSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        setLoading(true);
        const res = await fetch(`${API_BASE}/api/settings/alerts.bridge`);
        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(json?.error || "Failed to load alert settings");
        }

        if (cancelled) return;
        dirtyRef.current = false;
        setForm(mergeBridgeAlertSettings(json.value));
        setMessage("");
      } catch (err) {
        if (!cancelled) {
          setMessage(err.message || "Failed to load alert settings");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!dirtyRef.current) return undefined;

    const payload = mergeBridgeAlertSettings(form);
    const saveSeq = saveSeqRef.current + 1;
    saveSeqRef.current = saveSeq;

    setSaving(true);
    setMessage("Saving...");

    const timeoutId = window.setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/settings/alerts.bridge`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: payload }),
        });
        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(json?.error || "Failed to save alert settings");
        }

        if (saveSeq !== saveSeqRef.current) return;

        dirtyRef.current = false;
        setForm(mergeBridgeAlertSettings(json.value || payload));
        setMessage("Saved");
      } catch (err) {
        if (saveSeq === saveSeqRef.current) {
          setMessage(err.message || "Failed to save alert settings");
        }
      } finally {
        if (saveSeq === saveSeqRef.current) {
          setSaving(false);
        }
      }
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [form]);

  function updateNumberField(key, value) {
    dirtyRef.current = true;
    setForm((current) =>
      mergeBridgeAlertSettings({
        ...current,
        [key]: value === "" ? "" : Number(value),
      })
    );
  }

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Alerts</h2>
          <span>bridge warning timing</span>
        </div>
        <div className="settings-autosave-state">
          {loading ? "Loading..." : saving ? "Saving..." : message || "Autosaves"}
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">Android bridge</div>
          <div className="settings-form-grid">
            <label className="settings-field">
              <span>Turo notification warning</span>
              <input
                type="number"
                min="1"
                max="168"
                step="1"
                value={form.turoNotificationStaleHours}
                onChange={(event) =>
                  updateNumberField(
                    "turoNotificationStaleHours",
                    event.target.value
                  )
                }
              />
              <small className="settings-field-note">
                Hours with a fresh bridge heartbeat but no Turo notifications before
                Denmark warns that the phone may be logged out.
              </small>
            </label>

            <label className="settings-field">
              <span>Heartbeat stale warning</span>
              <input
                type="number"
                min="5"
                max="240"
                step="5"
                value={form.heartbeatStaleMinutes}
                onChange={(event) =>
                  updateNumberField("heartbeatStaleMinutes", event.target.value)
                }
              />
              <small className="settings-field-note">
                Minutes without an Android bridge heartbeat before the bridge itself
                is considered stale.
              </small>
            </label>
          </div>
        </div>

        {message && !saving && message !== "Saved" ? (
          <div className="settings-message">{message}</div>
        ) : null}
      </div>
    </section>
  );
}

function toDateInputValue(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function toVehicleForm(vehicle = EMPTY_VEHICLE) {
  return {
    ...EMPTY_VEHICLE,
    ...vehicle,
    year: vehicle.year == null ? "" : String(vehicle.year),
    dimo_token_id:
      vehicle.dimo_token_id == null ? "" : String(vehicle.dimo_token_id),
    registration_month:
      vehicle.registration_month == null ? "" : String(vehicle.registration_month),
    registration_year:
      vehicle.registration_year == null ? "" : String(vehicle.registration_year),
    oil_capacity_quarts:
      vehicle.oil_capacity_quarts == null
        ? ""
        : String(vehicle.oil_capacity_quarts),
    oil_capacity_liters:
      vehicle.oil_capacity_liters == null
        ? ""
        : String(vehicle.oil_capacity_liters),
    acquisition_cost:
      vehicle.acquisition_cost == null ? "" : String(vehicle.acquisition_cost),
    onboarding_date: toDateInputValue(vehicle.onboarding_date),
    first_trip_start: toDateInputValue(vehicle.first_trip_start),
    effective_onboarding_date: toDateInputValue(
      vehicle.effective_onboarding_date
    ),
    onboarding_date_source: vehicle.onboarding_date_source || "",
    retired_at: toDateInputValue(vehicle.retired_at),
    in_service: vehicle.in_service !== false,
    is_active: vehicle.is_active !== false,
  };
}

function VehicleConfigFields({ form, update, mode = "edit" }) {
  const derivedOnboardingDate =
    !form.onboarding_date && form.effective_onboarding_date
      ? form.effective_onboarding_date
      : "";

  return (
    <div className="settings-form-grid">
      <label className="settings-field">
        <span>Nickname</span>
        <input
          value={form.nickname || ""}
          onChange={(e) => update("nickname", e.target.value)}
          placeholder="Winnie"
        />
      </label>

      <label className="settings-field">
        <span>VIN</span>
        <input
          required={mode === "add"}
          value={form.vin || ""}
          onChange={(e) => update("vin", e.target.value.toUpperCase())}
          placeholder="17 characters"
        />
      </label>

      <label className="settings-field">
        <span>Year</span>
        <input
          type="number"
          value={form.year || ""}
          onChange={(e) => update("year", e.target.value)}
          placeholder="2016"
        />
      </label>

      <label className="settings-field">
        <span>Make</span>
        <input
          value={form.make || ""}
          onChange={(e) => update("make", e.target.value)}
          placeholder="Hyundai"
        />
      </label>

      <label className="settings-field">
        <span>Model</span>
        <input
          value={form.model || ""}
          onChange={(e) => update("model", e.target.value)}
          placeholder="Accent"
        />
      </label>

      <label className="settings-field">
        <span>Engine</span>
        <input
          value={form.standard_engine || ""}
          onChange={(e) => update("standard_engine", e.target.value)}
          placeholder="1.6L L4"
        />
      </label>

      <label className="settings-field">
        <span>Plate</span>
        <input
          value={form.license_plate || ""}
          onChange={(e) => update("license_plate", e.target.value.toUpperCase())}
        />
      </label>

      <label className="settings-field">
        <span>Plate state</span>
        <input
          value={form.license_state || ""}
          onChange={(e) => update("license_state", e.target.value.toUpperCase())}
          placeholder="TX"
        />
      </label>

      <label className="settings-field">
        <span>Registration month</span>
        <input
          type="number"
          min="1"
          max="12"
          value={form.registration_month || ""}
          onChange={(e) => update("registration_month", e.target.value)}
          placeholder="1-12"
        />
      </label>

      <label className="settings-field">
        <span>Registration year</span>
        <input
          type="number"
          value={form.registration_year || ""}
          onChange={(e) => update("registration_year", e.target.value)}
          placeholder="2026"
        />
      </label>

      <label className="settings-field">
        <span>Onboarding date</span>
        <input
          type="date"
          value={form.onboarding_date || ""}
          onChange={(e) => update("onboarding_date", e.target.value)}
        />
        {derivedOnboardingDate ? (
          <small className="settings-field-note">
            Falls back to first rental trip: {derivedOnboardingDate}
          </small>
        ) : null}
      </label>

      <label className="settings-field">
        <span>Retired date</span>
        <input
          type="date"
          value={form.retired_at || ""}
          onChange={(e) => update("retired_at", e.target.value)}
        />
      </label>

      <label className="settings-field">
        <span>Capex / acquisition cost</span>
        <input
          type="number"
          step="0.01"
          value={form.acquisition_cost || ""}
          onChange={(e) => update("acquisition_cost", e.target.value)}
          placeholder="0.00"
        />
      </label>

      <label className="settings-field">
        <span>Lockbox PIN</span>
        <input
          value={form.lockbox_pin || ""}
          onChange={(e) => update("lockbox_pin", e.target.value)}
        />
      </label>

      <label className="settings-field">
        <span>Turo vehicle ID</span>
        <input
          value={form.turo_vehicle_id || ""}
          onChange={(e) => update("turo_vehicle_id", e.target.value)}
        />
      </label>

      <label className="settings-field">
        <span>Turo name</span>
        <input
          value={form.turo_vehicle_name || ""}
          onChange={(e) => update("turo_vehicle_name", e.target.value)}
        />
      </label>

      <label className="settings-field">
        <span>DIMO token ID</span>
        <input
          type="number"
          value={form.dimo_token_id || ""}
          onChange={(e) => update("dimo_token_id", e.target.value)}
        />
      </label>

      <label className="settings-field">
        <span>Bouncie vehicle ID</span>
        <input
          value={form.bouncie_vehicle_id || ""}
          onChange={(e) => update("bouncie_vehicle_id", e.target.value)}
        />
      </label>

      <label className="settings-field">
        <span>IMEI</span>
        <input
          value={form.imei || ""}
          onChange={(e) => update("imei", e.target.value)}
        />
      </label>

      <label className="settings-field">
        <span>Oil type</span>
        <input
          value={form.oil_type || ""}
          onChange={(e) => update("oil_type", e.target.value)}
          placeholder="0W-20"
        />
      </label>

      <label className="settings-field">
        <span>Oil quarts</span>
        <input
          type="number"
          step="0.1"
          value={form.oil_capacity_quarts || ""}
          onChange={(e) => update("oil_capacity_quarts", e.target.value)}
        />
      </label>

      <label className="settings-field">
        <span>Oil liters</span>
        <input
          type="number"
          step="0.1"
          value={form.oil_capacity_liters || ""}
          onChange={(e) => update("oil_capacity_liters", e.target.value)}
        />
      </label>

      <label className="settings-field settings-field-wide">
        <span>RockAuto URL</span>
        <input
          value={form.rockauto_url || ""}
          onChange={(e) => update("rockauto_url", e.target.value)}
          placeholder="https://www.rockauto.com/..."
        />
      </label>

      <label className="settings-check-row">
        <input
          type="checkbox"
          checked={Boolean(form.is_active)}
          onChange={(e) => update("is_active", e.target.checked)}
        />
        <span>Active in Denmark</span>
      </label>

      <label className="settings-check-row">
        <input
          type="checkbox"
          checked={Boolean(form.in_service)}
          onChange={(e) => update("in_service", e.target.checked)}
        />
        <span>In service for operations</span>
      </label>
    </div>
  );
}

function FleetSettingsPanel() {
  const [vehicles, setVehicles] = useState([]);
  const [form, setForm] = useState(() => toVehicleForm(EMPTY_VEHICLE));
  const [editForms, setEditForms] = useState({});
  const [expandedVehicleId, setExpandedVehicleId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingVehicleId, setSavingVehicleId] = useState(null);
  const [message, setMessage] = useState("");

  async function loadVehicles() {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/vehicles?includeInactive=true`);
      if (!res.ok) throw new Error(`Vehicle request failed: ${res.status}`);
      const data = await res.json();
      const nextVehicles = Array.isArray(data) ? data : [];
      setVehicles(nextVehicles);
      setEditForms(
        Object.fromEntries(
          nextVehicles.map((vehicle) => [vehicle.id, toVehicleForm(vehicle)])
        )
      );
    } catch (err) {
      setMessage(err.message || "Failed to load vehicles");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadVehicles();
  }, []);

  async function addVehicle(e) {
    e.preventDefault();

    try {
      setSaving(true);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/vehicles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPayloadVehicle(form)),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to add vehicle");
      }

      setForm(toVehicleForm(EMPTY_VEHICLE));
      setMessage(`Added ${json.nickname || json.vin || "vehicle"}`);
      await loadVehicles();
    } catch (err) {
      setMessage(err.message || "Failed to add vehicle");
    } finally {
      setSaving(false);
    }
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateVehicleForm(vehicleId, field, value) {
    setEditForms((current) => ({
      ...current,
      [vehicleId]: {
        ...(current[vehicleId] || {}),
        [field]: value,
      },
    }));
  }

  async function saveVehicle(vehicle) {
    const vehicleId = vehicle.id;
    const payload = toPayloadVehicle(editForms[vehicleId] || vehicle);
    const selector = encodeURIComponent(vehicle.vin || vehicle.nickname || vehicle.id);

    try {
      setSavingVehicleId(vehicleId);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/vehicles/${selector}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save vehicle");
      }

      setMessage(`Saved ${json.nickname || json.vin || "vehicle"}`);
      await loadVehicles();
    } catch (err) {
      setMessage(err.message || "Failed to save vehicle");
    } finally {
      setSavingVehicleId(null);
    }
  }

  const activeCount = vehicles.filter((vehicle) => vehicle.is_active !== false).length;
  const inServiceCount = vehicles.filter(
    (vehicle) => vehicle.is_active !== false && vehicle.in_service !== false
  ).length;

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Fleet</h2>
          <span>vehicle configuration and onboarding</span>
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-fleet-summary">
          <div>
            <strong>{loading ? "..." : vehicles.length}</strong>
            <span>total records</span>
          </div>
          <div>
            <strong>{loading ? "..." : activeCount}</strong>
            <span>active</span>
          </div>
          <div>
            <strong>{loading ? "..." : inServiceCount}</strong>
            <span>in service</span>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Configured vehicles</div>
          <div className="settings-empty-state">
            Keep every fleet identifier here: operating state, onboarding and capex,
            Turo IDs, DIMO/Bouncie IDs, registration, maintenance metadata, and
            sourcing links.
          </div>

          <div className="settings-vehicle-config-list">
            {vehicles.map((vehicle) => {
              const isExpanded = expandedVehicleId === vehicle.id;
              const editForm = editForms[vehicle.id] || toVehicleForm(vehicle);
              const title =
                editForm.nickname || editForm.vin || `Vehicle ${vehicle.id}`;
              const subtitle = [editForm.year, editForm.make, editForm.model]
                .filter(Boolean)
                .join(" ");

              return (
                <article key={vehicle.id} className="settings-vehicle-config-card">
                  <button
                    type="button"
                    className="settings-vehicle-config-head"
                    onClick={() =>
                      setExpandedVehicleId(isExpanded ? null : vehicle.id)
                    }
                  >
                    <div>
                      <strong>{title}</strong>
                      <span>{subtitle || editForm.vin || "Vehicle record"}</span>
                    </div>
                    <div className="settings-vehicle-config-badges">
                      <span
                        className={`settings-status-badge ${
                          editForm.is_active ? "is-good" : "is-muted"
                        }`}
                      >
                        {editForm.is_active ? "Active" : "Inactive"}
                      </span>
                      <span
                        className={`settings-status-badge ${
                          editForm.in_service ? "is-good" : "is-warn"
                        }`}
                      >
                        {editForm.in_service ? "In service" : "Out of service"}
                      </span>
                      <span className="settings-status-badge">
                        {editForm.dimo_token_id
                          ? `DIMO ${editForm.dimo_token_id}`
                          : editForm.bouncie_vehicle_id
                          ? "Bouncie linked"
                          : "No telemetry ID"}
                      </span>
                    </div>
                  </button>

                  {isExpanded ? (
                    <div className="settings-vehicle-config-body">
                      <VehicleConfigFields
                        form={editForm}
                        update={(field, value) =>
                          updateVehicleForm(vehicle.id, field, value)
                        }
                      />
                      <div className="settings-form-actions">
                        <button
                          type="button"
                          className="settings-action-btn"
                          disabled={savingVehicleId === vehicle.id}
                          onClick={() => saveVehicle(vehicle)}
                        >
                          {savingVehicleId === vehicle.id
                            ? "Saving..."
                            : "Save vehicle"}
                        </button>
                        <button
                          type="button"
                          className="settings-action-btn secondary"
                          disabled={savingVehicleId === vehicle.id}
                          onClick={() =>
                            setEditForms((current) => ({
                              ...current,
                              [vehicle.id]: toVehicleForm(vehicle),
                            }))
                          }
                        >
                          Reset edits
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>

        <form className="settings-group settings-add-vehicle-card" onSubmit={addVehicle}>
          <div className="settings-group-title">Add vehicle</div>
          <div className="settings-empty-state">
            Create the canonical Denmark record before telemetry, Turo imports,
            or expenses arrive. VIN is the anchor; everything else can be filled
            in as the car onboards.
          </div>

          <VehicleConfigFields form={form} update={update} mode="add" />

          <div className="settings-form-actions">
            <button
              type="submit"
              className="settings-action-btn"
              disabled={saving}
            >
              {saving ? "Adding..." : "Add Vehicle"}
            </button>
            {message ? <span className="settings-message">{message}</span> : null}
          </div>
        </form>
      </div>
    </section>
  );
}

function DatabaseSettingsPanel() {
  const [backupStatus, setBackupStatus] = useState("");
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [restoreStatus, setRestoreStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function downloadBackup({ compressed = false } = {}) {
    try {
      setBusy(true);
      setBackupStatus(
        compressed ? "Streaming compressed backup..." : "Streaming backup..."
      );

      const res = await fetch(
        `${API_BASE}/api/database/backup${compressed ? "?compress=gzip" : ""}`
      );

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || `Backup failed (${res.status})`);
      }

      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename =
        match?.[1] || `denmark-db-backup-${new Date().toISOString()}.json`;
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      setBackupStatus(`Downloaded ${filename}`);
    } catch (err) {
      setBackupStatus(err.message || "Backup failed");
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup() {
    if (!restoreFile) {
      setRestoreStatus("Choose a backup JSON file first.");
      return;
    }

    if (restoreConfirm !== "RESTORE") {
      setRestoreStatus("Type RESTORE to confirm.");
      return;
    }

    try {
      setBusy(true);
      setRestoreStatus("Reading backup...");

      const text = await restoreFile.text();
      const backup = JSON.parse(text);

      setRestoreStatus("Restoring database...");

      const res = await fetch(`${API_BASE}/api/database/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: restoreConfirm, backup }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || `Restore failed (${res.status})`);
      }

      setRestoreStatus(
        `Restored ${json.restoredRows || 0} rows across ${
          json.restoredTables || 0
        } tables. Refresh the app.`
      );
      setRestoreFile(null);
      setRestoreConfirm("");
    } catch (err) {
      setRestoreStatus(err.message || "Restore failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Database</h2>
          <span>backup and restore local Postgres data</span>
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">Backup</div>
          <div className="settings-empty-state">
            Stream a JSON snapshot of every table in the public schema. The
            compressed download is much smaller for storage; decompress it
            before using the current restore form.
          </div>
          <div className="settings-form-actions">
            <button
              type="button"
              className="settings-action-btn"
              disabled={busy}
              onClick={() => downloadBackup()}
            >
              {busy ? "Working..." : "Download JSON Backup"}
            </button>
            <button
              type="button"
              className="settings-action-btn"
              disabled={busy}
              onClick={() => downloadBackup({ compressed: true })}
            >
              {busy ? "Working..." : "Download Compressed Backup"}
            </button>
            {backupStatus ? (
              <span className="settings-message">{backupStatus}</span>
            ) : null}
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Restore</div>
          <div className="settings-empty-state">
            Restore replaces the current database contents with the selected
            backup. This is meant for local recovery, not merging two datasets.
          </div>

          <label className="settings-field">
            <span>Backup file</span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => setRestoreFile(e.target.files?.[0] || null)}
            />
          </label>

          <label className="settings-field">
            <span>Type RESTORE to confirm</span>
            <input
              value={restoreConfirm}
              onChange={(e) => setRestoreConfirm(e.target.value)}
              placeholder="RESTORE"
            />
          </label>

          <div className="settings-form-actions">
            <button
              type="button"
              className="settings-action-btn settings-action-btn--danger"
              disabled={busy || !restoreFile || restoreConfirm !== "RESTORE"}
              onClick={restoreBackup}
            >
              Restore Database
            </button>
            {restoreStatus ? (
              <span className="settings-message">{restoreStatus}</span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function normalizeCategories(value) {
  const categories = Array.isArray(value)
    ? value
    : Array.isArray(value?.categories)
      ? value.categories
      : DEFAULT_EXPENSE_CATEGORIES;

  return Array.from(
    new Set(
      categories
        .map((category) => String(category || "").trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

function ExpenseSettingsPanel() {
  const [categories, setCategories] = useState(DEFAULT_EXPENSE_CATEGORIES);
  const [newCategory, setNewCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function loadCategories() {
    try {
      setLoading(true);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/settings/expenses.categories`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load expense categories");
      }

      setCategories(normalizeCategories(json.value));
    } catch (err) {
      setMessage(err.message || "Failed to load categories");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCategories();
  }, []);

  async function saveCategories(nextCategories) {
    try {
      setSaving(true);
      setMessage("Saving...");

      const payload = normalizeCategories(nextCategories);
      const res = await fetch(`${API_BASE}/api/settings/expenses.categories`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: { categories: payload } }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save categories");
      }

      setCategories(normalizeCategories(json.value));
      setMessage("Saved");
    } catch (err) {
      setMessage(err.message || "Failed to save categories");
    } finally {
      setSaving(false);
    }
  }

  function addCategory() {
    const category = newCategory.trim();
    if (!category) return;
    setNewCategory("");
    void saveCategories([...categories, category]);
  }

  function removeCategory(category) {
    void saveCategories(categories.filter((item) => item !== category));
  }

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Expenses</h2>
          <span>import category options</span>
        </div>
        <div className="settings-autosave-state">
          {loading ? "Loading..." : saving ? "Saving..." : message || "Ready"}
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">Expense categories</div>
          <div className="settings-empty-state">
            These categories populate the imported transaction expense form.
            Existing expense history is still used for suggestions.
          </div>

          <div className="settings-inline-add">
            <input
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCategory();
                }
              }}
              placeholder="New category"
              disabled={loading || saving}
            />
            <button
              type="button"
              className="settings-action-btn"
              disabled={loading || saving || !newCategory.trim()}
              onClick={addCategory}
            >
              Add Category
            </button>
          </div>

          <div className="settings-category-list">
            {categories.map((category) => (
              <div key={category} className="settings-category-row">
                <span>{category}</span>
                <button
                  type="button"
                  className="settings-category-remove"
                  disabled={saving}
                  onClick={() => removeCategory(category)}
                  title={`Remove ${category}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          {message && message !== "Saved" ? (
            <span className="settings-message">{message}</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function DimoShareCard({ config, status = [], loading }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const shareTarget = String(config?.shareTarget || "").trim();
  const vehicles = Array.isArray(status) ? status : [];
  const vehiclesWithTelemetry = vehicles.filter((vehicle) => {
    const telemetry = vehicle?.telemetry || {};
    return (
      telemetry.odometer != null ||
      telemetry.location?.lat != null ||
      telemetry.location?.lon != null ||
      Number(telemetry.dimo?.available_signals_count || 0) > 0
    );
  }).length;

  useEffect(() => {
    let cancelled = false;

    async function buildQr() {
      if (!shareTarget) {
        setQrDataUrl("");
        return;
      }

      try {
        const url = await QRCode.toDataURL(shareTarget, {
          width: 220,
          margin: 2,
          color: {
            dark: "#0b1220",
            light: "#f8fafc",
          },
        });

        if (!cancelled) setQrDataUrl(url);
      } catch {
        if (!cancelled) setQrDataUrl("");
      }
    }

    buildQr();

    return () => {
      cancelled = true;
    };
  }, [shareTarget]);

  async function copyShareTarget() {
    if (!shareTarget) return;

    try {
      await navigator.clipboard.writeText(shareTarget);
      setCopyMessage("Copied");
      window.setTimeout(() => setCopyMessage(""), 1600);
    } catch {
      setCopyMessage("Copy failed");
      window.setTimeout(() => setCopyMessage(""), 2200);
    }
  }

  return (
    <div className="settings-dimo-share-card">
      <div className="settings-dimo-share-copy">
        <div className="settings-group-title">DIMO vehicle sharing</div>
        <div className="settings-empty-state">
          In the DIMO mobile app, open a vehicle, add a new individual under
          sharing, turn on indefinite sharing, then scan this QR or paste the
          share target below. Denmark only exposes the public Developer License
          target here, never DIMO JWTs or private keys.
        </div>

        <div className="settings-dimo-instructions">
          <strong>Next time:</strong>
          <span>
            Go to the vehicle in the DIMO app, open Vehicle Settings, tap
            Permission Sharing, then share with another entity using this QR or
            share target.
          </span>
        </div>

        <div className="settings-dimo-instructions">
          <strong>After sharing:</strong>
          <span>
            Add the vehicle's DIMO token ID on its Fleet settings vehicle card.
            Denmark polls DIMO from those database vehicle records now, so
            per-car DIMO IDs no longer need to be maintained in the server .env.
          </span>
        </div>

        <div className="settings-vehicle-list">
          <div className="settings-vehicle-row">
            <strong>Share target</strong>
            <span>
              {loading
                ? "Loading..."
                : shareTarget || "Missing DIMO_CLIENT_ID"}
            </span>
          </div>
          <div className="settings-vehicle-row">
            <strong>Type</strong>
            <span>
              {loading
                ? "Loading..."
                : config?.shareTargetKind === "wallet_address"
                ? "Wallet address"
                : config?.shareTargetKind
                ? "ENS / name"
                : "Not configured"}
            </span>
          </div>
          <div className="settings-vehicle-row">
            <strong>Configured vehicles</strong>
            <span>
              {loading
                ? "Loading..."
                : `${vehicles.length} configured, ${vehiclesWithTelemetry} with telemetry`}
            </span>
          </div>
        </div>

        {vehicles.length ? (
          <div className="settings-vehicle-list">
            {vehicles.map((vehicle) => {
              const dimo = vehicle?.telemetry?.dimo || {};
              const missing = Array.isArray(dimo.missing_privileges)
                ? dimo.missing_privileges
                : [];
              const signalCount = Number(dimo.available_signals_count || 0);
              const label =
                vehicle.nickname ||
                [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") ||
                vehicle.vin ||
                `DIMO ${vehicle.dimo_token_id}`;
              const statusText = missing.length
                ? `Missing ${missing.join(", ")}`
                : signalCount > 0
                ? `${signalCount} signals`
                : "No DIMO signals";

              return (
                <div key={vehicle.dimo_token_id || vehicle.vin || label} className="settings-vehicle-row">
                  <strong>{label}</strong>
                  <span>{statusText}</span>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="settings-form-actions">
          <button
            type="button"
            className="settings-action-btn"
            disabled={loading || !shareTarget}
            onClick={copyShareTarget}
          >
            Copy Share Target
          </button>
          {copyMessage ? (
            <span className="settings-message">{copyMessage}</span>
          ) : null}
        </div>
      </div>

      <div className="settings-dimo-qr-wrap">
        {qrDataUrl ? (
          <img
            className="settings-dimo-qr"
            src={qrDataUrl}
            alt="DIMO developer share target QR code"
          />
        ) : (
          <div className="settings-dimo-qr-placeholder">
            {loading ? "Loading QR..." : "No DIMO share target"}
          </div>
        )}
      </div>
    </div>
  );
}

function GoogleCalendarCard({
  status,
  loading,
  syncing,
  onConnect,
  onSync,
}) {
  const tokenStatus = status?.tokenStatus || "missing";
  const needsReconnect =
    tokenStatus === "invalid" ||
    tokenStatus === "missing" ||
    !status?.configured;
  const statusLabel = loading
    ? "Checking..."
    : status?.connected
    ? "Connected"
    : needsReconnect
    ? "Reconnect needed"
    : "Needs setup";
  const badgeClass = status?.connected
    ? "is-ok"
    : needsReconnect
    ? "is-warn"
    : "is-muted";
  const lastSynced = status?.sync?.lastSyncedAt
    ? new Date(status.sync.lastSyncedAt).toLocaleString()
    : "Never";

  return (
    <div className="settings-group">
      <div className="settings-group-title">Google Calendar</div>
      <div className="settings-empty-state">
        Trip pickup, return, and closeout events sync to the selected Google
        calendar. Google can revoke offline access without a predictable expiry,
        so Denmark checks the saved token directly.
      </div>

      <div className="settings-vehicle-list">
        <div className="settings-vehicle-row">
          <strong>Status</strong>
          <span className={`settings-status-badge ${badgeClass}`}>
            {statusLabel}
          </span>
        </div>
        <div className="settings-vehicle-row">
          <strong>Calendar</strong>
          <span>
            {loading
              ? "Loading..."
              : status?.selectedCalendar?.summary ||
                status?.selectedCalendar?.id ||
                "None selected"}
          </span>
        </div>
        <div className="settings-vehicle-row">
          <strong>Last sync</strong>
          <span>{loading ? "Loading..." : lastSynced}</span>
        </div>
        <div className="settings-vehicle-row">
          <strong>Synced trips</strong>
          <span>{loading ? "Loading..." : status?.sync?.syncedTrips || 0}</span>
        </div>
        {!loading && status?.tokenError ? (
          <div className="settings-vehicle-row">
            <strong>Google response</strong>
            <span>{status.tokenError}</span>
          </div>
        ) : null}
      </div>

      <div className="settings-form-actions">
        <button
          type="button"
          className="settings-action-btn"
          disabled={loading}
          onClick={onConnect}
        >
          {needsReconnect ? "Reconnect Google" : "Refresh Connection"}
        </button>
        <button
          type="button"
          className="settings-action-btn secondary"
          disabled={loading || syncing || !status?.connected}
          onClick={onSync}
        >
          {syncing ? "Syncing..." : "Sync Trips"}
        </button>
      </div>
    </div>
  );
}

function IntegrationsSettingsPanel() {
  const [config, setConfig] = useState(null);
  const [connections, setConnections] = useState(null);
  const [mercuryConfig, setMercuryConfig] = useState(null);
  const [dimoConfig, setDimoConfig] = useState(null);
  const [dimoStatus, setDimoStatus] = useState([]);
  const [googleCalendarStatus, setGoogleCalendarStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingMercury, setSyncingMercury] = useState(false);
  const [syncingGoogleCalendar, setSyncingGoogleCalendar] = useState(false);
  const [message, setMessage] = useState("");

  async function loadTellerState() {
    try {
      setLoading(true);
      setMessage("");

      const [
        configRes,
        connectionsRes,
        mercuryConfigRes,
        dimoConfigRes,
        dimoStatusRes,
        googleCalendarStatusRes,
      ] = await Promise.all([
        fetch(`${API_BASE}/api/teller/connect/config`),
        fetch(`${API_BASE}/api/teller/connections`),
        fetch(`${API_BASE}/api/teller/mercury/config`),
        fetch(`${API_BASE}/api/dimo/config`),
        fetch(`${API_BASE}/api/dimo/status`),
        fetch(`${API_BASE}/api/integrations/google-calendar/status`),
      ]);

      const configJson = await configRes.json().catch(() => ({}));
      const connectionsJson = await connectionsRes.json().catch(() => ({}));
      const mercuryConfigJson = await mercuryConfigRes.json().catch(() => ({}));
      const dimoConfigJson = await dimoConfigRes.json().catch(() => ({}));
      const dimoStatusJson = await dimoStatusRes.json().catch(() => []);
      const googleCalendarStatusJson = await googleCalendarStatusRes
        .json()
        .catch(() => ({}));

      if (!configRes.ok) {
        throw new Error(configJson?.error || "Failed to load Teller config");
      }

      if (!connectionsRes.ok) {
        throw new Error(
          connectionsJson?.error || "Failed to load Teller connections"
        );
      }

      if (!mercuryConfigRes.ok) {
        throw new Error(
          mercuryConfigJson?.error || "Failed to load Mercury config"
        );
      }

      if (!dimoConfigRes.ok) {
        throw new Error(dimoConfigJson?.error || "Failed to load DIMO config");
      }

      if (!dimoStatusRes.ok) {
        throw new Error(
          dimoStatusJson?.error || "Failed to load DIMO vehicle status"
        );
      }

      if (!googleCalendarStatusRes.ok) {
        throw new Error(
          googleCalendarStatusJson?.error ||
            "Failed to load Google Calendar status"
        );
      }

      setConfig(configJson);
      setConnections(connectionsJson);
      setMercuryConfig(mercuryConfigJson);
      setDimoConfig(dimoConfigJson);
      setDimoStatus(Array.isArray(dimoStatusJson) ? dimoStatusJson : []);
      setGoogleCalendarStatus(googleCalendarStatusJson);
    } catch (err) {
      setMessage(err.message || "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTellerState();
  }, []);

  async function saveTellerEnrollment(enrollment) {
    const accessToken = enrollment?.accessToken;

    if (!accessToken) {
      throw new Error("Teller did not return an access token");
    }

    const res = await fetch(`${API_BASE}/api/teller/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: accessToken }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(json?.error || "Failed to save Teller connection");
    }

    return json;
  }

  async function connectTeller() {
    try {
      setConnecting(true);
      setMessage("");

      if (!config?.configured) {
        throw new Error("Add TELLER_APPLICATION_ID to .env before connecting.");
      }

      const TellerConnect = await loadTellerConnectScript();

      if (!TellerConnect?.setup) {
        throw new Error("Teller Connect did not initialize");
      }

      const tellerConnect = TellerConnect.setup({
        applicationId: config.applicationId,
        environment: config.environment || "development",
        products: config.products || ["transactions", "balance"],
        selectAccount: config.selectAccount || "multiple",
        onSuccess: async (enrollment) => {
          try {
            const result = await saveTellerEnrollment(enrollment);
            setMessage(
              result.created
                ? "Teller connection saved. Syncing transactions..."
                : "Teller connection already existed. Syncing transactions..."
            );
            await syncTeller();
            await loadTellerState();
          } catch (err) {
            setMessage(err.message || "Failed to save Teller connection");
          } finally {
            setConnecting(false);
          }
        },
        onExit: () => {
          setConnecting(false);
        },
      });

      tellerConnect.open();
    } catch (err) {
      setConnecting(false);
      setMessage(err.message || "Failed to open Teller Connect");
    }
  }

  async function syncTeller() {
    try {
      setSyncing(true);

      const res = await fetch(`${API_BASE}/api/teller/sync`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to sync Teller");
      }

      setMessage(
        `Synced ${json.processed || 0} bank transaction${
          Number(json.processed || 0) === 1 ? "" : "s"
        }.`
      );
      await loadTellerState();
    } catch (err) {
      setMessage(err.message || "Failed to sync Teller");
    } finally {
      setSyncing(false);
    }
  }

  async function syncMercury() {
    try {
      setSyncingMercury(true);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/teller/mercury/sync`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to sync Mercury");
      }

      setMessage(
        `Synced ${json.processed || 0} Mercury transaction${
          Number(json.processed || 0) === 1 ? "" : "s"
        }.`
      );
      await loadTellerState();
    } catch (err) {
      setMessage(err.message || "Failed to sync Mercury");
    } finally {
      setSyncingMercury(false);
    }
  }

  function connectGoogleCalendar() {
    window.location.href = `${API_BASE}/api/integrations/google-calendar/connect`;
  }

  async function syncGoogleCalendar() {
    try {
      setSyncingGoogleCalendar(true);
      setMessage("");

      const res = await fetch(
        `${API_BASE}/api/integrations/google-calendar/reconcile-trips`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 500 }),
        }
      );
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to sync Google Calendar");
      }

      const failures = (json.results || []).filter((item) => !item.ok);
      const failed = failures.length;
      const firstFailure = failures.find((item) => item?.error)?.error;
      setMessage(
        `Google Calendar processed ${json.processed || 0} trip${
          Number(json.processed || 0) === 1 ? "" : "s"
        }${failed ? ` with ${failed} failure${failed === 1 ? "" : "s"}` : ""}${
          firstFailure ? `: ${firstFailure}` : ""
        }.`
      );
      await loadTellerState();
    } catch (err) {
      setMessage(err.message || "Failed to sync Google Calendar");
    } finally {
      setSyncingGoogleCalendar(false);
    }
  }

  const latestConnected = connections?.latest_connected_at
    ? new Date(connections.latest_connected_at).toLocaleString()
    : "Never";

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Integrations</h2>
          <span>banking, telemetry, and external systems</span>
        </div>
      </div>

      <div className="settings-form">
        <DimoShareCard
          config={dimoConfig}
          status={dimoStatus}
          loading={loading}
        />

        <GoogleCalendarCard
          status={googleCalendarStatus}
          loading={loading}
          syncing={syncingGoogleCalendar}
          onConnect={connectGoogleCalendar}
          onSync={syncGoogleCalendar}
        />

        <div className="settings-group">
          <div className="settings-group-title">Teller</div>
          <div className="settings-empty-state">
            Connect another bank or card through Teller. New connections are added
            to the sync pool; existing expense matching still happens in Inbox.
          </div>

          <div className="settings-vehicle-list">
            <div className="settings-vehicle-row">
              <strong>Connections</strong>
              <span>{loading ? "Loading..." : connections?.token_count || 0}</span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Latest connection</strong>
              <span>{loading ? "Loading..." : latestConnected}</span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Connect config</strong>
              <span>
                {loading
                  ? "Loading..."
                  : config?.configured
                  ? `${config.environment || "development"}`
                  : "Missing TELLER_APPLICATION_ID"}
              </span>
            </div>
          </div>

          <div className="settings-form-actions">
            <button
              type="button"
              className="settings-action-btn"
              disabled={loading || connecting || !config?.configured}
              onClick={connectTeller}
            >
              {connecting ? "Opening..." : "Connect Bank"}
            </button>
            <button
              type="button"
              className="settings-action-btn secondary"
              disabled={loading || syncing || !connections?.token_count}
              onClick={syncTeller}
            >
              {syncing ? "Syncing..." : "Sync Teller"}
            </button>
            {message ? <span className="settings-message">{message}</span> : null}
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Mercury</div>
          <div className="settings-empty-state">
            Mercury uses its direct API token and imports into the same Inbox
            review flow as Teller card transactions.
          </div>

          <div className="settings-vehicle-list">
            <div className="settings-vehicle-row">
              <strong>API key</strong>
              <span>
                {loading
                  ? "Loading..."
                  : mercuryConfig?.configured
                    ? `Configured (${mercuryConfig.envKey || "MERCURY_API_KEY"})`
                    : "Missing MERCURY_API_KEY"}
              </span>
            </div>
          </div>

          <div className="settings-form-actions">
            <button
              type="button"
              className="settings-action-btn"
              disabled={loading || syncingMercury || !mercuryConfig?.configured}
              onClick={syncMercury}
            >
              {syncingMercury ? "Syncing..." : "Sync Mercury"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function TelemetrySettingsPanel() {
  const [dimoDebug, setDimoDebug] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function loadDimoDebug() {
    try {
      setLoading(true);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/dimo/debug/fleet`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load DIMO debug fleet");
      }

      setDimoDebug(json);
    } catch (err) {
      setMessage(err.message || "Failed to load DIMO debug fleet");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDimoDebug();
  }, []);

  const sharedCount = dimoDebug?.sharedReturned?.length || 0;
  const configuredCount = dimoDebug?.configuredLocal?.length || 0;
  const pollableCount = dimoDebug?.pollableFleet?.length || 0;

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Telemetry</h2>
          <span>DIMO fleet troubleshooting</span>
        </div>
        <button
          type="button"
          className="settings-action-btn secondary"
          disabled={loading}
          onClick={loadDimoDebug}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">DIMO fleet intersection</div>
          <div className="settings-empty-state">
            This shows what DIMO returns as shared, what Denmark has configured
            locally, and the intersection Denmark will actually poll.
          </div>

          <div className="settings-fleet-summary">
            <div>
              <strong>{loading && !dimoDebug ? "..." : sharedCount}</strong>
              <span>shared returned</span>
            </div>
            <div>
              <strong>{loading && !dimoDebug ? "..." : configuredCount}</strong>
              <span>configured local</span>
            </div>
            <div>
              <strong>{loading && !dimoDebug ? "..." : pollableCount}</strong>
              <span>pollable</span>
            </div>
          </div>

          {message ? <span className="settings-message">{message}</span> : null}
          {dimoDebug?.sharedError ? (
            <span className="settings-message">
              DIMO shared vehicle fetch failed: {dimoDebug.sharedError}
            </span>
          ) : null}

          <pre className="settings-json-view">
            {dimoDebug
              ? JSON.stringify(dimoDebug, null, 2)
              : loading
                ? "Loading DIMO debug fleet..."
                : "No DIMO debug payload loaded."}
          </pre>
        </div>
      </div>
    </section>
  );
}

function formatLogTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLogLine(entry) {
  const level = String(entry?.level || "log").toUpperCase().padEnd(5, " ");
  return `[${formatLogTimestamp(entry?.at)}] ${level} ${entry?.message || ""}`;
}

function ServerLogsSettingsPanel() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [liveFollow, setLiveFollow] = useState(true);
  const logRef = useRef(null);

  async function loadLogs({ append = false } = {}) {
    try {
      setLoading(true);
      setMessage("");

      const lastId = append ? entries[entries.length - 1]?.id : null;
      const params = new URLSearchParams({ limit: append ? "250" : "500" });
      if (append && lastId) params.set("afterId", String(lastId));

      const res = await fetch(`${API_BASE}/api/server/logs?${params}`, {
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load server logs");
      }

      const nextEntries = Array.isArray(json.entries) ? json.entries : [];
      setEntries((current) =>
        append
          ? [...current, ...nextEntries].slice(-500)
          : nextEntries
      );
    } catch (err) {
      setMessage(err.message || "Failed to load server logs");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLogs();
  }, []);

  useEffect(() => {
    if (!liveFollow) return undefined;
    const interval = window.setInterval(() => {
      loadLogs({ append: true });
    }, 3000);
    return () => window.clearInterval(interval);
  }, [liveFollow, entries]);

  useEffect(() => {
    if (!liveFollow || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [entries, liveFollow]);

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Logs</h2>
          <span>server console tail</span>
        </div>
        <div className="settings-form-actions">
          <label className="settings-checkbox-row settings-log-follow">
            <input
              type="checkbox"
              checked={liveFollow}
              onChange={(event) => setLiveFollow(event.target.checked)}
            />
            <span>Live follow</span>
          </label>
          <button
            type="button"
            className="settings-action-btn secondary"
            disabled={loading}
            onClick={() => loadLogs()}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">Node output</div>
          <div className="settings-empty-state">
            This mirrors the backend process console from the current server
            runtime. It keeps the latest 1,000 lines in memory and resets when
            the backend restarts.
          </div>

          {message ? <span className="settings-message">{message}</span> : null}

          <pre ref={logRef} className="settings-json-view settings-log-view">
            {entries.length
              ? entries.map(formatLogLine).join("\n")
              : loading
                ? "Loading server logs..."
                : "No server log entries captured yet."}
          </pre>
        </div>
      </div>
    </section>
  );
}

function SettingsHelpPanel({ activeSection }) {
  const copy = useMemo(() => {
    if (activeSection === "dispatch") {
      return {
        title: "Dispatch preview",
        body:
          "These settings control the Open Trips panel. Priority mode still uses trip urgency, but the bucket order and canceled-trip visibility are now configurable.",
      };
    }

    if (activeSection === "fleet") {
      return {
        title: "Fleet notes",
        body:
          "Add cars here before telemetry exists. Bouncie and DIMO can enrich the same vehicle later when their IDs or VINs match.",
      };
    }

    if (activeSection === "alerts") {
      return {
        title: "Bridge alerts",
        body:
          "The Turo notification warning only fires while the Android bridge heartbeat is still fresh. Denmark sends one SMS per stale episode, then waits for a new Turo notification before alerting again.",
      };
    }

    if (activeSection === "database") {
      return {
        title: "Database safety",
        body:
          "Backups are full JSON snapshots of the local public schema. Restore is intentionally destructive: it clears current tables and reloads the backup.",
      };
    }

    if (activeSection === "expenses") {
      return {
        title: "Expense setup",
        body:
          "These categories feed the imported transaction expense form. Saved expense history still contributes smart suggestions.",
      };
    }

    if (activeSection === "integrations") {
      return {
        title: "Banking setup",
        body:
          "Teller uses bank enrollments, while Mercury uses its direct API token. Both land in the same Inbox review and expense matching flow.",
      };
    }

    if (activeSection === "telemetry") {
      return {
        title: "Telemetry debug",
        body:
          "DIMO polling requires a vehicle to appear in both the DIMO shared vehicle response and Denmark's local fleet settings. The pollable list is that intersection.",
      };
    }

    if (activeSection === "logs") {
      return {
        title: "Server logs",
        body:
          "This is a live tail of the backend console for the current Node process. Restarting the server clears the in-memory buffer.",
      };
    }

    return {
      title: "Coming next",
      body:
        "This settings area is ready to hold maintenance templates, telemetry toggles, and integration-specific controls.",
    };
  }, [activeSection]);

  return (
    <section className="panel settings-help-panel">
      <div className="panel-header">
        <div>
          <h2>{copy.title}</h2>
          <span>configuration context</span>
        </div>
      </div>
      <div className="settings-help-copy">{copy.body}</div>
    </section>
  );
}

export default function SettingsPanel({
  dispatchSettings,
  onDispatchSettingsSaved,
}) {
  const [activeSection, setActiveSection] = useState("dispatch");

  return (
    <>
      <SectionList activeSection={activeSection} onChange={setActiveSection} />

      {activeSection === "dispatch" ? (
        <DispatchSettingsPanel
          settings={dispatchSettings}
          onSaved={onDispatchSettingsSaved}
        />
      ) : activeSection === "alerts" ? (
        <AlertSettingsPanel />
      ) : activeSection === "fleet" ? (
        <FleetSettingsPanel />
      ) : activeSection === "expenses" ? (
        <ExpenseSettingsPanel />
      ) : activeSection === "database" ? (
        <DatabaseSettingsPanel />
      ) : activeSection === "integrations" ? (
        <IntegrationsSettingsPanel />
      ) : activeSection === "telemetry" ? (
        <TelemetrySettingsPanel />
      ) : activeSection === "logs" ? (
        <ServerLogsSettingsPanel />
      ) : (
        <section className="panel settings-main-panel">
          <div className="panel-header">
            <div>
              <h2>Not wired yet</h2>
              <span>reserved settings section</span>
            </div>
          </div>
          <div className="settings-empty-state">
            This section has a home now. We can add the controls when the workflow
            is ready.
          </div>
        </section>
      )}

      <SettingsHelpPanel activeSection={activeSection} />
    </>
  );
}


