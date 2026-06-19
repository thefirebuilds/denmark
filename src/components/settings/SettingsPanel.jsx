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
  enabled: true,
  heartbeatStaleMinutes: 25,
  turoNotificationStaleHours: 12,
};
const DEFAULT_SMS_ALERT_SETTINGS = {
  enabled: true,
  accountSid: "",
  authToken: "",
  authTokenConfigured: false,
  senderNumber: "",
  receiverNumber: "",
  configured: false,
  source: "database",
};
const DEFAULT_MARKETPLACE_FILTERS = {
  minPrice: "",
  maxPrice: "",
  minMiles: "",
  maxMiles: "",
};
const DEFAULT_MARKETPLACE_IGNORE_KEYWORDS = "nissan leaf";
const DEFAULT_LOCATION_SETTINGS = {
  locations: [
    {
      id: "park-my-share",
      label: "Park My Share",
      latitude: "",
      longitude: "",
      radiusMiles: 0.15,
      kind: "parking",
      enabled: true,
      alertOnEntry: true,
    },
  ],
};
const DEFAULT_AUTH_PUBLIC_URL_SETTINGS = {
  publicBaseUrl: "",
  googleCallbackPath: "/api/auth/callback",
  googleRedirectUri: "",
  googleCalendarRedirectUri: "",
};
const GOOGLE_CALENDAR_CALLBACK_PATH = "/api/integrations/google-calendar/callback";

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
    enabled: settings?.enabled !== false,
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

function mergeSmsAlertSettings(settings) {
  return {
    ...DEFAULT_SMS_ALERT_SETTINGS,
    ...(settings || {}),
    enabled: settings?.enabled !== false,
    accountSid: String(settings?.accountSid || ""),
    authToken: String(settings?.authToken || ""),
    authTokenConfigured: Boolean(settings?.authTokenConfigured),
    senderNumber: String(settings?.senderNumber || ""),
    receiverNumber: String(settings?.receiverNumber || ""),
    configured: Boolean(settings?.configured),
    source: String(settings?.source || "database"),
  };
}

