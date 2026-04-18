import { useEffect, useMemo, useState } from "react";

const API_BASE = "http://localhost:5000";

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
  imei: "",
  oil_type: "",
  oil_capacity_quarts: "",
  rockauto_url: "",
  is_active: true,
};

function mergeDispatchSettings(settings) {
  return {
    ...DEFAULT_DISPATCH_SETTINGS,
    ...(settings || {}),
    bucketOrder:
      Array.isArray(settings?.bucketOrder) && settings.bucketOrder.length
        ? settings.bucketOrder
        : DEFAULT_DISPATCH_SETTINGS.bucketOrder,
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
  return {
    ...form,
    year: form.year === "" ? null : Number(form.year),
    dimo_token_id: form.dimo_token_id === "" ? null : Number(form.dimo_token_id),
    oil_capacity_quarts:
      form.oil_capacity_quarts === "" ? null : Number(form.oil_capacity_quarts),
  };
}

function SectionList({ activeSection, onChange }) {
  const sections = [
    { key: "dispatch", title: "Dispatch", sub: "Open trip ordering" },
    { key: "fleet", title: "Fleet", sub: "Add and identify cars" },
    { key: "telemetry", title: "Telemetry", sub: "Coming next" },
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

  useEffect(() => {
    setForm(mergeDispatchSettings(settings));
  }, [settings]);

  async function save() {
    try {
      setSaving(true);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/settings/ui.dispatch`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: form }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save dispatch settings");
      }

      onSaved?.(mergeDispatchSettings(json.value));
      setMessage("Saved");
    } catch (err) {
      setMessage(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Dispatch</h2>
          <span>open trip queue behavior</span>
        </div>
        <button
          type="button"
          className="settings-action-btn"
          onClick={save}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      <div className="settings-form">
        <label className="settings-field">
          <span>Default sort</span>
          <select
            value={form.openTripsSort}
            onChange={(e) =>
              setForm((current) => ({
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
              setForm((current) => ({
                ...current,
                pinOverdue: e.target.checked,
              }))
            }
          />
          <span>Keep overdue in-progress trips pinned to the top</span>
        </label>

        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={Boolean(form.showCanceled)}
            onChange={(e) =>
              setForm((current) => ({
                ...current,
                showCanceled: e.target.checked,
              }))
            }
          />
          <span>Show canceled trips in the Open Trips panel</span>
        </label>

        <div className="settings-group">
          <div className="settings-group-title">Priority bucket order</div>
          <div className="settings-bucket-list">
            {form.bucketOrder.map((bucket, index) => (
              <div key={bucket} className="settings-bucket-row">
                <span>{BUCKET_LABELS[bucket] || bucket}</span>
                <div className="settings-bucket-actions">
                  <button
                    type="button"
                    onClick={() =>
                      setForm((current) => ({
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
                      setForm((current) => ({
                        ...current,
                        bucketOrder: moveItem(current.bucketOrder, index, 1),
                      }))
                    }
                    disabled={index === form.bucketOrder.length - 1}
                  >
                    Down
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {message ? <div className="settings-message">{message}</div> : null}
      </div>
    </section>
  );
}

function FleetSettingsPanel() {
  const [vehicles, setVehicles] = useState([]);
  const [form, setForm] = useState(EMPTY_VEHICLE);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function loadVehicles() {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/vehicles`);
      if (!res.ok) throw new Error(`Vehicle request failed: ${res.status}`);
      const data = await res.json();
      setVehicles(Array.isArray(data) ? data : []);
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

      setForm(EMPTY_VEHICLE);
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

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Fleet</h2>
          <span>add a canonical vehicle record</span>
        </div>
      </div>

      <form className="settings-form" onSubmit={addVehicle}>
        <div className="settings-form-grid">
          <label className="settings-field">
            <span>Nickname</span>
            <input
              value={form.nickname}
              onChange={(e) => update("nickname", e.target.value)}
              placeholder="Winnie"
            />
          </label>

          <label className="settings-field">
            <span>VIN</span>
            <input
              required
              value={form.vin}
              onChange={(e) => update("vin", e.target.value)}
              placeholder="17 characters"
            />
          </label>

          <label className="settings-field">
            <span>Year</span>
            <input
              type="number"
              value={form.year}
              onChange={(e) => update("year", e.target.value)}
              placeholder="2016"
            />
          </label>

          <label className="settings-field">
            <span>Make</span>
            <input
              value={form.make}
              onChange={(e) => update("make", e.target.value)}
              placeholder="Honda"
            />
          </label>

          <label className="settings-field">
            <span>Model</span>
            <input
              value={form.model}
              onChange={(e) => update("model", e.target.value)}
              placeholder="Fit"
            />
          </label>

          <label className="settings-field">
            <span>Engine</span>
            <input
              value={form.standard_engine}
              onChange={(e) => update("standard_engine", e.target.value)}
              placeholder="1.5L L4"
            />
          </label>

          <label className="settings-field">
            <span>Plate</span>
            <input
              value={form.license_plate}
              onChange={(e) => update("license_plate", e.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>Plate state</span>
            <input
              value={form.license_state}
              onChange={(e) => update("license_state", e.target.value)}
              placeholder="TX"
            />
          </label>

          <label className="settings-field">
            <span>Turo vehicle ID</span>
            <input
              value={form.turo_vehicle_id}
              onChange={(e) => update("turo_vehicle_id", e.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>Turo name</span>
            <input
              value={form.turo_vehicle_name}
              onChange={(e) => update("turo_vehicle_name", e.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>Bouncie vehicle ID</span>
            <input
              value={form.bouncie_vehicle_id}
              onChange={(e) => update("bouncie_vehicle_id", e.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>DIMO token ID</span>
            <input
              type="number"
              value={form.dimo_token_id}
              onChange={(e) => update("dimo_token_id", e.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>IMEI</span>
            <input
              value={form.imei}
              onChange={(e) => update("imei", e.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>Oil type</span>
            <input
              value={form.oil_type}
              onChange={(e) => update("oil_type", e.target.value)}
              placeholder="0W-20"
            />
          </label>

          <label className="settings-field">
            <span>Oil quarts</span>
            <input
              type="number"
              step="0.1"
              value={form.oil_capacity_quarts}
              onChange={(e) => update("oil_capacity_quarts", e.target.value)}
            />
          </label>

          <label className="settings-field settings-field-wide">
            <span>RockAuto URL</span>
            <input
              value={form.rockauto_url}
              onChange={(e) => update("rockauto_url", e.target.value)}
              placeholder="https://www.rockauto.com/..."
            />
          </label>
        </div>

        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={Boolean(form.is_active)}
            onChange={(e) => update("is_active", e.target.checked)}
          />
          <span>Active vehicle</span>
        </label>

        <div className="settings-form-actions">
          <button
            type="submit"
            className="settings-action-btn"
            disabled={saving}
          >
            {saving ? "Adding..." : "Add Car"}
          </button>
          {message ? <span className="settings-message">{message}</span> : null}
        </div>
      </form>

      <div className="settings-vehicle-list">
        <div className="settings-group-title">
          Active fleet {loading ? "" : `(${vehicles.length})`}
        </div>
        {vehicles.map((vehicle) => (
          <div key={vehicle.id} className="settings-vehicle-row">
            <strong>{vehicle.nickname || vehicle.vin || `Vehicle ${vehicle.id}`}</strong>
            <span>
              {[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}
            </span>
          </div>
        ))}
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
      ) : activeSection === "fleet" ? (
        <FleetSettingsPanel />
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
