import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = "http://localhost:5000";

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
    { key: "database", title: "Database", sub: "Backup and restore" },
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

function DatabaseSettingsPanel() {
  const [backupStatus, setBackupStatus] = useState("");
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [restoreStatus, setRestoreStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function downloadBackup() {
    try {
      setBusy(true);
      setBackupStatus("Building backup...");

      const res = await fetch(`${API_BASE}/api/database/backup`);

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
            Download a JSON snapshot of every table in the public schema. Keep
            this somewhere private; it can contain guest, trip, expense, and
            vehicle data.
          </div>
          <div className="settings-form-actions">
            <button
              type="button"
              className="settings-action-btn"
              disabled={busy}
              onClick={downloadBackup}
            >
              {busy ? "Working..." : "Download Backup"}
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

function IntegrationsSettingsPanel() {
  const [config, setConfig] = useState(null);
  const [connections, setConnections] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");

  async function loadTellerState() {
    try {
      setLoading(true);
      setMessage("");

      const [configRes, connectionsRes] = await Promise.all([
        fetch(`${API_BASE}/api/teller/connect/config`),
        fetch(`${API_BASE}/api/teller/connections`),
      ]);

      const configJson = await configRes.json().catch(() => ({}));
      const connectionsJson = await connectionsRes.json().catch(() => ({}));

      if (!configRes.ok) {
        throw new Error(configJson?.error || "Failed to load Teller config");
      }

      if (!connectionsRes.ok) {
        throw new Error(
          connectionsJson?.error || "Failed to load Teller connections"
        );
      }

      setConfig(configJson);
      setConnections(connectionsJson);
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
        `Synced ${json.processed || 0} transactions across ${
          json.accounts || 0
        } account${Number(json.accounts || 0) === 1 ? "" : "s"}.`
      );
      await loadTellerState();
    } catch (err) {
      setMessage(err.message || "Failed to sync Teller");
    } finally {
      setSyncing(false);
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
          <span>Teller banking connections</span>
        </div>
      </div>

      <div className="settings-form">
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

    if (activeSection === "database") {
      return {
        title: "Database safety",
        body:
          "Backups are full JSON snapshots of the local public schema. Restore is intentionally destructive: it clears current tables and reloads the backup.",
      };
    }

    if (activeSection === "integrations") {
      return {
        title: "Teller setup",
        body:
          "Teller Connect creates an access token for each bank enrollment. The server stores each token and syncs transactions across every connected account.",
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
      ) : activeSection === "database" ? (
        <DatabaseSettingsPanel />
      ) : activeSection === "integrations" ? (
        <IntegrationsSettingsPanel />
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