function slugifyLocationLabel(value, fallback = "location") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function coerceLocationCoordinate(value, maxAbs) {
  if (value == null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  if (Math.abs(number) <= maxAbs) return number;

  for (let scale = 10; scale <= 1e16; scale *= 10) {
    const scaled = number / scale;
    if (Math.abs(scaled) <= maxAbs) return scaled;
  }

  return number;
}

function normalizeLocation(location = {}, index = 0) {
  const label = String(location.label || location.name || `Location ${index + 1}`).trim();
  const latitude = coerceLocationCoordinate(location.latitude ?? location.lat ?? "", 90);
  const longitude = coerceLocationCoordinate(
    location.longitude ?? location.lon ?? location.lng ?? "",
    180
  );
  const radiusMiles = Number(location.radiusMiles ?? location.radius_miles);

  return {
    id: slugifyLocationLabel(location.id || label, `location-${index + 1}`),
    label,
    latitude: latitude == null ? "" : String(latitude),
    longitude: longitude == null ? "" : String(longitude),
    radiusMiles: Number.isFinite(radiusMiles) && radiusMiles > 0 ? radiusMiles : 0.15,
    kind: String(location.kind || (index === 0 ? "parking" : "custom")).trim(),
    enabled: location.enabled !== false,
    alertOnEntry: location.alertOnEntry ?? location.alert_on_entry ?? true,
  };
}

function mergeLocationSettings(settings) {
  const incoming = Array.isArray(settings?.locations)
    ? settings.locations
    : DEFAULT_LOCATION_SETTINGS.locations;
  const seen = new Set();
  const locations = incoming.map(normalizeLocation).map((location, index) => {
    let id = location.id;
    while (seen.has(id)) {
      id = `${location.id}-${index + 1}`;
    }
    seen.add(id);
    return { ...location, id };
  });

  return {
    locations: locations.length
      ? locations
      : DEFAULT_LOCATION_SETTINGS.locations.map(normalizeLocation),
  };
}

function toLocationPayload(settings) {
  return {
    locations: mergeLocationSettings(settings).locations.map((location) => ({
      ...location,
      latitude: location.latitude === "" ? null : Number(location.latitude),
      longitude: location.longitude === "" ? null : Number(location.longitude),
      radiusMiles: Number(location.radiusMiles) || 0.15,
    })),
  };
}

function normalizePublicBaseUrlForDisplay(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeCallbackPathForDisplay(value) {
  const raw = String(value || DEFAULT_AUTH_PUBLIC_URL_SETTINGS.googleCallbackPath).trim();
  if (!raw) return DEFAULT_AUTH_PUBLIC_URL_SETTINGS.googleCallbackPath;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function mergeAuthPublicUrlSettings(settings) {
  const publicBaseUrl = String(settings?.publicBaseUrl || "");
  const normalizedPublicBaseUrl = normalizePublicBaseUrlForDisplay(publicBaseUrl);
  const googleCallbackPath = normalizeCallbackPathForDisplay(
    settings?.googleCallbackPath
  );

  return {
    publicBaseUrl,
    googleCallbackPath,
    googleRedirectUri: normalizedPublicBaseUrl
      ? `${normalizedPublicBaseUrl}${googleCallbackPath}`
      : "",
    googleCalendarRedirectUri: normalizedPublicBaseUrl
      ? `${normalizedPublicBaseUrl}${GOOGLE_CALENDAR_CALLBACK_PATH}`
      : "",
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
    { key: "auth", title: "Authentication", sub: "Public URL and OAuth" },
    { key: "fleet", title: "Fleet", sub: "Add and identify cars" },
    { key: "locations", title: "Locations", sub: "Geofences and entry alerts" },
    { key: "expenses", title: "Expenses", sub: "Categories and imports" },
    { key: "marketplace", title: "Marketplace", sub: "Search defaults and screening" },
    { key: "website", title: "Website", sub: "Public availability export" },
    { key: "maintenance", title: "Maintenance", sub: "Alerts, backups, telemetry" },
    { key: "logs", title: "Logs", sub: "Server console tail" },
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
  const [smsForm, setSmsForm] = useState(DEFAULT_SMS_ALERT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingSms, setSavingSms] = useState(false);
  const [message, setMessage] = useState("");
  const dirtyRef = useRef(false);
  const saveSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        setLoading(true);
        const [bridgeRes, smsRes] = await Promise.all([
          fetch(`${API_BASE}/api/settings/alerts.bridge`),
          fetch(`${API_BASE}/api/settings/alerts.sms`),
        ]);
        const bridgeJson = await bridgeRes.json().catch(() => ({}));
        const smsJson = await smsRes.json().catch(() => ({}));

        if (!bridgeRes.ok) {
          throw new Error(bridgeJson?.error || "Failed to load alert settings");
        }
        if (!smsRes.ok) {
          throw new Error(smsJson?.error || "Failed to load SMS settings");
        }

        if (cancelled) return;
        dirtyRef.current = false;
        setForm(mergeBridgeAlertSettings(bridgeJson.value));
        setSmsForm(mergeSmsAlertSettings(smsJson.value));
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

  function updateEnabled(value) {
    dirtyRef.current = true;
    setForm((current) =>
      mergeBridgeAlertSettings({
        ...current,
        enabled: Boolean(value),
      })
    );
  }

  function updateSmsField(key, value) {
    setSmsForm((current) =>
      mergeSmsAlertSettings({
        ...current,
        [key]: value,
      })
    );
  }

  async function saveSmsSettings(event) {
    event.preventDefault();

    try {
      setSavingSms(true);
      setMessage("");

      const payload = {
        enabled: smsForm.enabled !== false,
        accountSid: smsForm.accountSid,
        authToken:
          smsForm.authToken && !smsForm.authToken.startsWith("********")
            ? smsForm.authToken
            : "",
        senderNumber: smsForm.senderNumber,
        receiverNumber: smsForm.receiverNumber,
      };

      const res = await fetch(`${API_BASE}/api/settings/alerts.sms`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: payload }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save SMS settings");
      }

      setSmsForm(mergeSmsAlertSettings(json.value || payload));
      setMessage("SMS alert settings saved");
    } catch (err) {
      setMessage(err.message || "Failed to save SMS settings");
    } finally {
      setSavingSms(false);
    }
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
        <form className="settings-group" onSubmit={saveSmsSettings}>
          <div className="settings-group-title">Text alerts</div>
          <label className="settings-checkbox-row">
            <input
              type="checkbox"
              checked={smsForm.enabled !== false}
              onChange={(event) => updateSmsField("enabled", event.target.checked)}
            />
            <span>Enable SMS text alerts for this tenant</span>
          </label>
          <small className="settings-field-note">
            This controls every Denmark text alert. Twilio values saved here take
            priority over legacy environment variables.
          </small>
          <div className="settings-vehicle-list">
            <div className="settings-vehicle-row">
              <strong>Twilio source</strong>
              <span>{smsForm.source === "environment" ? "Environment fallback" : "Tenant settings"}</span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Configuration</strong>
              <span>{smsForm.configured ? "Ready" : "Missing credentials"}</span>
            </div>
          </div>
          <div className="settings-form-grid">
            <label className="settings-field">
              <span>Account SID</span>
              <input
                type="text"
                value={smsForm.accountSid}
                onChange={(event) => updateSmsField("accountSid", event.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="settings-field">
              <span>Auth token / client secret</span>
              <input
                type="password"
                value={smsForm.authToken}
                placeholder={smsForm.authTokenConfigured ? "Saved; leave blank to keep" : ""}
                onChange={(event) => updateSmsField("authToken", event.target.value)}
                autoComplete="new-password"
              />
              <small className="settings-field-note">
                Leave blank to keep the saved secret.
              </small>
            </label>
            <label className="settings-field">
              <span>Sender number</span>
              <input
                type="text"
                value={smsForm.senderNumber}
                onChange={(event) => updateSmsField("senderNumber", event.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="settings-field">
              <span>Receiver number</span>
              <input
                type="text"
                value={smsForm.receiverNumber}
                onChange={(event) => updateSmsField("receiverNumber", event.target.value)}
                autoComplete="off"
              />
            </label>
          </div>
          <div className="settings-form-actions">
            <button
              type="submit"
              className="settings-action-btn"
              disabled={loading || savingSms}
            >
              {savingSms ? "Saving..." : "Save Text Alerts"}
            </button>
          </div>
        </form>

        <div className="settings-group">
          <div className="settings-group-title">Android bridge</div>
          <label className="settings-checkbox-row">
            <input
              type="checkbox"
              checked={form.enabled !== false}
              onChange={(event) => updateEnabled(event.target.checked)}
            />
            <span>Enable Android notification bridge</span>
          </label>
          <small className="settings-field-note">
            When off, Denmark ignores Android bridge posts and stops bridge freshness
            warnings.
          </small>
          <div className="settings-form-grid">
            <label className="settings-field">
              <span>Turo notification warning</span>
              <input
                type="number"
                min="1"
                max="168"
                step="1"
                disabled={form.enabled === false}
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
                disabled={form.enabled === false}
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

function AuthPublicUrlSettingsPanel() {
  const [form, setForm] = useState(DEFAULT_AUTH_PUBLIC_URL_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function loadSettings() {
    try {
      setLoading(true);
      setMessage("");
      const res = await fetch(`${API_BASE}/api/settings/auth/public-url`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load authentication settings");
      }

      setForm(mergeAuthPublicUrlSettings(json.value));
    } catch (err) {
      setMessage(err.message || "Failed to load authentication settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSettings();
  }, []);

  function updateField(key, value) {
    setForm((current) => ({
      ...mergeAuthPublicUrlSettings({
        ...current,
        [key]: value,
      }),
      [key]: value,
    }));
  }

  async function saveSettings(event) {
    event.preventDefault();

    try {
      setSaving(true);
      setMessage("Saving...");
      const payload = {
        ...mergeAuthPublicUrlSettings(form),
        publicBaseUrl: normalizePublicBaseUrlForDisplay(form.publicBaseUrl),
        googleCallbackPath: normalizeCallbackPathForDisplay(
          form.googleCallbackPath
        ),
      };
      const res = await fetch(`${API_BASE}/api/settings/auth/public-url`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: payload }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save authentication settings");
      }

      setForm(mergeAuthPublicUrlSettings(json.value || payload));
      setMessage("Saved");
    } catch (err) {
      setMessage(err.message || "Failed to save authentication settings");
    } finally {
      setSaving(false);
    }
  }

  async function copyRedirectUri() {
    if (!form.googleRedirectUri) return;

    try {
      await navigator.clipboard.writeText(form.googleRedirectUri);
      setMessage("Redirect URI copied");
    } catch {
      setMessage("Copy failed");
    }
  }

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Authentication</h2>
          <span>public URL and Google OAuth callback</span>
        </div>
        <div className="settings-autosave-state">
          {loading ? "Loading..." : saving ? "Saving..." : message || "Ready"}
        </div>
      </div>

      <form className="settings-form" onSubmit={saveSettings}>
        <div className="settings-group">
          <div className="settings-group-title">Public URL</div>
          <div className="settings-empty-state">
            This is the browser-facing URL for this Denmark deployment. It is
            public configuration, not a secret, and is used to build the Google
            OAuth redirect URI.
          </div>

          <div className="settings-form-grid">
            <label className="settings-field settings-field-wide">
              <span>Public app base URL</span>
              <input
                value={form.publicBaseUrl}
                onChange={(event) =>
                  updateField("publicBaseUrl", event.target.value)
                }
                placeholder="https://denmark.example.com"
                disabled={loading || saving}
              />
              <small className="settings-field-note">
                Store only the scheme and host. Denmark removes trailing slashes.
              </small>
            </label>

            <label className="settings-field settings-field-wide">
              <span>Google OAuth callback path</span>
              <input
                value={form.googleCallbackPath}
                onChange={(event) =>
                  updateField("googleCallbackPath", event.target.value)
                }
                placeholder="/api/auth/callback"
                disabled={loading || saving}
              />
            </label>

            <label className="settings-field settings-field-wide">
              <span>Computed Google OAuth redirect URI</span>
              <input
                value={
                  form.googleRedirectUri ||
                  "Set the public app base URL to compute the redirect URI"
                }
                readOnly
              />
              <small className="settings-field-note">
                Add this exact redirect URI to Google Cloud Console under
                Authorized redirect URIs.
              </small>
            </label>

            <label className="settings-field settings-field-wide">
              <span>Computed Google Calendar redirect URI</span>
              <input
                value={
                  form.googleCalendarRedirectUri ||
                  "Set the public app base URL to compute the calendar redirect URI"
                }
                readOnly
              />
              <small className="settings-field-note">
                Add this too if you use the Google Calendar integration with the
                same OAuth client.
              </small>
            </label>
          </div>

          <div className="settings-form-actions">
            <button
              type="submit"
              className="settings-action-btn"
              disabled={loading || saving}
            >
              {saving ? "Saving..." : "Save Authentication Settings"}
            </button>
            <button
              type="button"
              className="settings-action-btn secondary"
              disabled={!form.googleRedirectUri}
              onClick={copyRedirectUri}
            >
              Copy Redirect URI
            </button>
            {message && message !== "Saved" ? (
              <span className="settings-message">{message}</span>
            ) : null}
          </div>
        </div>
      </form>
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
  const [backupSummary, setBackupSummary] = useState(null);
  const [backupStatus, setBackupStatus] = useState("");
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [restoreStatus, setRestoreStatus] = useState("");
  const [cloudImportUrl, setCloudImportUrl] = useState("");
  const [cloudImportStatus, setCloudImportStatus] = useState("");
  const [cloudImportJobs, setCloudImportJobs] = useState([]);
  const [selectedRestoreJobId, setSelectedRestoreJobId] = useState("");
  const [busy, setBusy] = useState(false);
  const [cloudImportBusy, setCloudImportBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);

  async function loadBackupSummary() {
    try {
      const res = await fetch(`${API_BASE}/api/database/backup/summary`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || `Backup summary failed (${res.status})`);
      }

      setBackupSummary(json.summary || null);
    } catch (err) {
      setBackupStatus(err.message || "Failed to load backup summary");
    }
  }

  async function loadCloudImportJobs() {
    try {
      const res = await fetch(`${API_BASE}/api/database/imports`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || `Import jobs failed (${res.status})`);
      }

      setCloudImportJobs(Array.isArray(json.jobs) ? json.jobs : []);
    } catch (err) {
      setCloudImportStatus(err.message || "Failed to load cloud import jobs");
    }
  }

  useEffect(() => {
    loadCloudImportJobs();
    loadBackupSummary();
  }, []);

  useEffect(() => {
    const hasActiveJob = cloudImportJobs.some((job) =>
      ["queued", "downloading", "validating", "restoring"].includes(
        String(job.status || "").trim().toLowerCase()
      )
    );
    if (!hasActiveJob) return undefined;

    const timer = window.setInterval(() => {
      loadCloudImportJobs();
    }, 3000);

    return () => window.clearInterval(timer);
  }, [cloudImportJobs]);

  async function downloadBackup() {
    try {
      setBusy(true);
      await loadBackupSummary();
      setBackupStatus("Streaming tenant backup...");

      const res = await fetch(`${API_BASE}/api/database/backup`);

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || `Backup failed (${res.status})`);
      }

      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename =
        match?.[1] || `denmark-tenant-backup-${new Date().toISOString()}.dump`;
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

  async function startCloudImport() {
    const url = cloudImportUrl.trim();
    if (!url) {
      setCloudImportStatus("Paste a public Google Drive file link first.");
      return;
    }

    try {
      setCloudImportBusy(true);
      setCloudImportStatus("Queueing cloud import...");

      const res = await fetch(`${API_BASE}/api/database/imports/from-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || `Cloud import failed (${res.status})`);
      }

      setCloudImportStatus("Cloud import queued. Denmark will download it server-side.");
      setCloudImportUrl("");
      await loadCloudImportJobs();
    } catch (err) {
      setCloudImportStatus(err.message || "Cloud import failed");
    } finally {
      setCloudImportBusy(false);
    }
  }

  function formatImportJobTime(value) {
    if (!value) return "";
    return new Date(value).toLocaleString();
  }

  async function validateCloudImport(jobId) {
    try {
      setRestoreBusy(true);
      setRestoreStatus("Validating backup...");
      const res = await fetch(`${API_BASE}/api/database/imports/${jobId}/validate`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (json?.job) {
          setCloudImportJobs((jobs) =>
            jobs.map((job) =>
              String(job.id) === String(jobId) ? json.job : job
            )
          );
        }
        throw new Error(json?.error || `Validation failed (${res.status})`);
      }

      setRestoreStatus("Backup validated. It can be restored to this tenant.");
      await loadCloudImportJobs();
    } catch (err) {
      setRestoreStatus(err.message || "Validation failed");
      await loadCloudImportJobs();
    } finally {
      setRestoreBusy(false);
    }
  }

  async function removeCloudImport(jobId) {
    try {
      setCloudImportBusy(true);
      setCloudImportStatus("Removing staged backup...");
      const res = await fetch(`${API_BASE}/api/database/imports/${jobId}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || `Remove failed (${res.status})`);
      }

      setCloudImportJobs((jobs) =>
        jobs.filter((job) => String(job.id) !== String(jobId))
      );
      if (String(selectedRestoreJobId) === String(jobId)) {
        setSelectedRestoreJobId("");
      }
      setCloudImportStatus(
        json.removedFile
          ? "Removed staged backup and server file."
          : "Removed staged backup record."
      );
    } catch (err) {
      setCloudImportStatus(err.message || "Remove failed");
    } finally {
      setCloudImportBusy(false);
    }
  }

  function getJobStatus(job) {
    return String(job?.status || "").trim().toLowerCase();
  }

  function formatBackupSummary() {
    if (!backupSummary?.tables?.length) return "";
    const tableText = backupSummary.tables
      .filter((table) =>
        ["vehicles", "trips", "messages", "vehicle_telemetry_snapshots"].includes(
          table.table
        )
      )
      .map((table) => `${table.table}: ${table.exists ? table.rows : "missing"}`)
      .join(" | ");
    return `${tableText} | tracked total: ${backupSummary.totalRows}`;
  }

  const backupSummaryText = formatBackupSummary();

  async function startTenantRestore() {
    const selectedJob = cloudImportJobs.find(
      (job) => String(job.id) === String(selectedRestoreJobId)
    );
    if (!selectedJob) {
      setRestoreStatus("Choose a validated backup first.");
      return;
    }
    if (getJobStatus(selectedJob) !== "validated") {
      setRestoreStatus("Validate the staged backup before restoring.");
      return;
    }
    if (restoreConfirm !== "RESTORE") {
      setRestoreStatus("Type RESTORE to confirm.");
      return;
    }

    try {
      setRestoreBusy(true);
      setRestoreStatus("Starting restore job...");
      const res = await fetch(
        `${API_BASE}/api/database/imports/${selectedRestoreJobId}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: restoreConfirm }),
        }
      );
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || `Restore failed (${res.status})`);
      }

      setRestoreStatus("Restore started. Keep this page open and watch import status.");
      setCloudImportJobs((jobs) =>
        jobs.map((job) =>
          String(job.id) === String(selectedRestoreJobId)
            ? { ...job, status: "restoring" }
            : job
        )
      );
      setRestoreConfirm("");
      await loadCloudImportJobs();
      await loadBackupSummary();
    } catch (err) {
      setRestoreStatus(err.message || "Restore failed");
    } finally {
      setRestoreBusy(false);
    }
  }

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Database</h2>
          <span>tenant backup, standup, and disaster recovery</span>
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">Backup</div>
          <div className="settings-empty-state">
            Download a tenant database backup in the standard Postgres custom
            dump format. This contains tenant data, settings, messages, trips,
            vehicles, integrations, and history, but not the Denmark app code.
          </div>
          {backupSummaryText ? (
            <div className="settings-empty-state">
              Current database: {backupSummaryText}
            </div>
          ) : null}
          <div className="settings-form-actions">
            <button
              type="button"
              className="settings-action-btn"
              disabled={busy}
              onClick={downloadBackup}
            >
              {busy ? "Working..." : "Download Tenant Backup"}
            </button>
            <button
              type="button"
              className="settings-action-btn secondary"
              disabled={busy}
              onClick={loadBackupSummary}
            >
              Refresh Counts
            </button>
            {backupStatus ? (
              <span className="settings-message">{backupStatus}</span>
            ) : null}
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Cloud restore staging</div>
          <div className="settings-empty-state">
            Paste the public Google Drive share link. Denmark downloads the file
            on the server and stages it for validation and restore.
          </div>
          {backupSummaryText ? (
            <div className="settings-empty-state">
              Current database before restore: {backupSummaryText}
            </div>
          ) : null}

          <label className="settings-field">
            <span>Google Drive share link</span>
            <input
              value={cloudImportUrl}
              onChange={(e) => setCloudImportUrl(e.target.value)}
              placeholder="https://drive.google.com/file/d/.../view?usp=sharing"
            />
          </label>

          <div className="settings-form-actions">
            <button
              type="button"
              className="settings-action-btn"
              disabled={cloudImportBusy || !cloudImportUrl.trim()}
              onClick={startCloudImport}
            >
              {cloudImportBusy ? "Queueing..." : "Stage Cloud Backup"}
            </button>
            <button
              type="button"
              className="settings-action-btn secondary"
              disabled={cloudImportBusy}
              onClick={loadCloudImportJobs}
            >
              Refresh Imports
            </button>
            {cloudImportStatus ? (
              <span className="settings-message">{cloudImportStatus}</span>
            ) : null}
          </div>

          {cloudImportJobs.length ? (
            <div className="settings-list">
              {cloudImportJobs.slice(0, 5).map((job) => (
                <div className="settings-list-row" key={job.id}>
                  <div>
                    <strong>{job.remoteFileName || job.remoteFileId || `Import ${job.id}`}</strong>
                    <span>
                      {job.status}
                      {job.format ? ` - ${job.format}` : ""}
                      {job.bytesDownloadedLabel ? ` - ${job.bytesDownloadedLabel}` : ""}
                      {job.bytesTotalLabel ? ` of ${job.bytesTotalLabel}` : ""}
                    </span>
                    {job.localPath ? <span>{job.localPath}</span> : null}
                    {job.sha256 ? <span>sha256: {job.sha256}</span> : null}
                    {job.error ? <span>{job.error}</span> : null}
                    {job.restoreLog ? <span>{job.restoreLog}</span> : null}
                  </div>
                  <div className="settings-list-row-actions">
                    <span className="settings-status-badge">
                      {formatImportJobTime(job.updatedAt) || "Queued"}
                    </span>
                    {["downloaded", "validation_failed"].includes(
                      getJobStatus(job)
                    ) ? (
                      <button
                        type="button"
                        className="settings-action-btn secondary"
                        disabled={restoreBusy}
                        onClick={() => validateCloudImport(job.id)}
                      >
                        Validate
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="settings-import-remove"
                      aria-label={`Remove ${
                        job.remoteFileName || job.remoteFileId || `import ${job.id}`
                      }`}
                      title="Remove staged backup"
                      disabled={
                        cloudImportBusy ||
                        ["downloading", "validating", "restoring"].includes(
                          getJobStatus(job)
                        )
                      }
                      onClick={() => removeCloudImport(job.id)}
                    >
                      x
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Restore tenant</div>
          <div className="settings-empty-state">
            Restore replaces this tenant database with a staged backup. Use this
            for initial tenant standup or disaster recovery failover.
          </div>
          {backupSummaryText ? (
            <div className="settings-empty-state">
              Current database before restore: {backupSummaryText}
            </div>
          ) : null}

          <label className="settings-field">
            <span>Staged backup</span>
            <select
              value={selectedRestoreJobId}
              onChange={(e) => setSelectedRestoreJobId(e.target.value)}
            >
              <option value="">Select a validated backup</option>
              {cloudImportJobs
                .filter((job) => getJobStatus(job) === "validated")
                .map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.remoteFileName || job.remoteFileId || `Import ${job.id}`} -{" "}
                    {job.status}
                  </option>
                ))}
            </select>
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
              disabled={
                restoreBusy ||
                !selectedRestoreJobId ||
                restoreConfirm !== "RESTORE"
              }
              onClick={startTenantRestore}
            >
              {restoreBusy ? "Working..." : "Restore Tenant"}
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

function MarketplaceSettingsPanel() {
  const [overview, setOverview] = useState(null);
  const [filters, setFilters] = useState(DEFAULT_MARKETPLACE_FILTERS);
  const [ignoreText, setIgnoreText] = useState(DEFAULT_MARKETPLACE_IGNORE_KEYWORDS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function loadMarketplaceSettings() {
    try {
      setLoading(true);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/marketplace/preferences/overview`, {
        headers: { Accept: "application/json" },
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load marketplace settings");
      }

      setOverview(json);
      setFilters({
        minPrice: json?.filters?.minPrice ?? "",
        maxPrice: json?.filters?.maxPrice ?? "",
        minMiles: json?.filters?.minMiles ?? "",
        maxMiles: json?.filters?.maxMiles ?? "",
      });
      setIgnoreText(json?.ignoreKeywords?.text || DEFAULT_MARKETPLACE_IGNORE_KEYWORDS);
    } catch (err) {
      setMessage(err.message || "Failed to load marketplace settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMarketplaceSettings();
  }, []);

  function updateFilter(key, value) {
    setFilters((current) => ({
      ...current,
      [key]: String(value || "").replace(/[^\d]/g, ""),
    }));
  }

  async function saveMarketplaceSettings() {
    try {
      setSaving(true);
      setMessage("");

      const [ignoreRes, filtersRes] = await Promise.all([
        fetch(`${API_BASE}/api/marketplace/preferences/ignore-keywords`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ text: ignoreText }),
        }),
        fetch(`${API_BASE}/api/marketplace/preferences/filters`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(filters),
        }),
      ]);

      const [ignoreJson, filtersJson] = await Promise.all([
        ignoreRes.json().catch(() => ({})),
        filtersRes.json().catch(() => ({})),
      ]);

      if (!ignoreRes.ok) {
        throw new Error(ignoreJson?.error || "Failed to save ignored phrases");
      }

      if (!filtersRes.ok) {
        throw new Error(filtersJson?.error || "Failed to save marketplace filters");
      }

      setIgnoreText(ignoreJson?.text || DEFAULT_MARKETPLACE_IGNORE_KEYWORDS);
      setFilters({
        minPrice: filtersJson?.minPrice ?? "",
        maxPrice: filtersJson?.maxPrice ?? "",
        minMiles: filtersJson?.minMiles ?? "",
        maxMiles: filtersJson?.maxMiles ?? "",
      });
      setMessage("Saved marketplace settings.");
      await loadMarketplaceSettings();
    } catch (err) {
      setMessage(err.message || "Failed to save marketplace settings");
    } finally {
      setSaving(false);
    }
  }

  const counts = overview?.counts || {};
  const screeningRules = overview?.screeningRules || {};
  const invalidTerms = Array.isArray(overview?.invalidListingTerms)
    ? overview.invalidListingTerms
    : [];
  const vehicleCatalog = Array.isArray(overview?.vehicleCatalog)
    ? overview.vehicleCatalog
    : [];
  const knownCities = Array.isArray(overview?.homeLocation?.knownCities)
    ? overview.homeLocation.knownCities
    : [];

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Marketplace</h2>
          <span>search defaults and screening rules</span>
        </div>
        <div className="settings-form-actions">
          <button
            type="button"
            className="settings-action-btn"
            disabled={loading || saving}
            onClick={saveMarketplaceSettings}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            className="settings-action-btn secondary"
            disabled={loading || saving}
            onClick={loadMarketplaceSettings}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">Current defaults</div>
          <div className="settings-fleet-summary">
            <div>
              <strong>{loading && !overview ? "..." : counts.vehicleMakes ?? 0}</strong>
              <span>makes cataloged</span>
            </div>
            <div>
              <strong>{loading && !overview ? "..." : counts.ignoredPhrases ?? 0}</strong>
              <span>ignored phrases</span>
            </div>
            <div>
              <strong>{overview?.homeLocation?.label || "Buda, TX"}</strong>
              <span>home location</span>
            </div>
          </div>
          {message ? <span className="settings-message">{message}</span> : null}
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Default listing filters</div>
          <div className="settings-form-grid">
            <label className="settings-field">
              <span>Minimum price</span>
              <input
                value={filters.minPrice}
                inputMode="numeric"
                onChange={(event) => updateFilter("minPrice", event.target.value)}
                placeholder="No minimum"
              />
            </label>
            <label className="settings-field">
              <span>Maximum price</span>
              <input
                value={filters.maxPrice}
                inputMode="numeric"
                onChange={(event) => updateFilter("maxPrice", event.target.value)}
                placeholder="No maximum"
              />
            </label>
            <label className="settings-field">
              <span>Minimum miles</span>
              <input
                value={filters.minMiles}
                inputMode="numeric"
                onChange={(event) => updateFilter("minMiles", event.target.value)}
                placeholder="No minimum"
              />
            </label>
            <label className="settings-field">
              <span>Maximum miles</span>
              <input
                value={filters.maxMiles}
                inputMode="numeric"
                onChange={(event) => updateFilter("maxMiles", event.target.value)}
                placeholder="No maximum"
              />
            </label>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Ignored phrases</div>
          <textarea
            className="settings-textarea"
            value={ignoreText}
            onChange={(event) => setIgnoreText(event.target.value)}
            rows={8}
          />
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Baked screening rules</div>
          <div className="settings-vehicle-list">
            <div className="settings-vehicle-row">
              <strong>Useful price</strong>
              <span>
                {screeningRules.minUsefulPrice ?? "none"} -{" "}
                {screeningRules.maxUsefulPrice ?? "none"}
              </span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Comparable price</strong>
              <span>
                {screeningRules.minComparablePrice ?? "none"} -{" "}
                {screeningRules.maxComparablePrice ?? "none"}
              </span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Year and mileage</strong>
              <span>
                {screeningRules.minUsefulYear ?? "none"}+ / under{" "}
                {screeningRules.maxUsefulMiles ?? "none"} miles
              </span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Excluded fuel</strong>
              <span>{(screeningRules.excludedFuelTypes || []).join(", ") || "None"}</span>
            </div>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Home location distance map</div>
          <div className="settings-empty-state">
            The current marketplace distance scoring is still anchored to Buda,
            Texas. These are the known cities the estimator recognizes.
          </div>
          <div className="settings-chip-list">
            {knownCities.map((city) => (
              <span key={city} className="settings-chip">
                {city}
              </span>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Invalid listing phrases</div>
          <div className="settings-chip-list">
            {invalidTerms.map((term) => (
              <span key={term} className="settings-chip">
                {term}
              </span>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Available vehicle types</div>
          <div className="settings-vehicle-list">
            {vehicleCatalog.map((make) => (
              <div key={make.make} className="settings-vehicle-row">
                <strong>{make.make}</strong>
                <span>
                  {(make.models || [])
                    .map((model) => (typeof model === "string" ? model : model.name))
                    .filter(Boolean)
                    .join(", ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function GoogleCalendarCard({
  status,
  loading,
  syncing,
  cleanupPreview,
  previewingCleanup,
  runningCleanup,
  savingSyncEnabled,
  onConnect,
  onSync,
  onPreviewCleanup,
  onRunCleanup,
  onSyncEnabledChange,
}) {
  const syncEnabled = status?.syncEnabled !== false;
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

      <label className="settings-check-row">
        <input
          type="checkbox"
          checked={syncEnabled}
          disabled={loading || savingSyncEnabled}
          onChange={(event) => onSyncEnabledChange?.(event.target.checked)}
        />
        <span>
          {savingSyncEnabled
            ? "Saving calendar sync setting..."
            : "Enable trip and maintenance event syncing for this tenant"}
        </span>
      </label>

      <div className="settings-vehicle-list">
        <div className="settings-vehicle-row">
          <strong>Sync writes</strong>
          <span
            className={`settings-status-badge ${
              syncEnabled ? "is-ok" : "is-muted"
            }`}
          >
            {syncEnabled ? "Enabled" : "Disabled"}
          </span>
        </div>
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
          disabled={loading || syncing || !syncEnabled || !status?.connected}
          onClick={onSync}
        >
          {syncing ? "Syncing..." : syncEnabled ? "Sync Trips" : "Sync Disabled"}
        </button>
      </div>

      <div className="settings-calendar-cleanup">
        <div>
          <strong>Duplicate cleanup</strong>
          <span>
            Scans Denmark trip and maintenance events on the selected calendar,
            then removes duplicate copies while keeping the newest shared event.
          </span>
        </div>
        {cleanupPreview ? (
          <div className="settings-calendar-cleanup-summary">
            <span>
              Scanned <strong>{cleanupPreview.scannedEvents || 0}</strong>
            </span>
            <span>
              Groups{" "}
              <strong>
                {Array.isArray(cleanupPreview.duplicateGroups)
                  ? cleanupPreview.duplicateGroups.length
                  : cleanupPreview.duplicateGroups || 0}
              </strong>
            </span>
            <span>
              Removable{" "}
              <strong>
                {cleanupPreview.removableEvents ?? cleanupPreview.removedEvents ?? 0}
              </strong>
            </span>
          </div>
        ) : null}
        <div className="settings-form-actions">
          <button
            type="button"
            className="settings-action-btn secondary"
            disabled={
              loading ||
              previewingCleanup ||
              runningCleanup ||
              !status?.connected
            }
            onClick={onPreviewCleanup}
          >
            {previewingCleanup ? "Scanning..." : "Preview Cleanup"}
          </button>
          <button
            type="button"
            className="settings-action-btn settings-action-btn--danger"
            disabled={
              loading ||
              previewingCleanup ||
              runningCleanup ||
              !status?.connected ||
              !cleanupPreview ||
              Number(cleanupPreview.removableEvents || 0) <= 0
            }
            onClick={onRunCleanup}
          >
            {runningCleanup ? "Cleaning..." : "Delete Duplicates"}
          </button>
        </div>
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
  const [previewingGoogleCalendarCleanup, setPreviewingGoogleCalendarCleanup] =
    useState(false);
  const [runningGoogleCalendarCleanup, setRunningGoogleCalendarCleanup] =
    useState(false);
  const [googleCalendarCleanupPreview, setGoogleCalendarCleanupPreview] =
    useState(null);
  const [savingGoogleCalendarSyncEnabled, setSavingGoogleCalendarSyncEnabled] =
    useState(false);
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

  async function setGoogleCalendarSyncEnabled(syncEnabled) {
    try {
      setSavingGoogleCalendarSyncEnabled(true);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/settings/integrations.google_calendar`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syncEnabled }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save Google Calendar setting");
      }

      setGoogleCalendarStatus((current) => ({
        ...(current || {}),
        syncEnabled: json?.value?.syncEnabled !== false,
        settings: json?.value || { syncEnabled },
      }));
      setGoogleCalendarCleanupPreview(null);
      setMessage(
        syncEnabled
          ? "Google Calendar sync enabled for this tenant."
          : "Google Calendar sync disabled for this tenant."
      );
      await loadTellerState();
    } catch (err) {
      setMessage(err.message || "Failed to save Google Calendar setting");
    } finally {
      setSavingGoogleCalendarSyncEnabled(false);
    }
  }

  async function previewGoogleCalendarCleanup() {
    try {
      setPreviewingGoogleCalendarCleanup(true);
      setMessage("");

      const res = await fetch(
        `${API_BASE}/api/integrations/google-calendar/dedupe/preview`,
        { method: "POST" }
      );
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to preview calendar cleanup");
      }

      setGoogleCalendarCleanupPreview(json);
      setMessage(
        `Calendar cleanup found ${json.removableEvents || 0} duplicate event${
          Number(json.removableEvents || 0) === 1 ? "" : "s"
        } across ${
          Array.isArray(json.duplicateGroups)
            ? json.duplicateGroups.length
            : json.duplicateGroups || 0
        } group${
          (Array.isArray(json.duplicateGroups)
            ? json.duplicateGroups.length
            : json.duplicateGroups || 0) === 1
            ? ""
            : "s"
        }.`
      );
    } catch (err) {
      setMessage(err.message || "Failed to preview calendar cleanup");
    } finally {
      setPreviewingGoogleCalendarCleanup(false);
    }
  }

  async function runGoogleCalendarCleanup() {
    const removableEvents = Number(googleCalendarCleanupPreview?.removableEvents || 0);
    if (removableEvents <= 0) return;

    const confirmed = window.confirm(
      `Delete ${removableEvents} duplicate Denmark calendar event${
        removableEvents === 1 ? "" : "s"
      } from the selected Google Calendar?`
    );
    if (!confirmed) return;

    try {
      setRunningGoogleCalendarCleanup(true);
      setMessage("");

      const res = await fetch(
        `${API_BASE}/api/integrations/google-calendar/dedupe/run`,
        { method: "POST" }
      );
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to clean calendar duplicates");
      }

      setGoogleCalendarCleanupPreview({
        ...json,
        removableEvents: 0,
        duplicateGroups: json.duplicateGroups || 0,
      });
      setMessage(
        `Calendar cleanup removed ${json.removedEvents || 0} duplicate event${
          Number(json.removedEvents || 0) === 1 ? "" : "s"
        }${json.failedEvents ? ` with ${json.failedEvents} failure(s)` : ""}.`
      );
      await loadTellerState();
    } catch (err) {
      setMessage(err.message || "Failed to clean calendar duplicates");
    } finally {
      setRunningGoogleCalendarCleanup(false);
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
          cleanupPreview={googleCalendarCleanupPreview}
          previewingCleanup={previewingGoogleCalendarCleanup}
          runningCleanup={runningGoogleCalendarCleanup}
          savingSyncEnabled={savingGoogleCalendarSyncEnabled}
          onConnect={connectGoogleCalendar}
          onSync={syncGoogleCalendar}
          onPreviewCleanup={previewGoogleCalendarCleanup}
          onRunCleanup={runGoogleCalendarCleanup}
          onSyncEnabledChange={setGoogleCalendarSyncEnabled}
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

function LocationsSettingsPanel() {
  const [form, setForm] = useState(DEFAULT_LOCATION_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function loadLocations() {
    try {
      setLoading(true);
      setMessage("");
      const res = await fetch(`${API_BASE}/api/settings/locations.tracking`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load locations");
      }

      setForm(mergeLocationSettings(json.value));
    } catch (err) {
      setMessage(err.message || "Failed to load locations");
    } finally {
      setLoading(false);
    }
  }

  async function saveLocations(nextForm = form) {
    try {
      setSaving(true);
      setMessage("");
      const payload = toLocationPayload(nextForm);
      const res = await fetch(`${API_BASE}/api/settings/locations.tracking`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: payload }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save locations");
      }

      setForm(mergeLocationSettings(json.value || payload));
      setMessage("Saved");
    } catch (err) {
      setMessage(err.message || "Failed to save locations");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    loadLocations();
  }, []);

  function updateLocation(index, patch) {
    setForm((current) => {
      const locations = current.locations.map((location, locationIndex) =>
        locationIndex === index
          ? normalizeLocation({ ...location, ...patch }, locationIndex)
          : location
      );
      return { locations };
    });
  }

  function addLocation() {
    setForm((current) => ({
      locations: [
        ...current.locations,
        normalizeLocation(
          {
            id: `new-location-${current.locations.length + 1}`,
            label: `New location ${current.locations.length + 1}`,
            radiusMiles: 0.15,
            enabled: true,
            alertOnEntry: true,
            kind: "custom",
          },
          current.locations.length
        ),
      ],
    }));
  }

  function removeLocation(index) {
    setForm((current) => ({
      locations: current.locations.filter((_, locationIndex) => locationIndex !== index),
    }));
  }

  const configuredCount = form.locations.filter(
    (location) => location.enabled && location.latitude && location.longitude
  ).length;

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Locations</h2>
          <span>named geographic circles</span>
        </div>
        <div className="settings-form-actions">
          <button
            type="button"
            className="settings-action-btn secondary"
            disabled={loading || saving}
            onClick={loadLocations}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            className="settings-action-btn"
            disabled={loading || saving}
            onClick={() => saveLocations()}
          >
            {saving ? "Saving..." : "Save Locations"}
          </button>
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">Tracking circles</div>
          <div className="settings-empty-state">
            Add places like Park My Share, home, lots, shops, or airports. When a
            vehicle crosses into an enabled circle with entry alerts on, Denmark
            can send the location-entry alert.
          </div>

          <div className="settings-fleet-summary">
            <div>
              <strong>{form.locations.length}</strong>
              <span>saved circles</span>
            </div>
            <div>
              <strong>{configuredCount}</strong>
              <span>active geofences</span>
            </div>
            <div>
              <strong>Entry</strong>
              <span>alert mode</span>
            </div>
          </div>

          {message ? <span className="settings-message">{message}</span> : null}
        </div>

        <div className="settings-vehicle-config-list">
          {form.locations.map((location, index) => (
            <div key={location.id || index} className="settings-vehicle-config-card">
              <div className="settings-vehicle-config-head">
                <div>
                  <strong>{location.label || `Location ${index + 1}`}</strong>
                  <span>
                    {location.latitude && location.longitude
                      ? `${location.latitude}, ${location.longitude}`
                      : "Coordinates needed"}
                  </span>
                </div>
                <div className="settings-vehicle-config-badges">
                  <span
                    className={`settings-status-badge ${
                      location.enabled ? "is-good" : "is-muted"
                    }`}
                  >
                    {location.enabled ? "Enabled" : "Paused"}
                  </span>
                  <span className="settings-status-badge">
                    {location.radiusMiles} mi
                  </span>
                </div>
              </div>

              <div className="settings-vehicle-config-body">
                <div className="settings-form-grid">
                  <label className="settings-field">
                    <span>Friendly name</span>
                    <input
                      value={location.label}
                      onChange={(event) =>
                        updateLocation(index, {
                          label: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Kind</span>
                    <select
                      value={location.kind}
                      onChange={(event) =>
                        updateLocation(index, { kind: event.target.value })
                      }
                    >
                      <option value="parking">Parking</option>
                      <option value="home">Home</option>
                      <option value="shop">Shop</option>
                      <option value="airport">Airport</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>Latitude</span>
                    <input
                      type="number"
                      step="0.000001"
                      value={location.latitude}
                      onChange={(event) =>
                        updateLocation(index, { latitude: event.target.value })
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Longitude</span>
                    <input
                      type="number"
                      step="0.000001"
                      value={location.longitude}
                      onChange={(event) =>
                        updateLocation(index, { longitude: event.target.value })
                      }
                    />
                  </label>
                  <label className="settings-field">
                    <span>Radius miles</span>
                    <input
                      type="number"
                      min="0.01"
                      max="25"
                      step="0.01"
                      value={location.radiusMiles}
                      onChange={(event) =>
                        updateLocation(index, { radiusMiles: event.target.value })
                      }
                    />
                  </label>
                  <div className="settings-field">
                    <span>Behavior</span>
                    <label className="settings-check-row">
                      <input
                        type="checkbox"
                        checked={Boolean(location.enabled)}
                        onChange={(event) =>
                          updateLocation(index, { enabled: event.target.checked })
                        }
                      />
                      <span>Track this location</span>
                    </label>
                    <label className="settings-check-row">
                      <input
                        type="checkbox"
                        checked={Boolean(location.alertOnEntry)}
                        onChange={(event) =>
                          updateLocation(index, { alertOnEntry: event.target.checked })
                        }
                      />
                      <span>Alert when a vehicle enters</span>
                    </label>
                  </div>
                </div>

                <div className="settings-form-actions">
                  <button
                    type="button"
                    className="settings-action-btn secondary"
                    onClick={() => saveLocations()}
                    disabled={loading || saving}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="settings-action-btn settings-action-btn--danger"
                    onClick={() => removeLocation(index)}
                    disabled={form.locations.length <= 1 || saving}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="settings-action-btn"
          onClick={addLocation}
          disabled={loading || saving}
        >
          Add Location
        </button>
      </div>
    </section>
  );
}

function PublicExportSettingsPanel() {
  const [exportInfo, setExportInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [message, setMessage] = useState("");

  async function loadExportInfo(options = {}) {
    try {
      setLoading(true);
      if (!options.keepMessage) {
        setMessage("");
      }

      const res = await fetch(`${API_BASE}/api/settings/public-availability-export`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load website export info");
      }

      setExportInfo(json);
    } catch (err) {
      setMessage(err.message || "Failed to load website export info");
    } finally {
      setLoading(false);
    }
  }

  async function pushExportNow() {
    try {
      setPushing(true);
      setMessage("");

      const res = await fetch(
        `${API_BASE}/api/settings/public-availability-export/push`,
        {
          method: "POST",
        }
      );
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        const details = json?.details;
        const detailText = details?.status
          ? ` (${details.status}${
              details.bodyPreview ? `: ${details.bodyPreview}` : ""
            })`
          : "";
        throw new Error(
          `${json?.error || "Failed to push website export"}${detailText}`
        );
      }

      setMessage(
        `Pushed availability snapshot at ${new Date(
          json.pushedAt || Date.now()
        ).toLocaleString()}.`
      );
      await loadExportInfo({ keepMessage: true });
    } catch (err) {
      setMessage(err.message || "Failed to push website export");
    } finally {
      setPushing(false);
    }
  }

  useEffect(() => {
    loadExportInfo();
  }, []);

  const pushEnabled = Boolean(exportInfo?.push?.enabled);
  const pullEndpoint = exportInfo?.pull?.endpoint || "/api/public/availability";
  const cadence = Array.isArray(exportInfo?.cadence) ? exportInfo.cadence : [];
  const vehicleShape = exportInfo?.vehicleShape || {};

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Website</h2>
          <span>public availability export</span>
        </div>
        <div className="settings-form-actions">
          <button
            type="button"
            className="settings-action-btn"
            disabled={loading || pushing || !pushEnabled}
            onClick={pushExportNow}
          >
            {pushing ? "Pushing..." : "Push Now"}
          </button>
          <button
            type="button"
            className="settings-action-btn secondary"
            disabled={loading || pushing}
            onClick={loadExportInfo}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">How the website gets data</div>
          <div className="settings-empty-state">
            Denmark builds the availability JSON from the local database. A
            website can pull the live endpoint, and Denmark can also push the
            same snapshot to an external ingest URL when availability changes.
          </div>

          <div className="settings-fleet-summary">
            <div>
              <strong>{loading && !exportInfo ? "..." : exportInfo?.vehicleCount ?? 0}</strong>
              <span>vehicles exported</span>
            </div>
            <div>
              <strong>{pushEnabled ? "On" : "Off"}</strong>
              <span>push ingest</span>
            </div>
            <div>
              <strong>Live</strong>
              <span>pull endpoint</span>
            </div>
          </div>

          {message ? <span className="settings-message">{message}</span> : null}

          <div className="settings-vehicle-list">
            <div className="settings-vehicle-row">
              <strong>Pull URL</strong>
              <span>{pullEndpoint}</span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Pull shape</strong>
              <span>ok, updatedAt, vehicles[]</span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Push URL</strong>
              <span>{exportInfo?.push?.ingestUrl || "Not configured"}</span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Push auth</strong>
              <span>
                {pushEnabled
                  ? "Bearer token plus HMAC signature"
                  : "Missing one or more PUBLIC_AVAILABILITY_* env vars"}
              </span>
            </div>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">How often it updates</div>
          <div className="settings-vehicle-list">
            {cadence.length ? (
              cadence.map((item) => (
                <div
                  key={`${item.mode}-${item.trigger}`}
                  className="settings-vehicle-row"
                >
                  <strong>{item.trigger}</strong>
                  <span>{item.mode}: {item.note}</span>
                </div>
              ))
            ) : (
              <div className="settings-empty-state">
                No cadence details loaded yet.
              </div>
            )}
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Vehicle shape</div>
          <pre className="settings-json-view">
            {Object.keys(vehicleShape).length
              ? JSON.stringify(vehicleShape, null, 2)
              : loading
                ? "Loading export shape..."
                : "No export shape loaded."}
          </pre>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Live sample</div>
          <pre className="settings-json-view">
            {exportInfo?.sampleVehicle
              ? JSON.stringify(exportInfo.sampleVehicle, null, 2)
              : loading
                ? "Loading sample vehicle..."
                : "No sample vehicle available."}
          </pre>
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

function MaintenanceSettingsPanel() {
  return (
    <div className="settings-maintenance-stack">
      <AlertSettingsPanel />
      <DatabaseSettingsPanel />
      <TelemetrySettingsPanel />
    </div>
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

    if (activeSection === "auth") {
      return {
        title: "OAuth redirect",
        body:
          "Google requires the redirect URI to match exactly. Set the public app URL once, copy the computed URI, and paste it into Google Cloud Console.",
      };
    }

    if (activeSection === "website") {
      return {
        title: "Website export",
        body:
          "The public site is fed by JSON from Denmark, not by direct database access. The pull endpoint is live JSON; the push path posts signed snapshots when availability-relevant records change.",
      };
    }

    if (activeSection === "locations") {
      return {
        title: "Location tracking",
        body:
          "Named circles turn raw GPS points into useful places. The first parking location is used anywhere Denmark needs the fleet parking spot, and entry alerts can watch every enabled circle.",
      };
    }

    if (activeSection === "marketplace") {
      return {
        title: "Marketplace defaults",
        body:
          "This section collects marketplace defaults that affect listing intake and review. Some values are still code-defined so they are visible here before being migrated into editable preferences.",
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

    if (activeSection === "maintenance") {
      return {
        title: "Maintenance ops",
        body:
          "Operational maintenance settings now collect bridge alert timing, database backup and restore, and DIMO telemetry debug output in one place.",
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
      ) : activeSection === "fleet" ? (
        <FleetSettingsPanel />
      ) : activeSection === "auth" ? (
        <AuthPublicUrlSettingsPanel />
      ) : activeSection === "locations" ? (
        <LocationsSettingsPanel />
      ) : activeSection === "expenses" ? (
        <ExpenseSettingsPanel />
      ) : activeSection === "marketplace" ? (
        <MarketplaceSettingsPanel />
      ) : activeSection === "website" ? (
        <PublicExportSettingsPanel />
      ) : activeSection === "integrations" ? (
        <IntegrationsSettingsPanel />
      ) : activeSection === "maintenance" ? (
        <MaintenanceSettingsPanel />
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


