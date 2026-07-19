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
const DEFAULT_VOLTAGE_ALERT_SETTINGS = {
  enabled: true,
  boardEnabled: true,
  smsEnabled: true,
  lowVoltageThreshold: 11.9,
};
const DEFAULT_INTEGRATION_ENABLEMENT = {
  imap: true,
  bouncie: true,
  dimo: true,
  plaid: true,
  tolls: true,
  googleCalendar: true,
  fmv: true,
  businessMetrics: true,
  publicAvailability: true,
};
const DEFAULT_IMAP_SETTINGS = {
  enabled: true,
  host: "",
  port: 993,
  secure: true,
  user: "",
  pass: "",
  passConfigured: false,
  targetMailboxes: "INBOX",
  lookbackHours: 72,
  ingestLimit: 100,
  connectionTimeout: 90000,
  greetingTimeout: 30000,
  socketTimeout: 600000,
  configured: false,
  source: "database",
};
const DEFAULT_TOLL_SETTINGS = {
  enabled: true,
  provider: "hctra_eztag",
  providerLabel: "HCTRA EZ TAG",
  sourceKey: "hctra_eztag",
  loginUrl: "https://www.hctra.org/Login",
  activityUrl: "https://www.hctra.org/AccountActivity",
  activityApiPattern: "/api/sessions/AccountActivity/SearchAccountActivity",
  username: "",
  password: "",
  passwordConfigured: false,
  lookbackDays: 30,
  configured: false,
  source: "database",
  providerOptions: [
    {
      value: "hctra_eztag",
      label: "HCTRA EZ TAG",
      activityUrl: "https://www.hctra.org/AccountActivity",
    },
  ],
  technicalConfig: {
    sourceKey: "hctra_eztag",
    activityApiPattern: "/api/sessions/AccountActivity/SearchAccountActivity",
    fingerprintFields:
      "trxnAt,licensePlate,amount,agencyName,facilityName,plazaName,laneName,direction,transType",
    fingerprintSaltConfigured: false,
    timeoutMs: 45000,
  },
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

const EMPTY_AI_PROMPT_FORM = {
  dailyBrief: {
    version: "",
    systemPrompt: "",
    instructionsText: "",
  },
  vehiclePurchaseReview: {
    version: "",
    systemPrompt: "",
  },
  weeklyFleetValuation: {
    version: "",
    prompt: "",
  },
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
  lockbox_pin_public: true,
  registration_month: "",
  registration_year: "",
  battery_installed_at: "",
  onboarding_date: "",
  first_trip_start: "",
  effective_onboarding_date: "",
  onboarding_date_source: "",
  acquisition_cost: "",
  retired_at: "",
  in_service: true,
  is_active: true,
};

function loadBankingConnectScript() {
  if (window.BankingConnect) return Promise.resolve(window.BankingConnect);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-banking-connect]");

    if (existing) {
      existing.addEventListener("load", () => resolve(window.BankingConnect));
      existing.addEventListener("error", reject);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.banking.io/connect/connect.js";
    script.dataset.bankingConnect = "true";
    script.onload = () => resolve(window.BankingConnect);
    script.onerror = () => reject(new Error("Failed to load Banking Connect"));
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

function mergeVoltageAlertSettings(settings) {
  const threshold = Number(
    settings?.lowVoltageThreshold ?? settings?.low_voltage_threshold
  );
  return {
    ...DEFAULT_VOLTAGE_ALERT_SETTINGS,
    ...(settings || {}),
    enabled: settings?.enabled !== false,
    boardEnabled: settings?.boardEnabled ?? settings?.board_enabled ?? true,
    smsEnabled: settings?.smsEnabled ?? settings?.sms_enabled ?? true,
    lowVoltageThreshold: Number.isFinite(threshold)
      ? Math.max(10, Math.min(13.5, threshold))
      : DEFAULT_VOLTAGE_ALERT_SETTINGS.lowVoltageThreshold,
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

function mergeTollSettings(settings) {
  return {
    ...DEFAULT_TOLL_SETTINGS,
    ...(settings || {}),
    enabled: settings?.enabled !== false,
    provider: String(settings?.provider || DEFAULT_TOLL_SETTINGS.provider),
    providerLabel: String(
      settings?.providerLabel || DEFAULT_TOLL_SETTINGS.providerLabel
    ),
    sourceKey: String(settings?.sourceKey || DEFAULT_TOLL_SETTINGS.sourceKey),
    loginUrl: String(settings?.loginUrl || DEFAULT_TOLL_SETTINGS.loginUrl),
    activityUrl: String(settings?.activityUrl || DEFAULT_TOLL_SETTINGS.activityUrl),
    activityApiPattern: String(
      settings?.activityApiPattern || DEFAULT_TOLL_SETTINGS.activityApiPattern
    ),
    username: String(settings?.username || ""),
    password: "",
    passwordConfigured: Boolean(settings?.passwordConfigured),
    lookbackDays: Number(settings?.lookbackDays || DEFAULT_TOLL_SETTINGS.lookbackDays),
    configured: Boolean(settings?.configured),
    source: String(settings?.source || "database"),
    providerOptions: Array.isArray(settings?.providerOptions)
      ? settings.providerOptions
      : DEFAULT_TOLL_SETTINGS.providerOptions,
    technicalConfig: {
      ...DEFAULT_TOLL_SETTINGS.technicalConfig,
      ...(settings?.technicalConfig || {}),
    },
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
    lockbox_pin_public: vehicleFields.lockbox_pin_public !== false,
  };
}

function loadPlaidLinkScript() {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-plaid-link]");
    if (existing) {
      existing.addEventListener("load", () => resolve(window.Plaid));
      existing.addEventListener("error", reject);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.dataset.plaidLink = "true";
    script.onload = () => resolve(window.Plaid);
    script.onerror = () => reject(new Error("Failed to load Plaid Link"));
    document.body.appendChild(script);
  });
}

function formatIntegrationDate(value, includeTime = false) {
  if (!value) return null;
  const text = String(value);
  const parsed = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text
  );
  if (Number.isNaN(parsed.getTime())) return text;
  return includeTime ? parsed.toLocaleString() : parsed.toLocaleDateString();
}

function getBankingRepairTarget(connections) {
  const liveAccounts = (connections?.sync_status?.accountDiagnostics || [])
    .map((item) => item?.account)
    .filter((account) => account?.enrollment_id);
  const storedAccounts = (connections?.accounts || [])
    .map((item) => item?.account)
    .filter((account) => account?.enrollment_id);
  const accounts = liveAccounts.length ? liveAccounts : storedAccounts;
  const citiAccount = accounts.find((account) => {
    const institution = String(account?.institution?.name || "").toLowerCase();
    return institution.includes("citi") || String(account?.last_four) === "4483";
  });
  return citiAccount || accounts[0] || null;
}

function SectionList({ activeSection, onChange }) {
  const sections = [
    { key: "setup", title: "Setup Checklist", sub: "Tenant readiness" },
    { key: "users", title: "Users & Access", sub: "Invites and roles" },
    { key: "fleet", title: "Fleet", sub: "Add and identify cars" },
    { key: "dispatch", title: "Trips & Dispatch", sub: "Open trip ordering" },
    { key: "messages", title: "Messages & Inbox", sub: "IMAP intake" },
    { key: "maintenance", title: "Maintenance", sub: "Queue and telemetry" },
    { key: "locations", title: "Locations", sub: "Geofences and entry alerts" },
    { key: "alerts", title: "Alerts", sub: "Bridge and SMS" },
    { key: "integrations", title: "Integrations", sub: "External systems" },
    { key: "ai", title: "AI Prompts", sub: "Briefs and reviews" },
    { key: "backup", title: "Backup & Restore", sub: "Tenant data safety" },
    { key: "auth", title: "Authentication", sub: "Public URL and OAuth" },
    { key: "expenses", title: "Expenses", sub: "Categories and imports" },
    { key: "marketplace", title: "Marketplace", sub: "Search defaults and screening" },
    { key: "website", title: "Website", sub: "Public availability export" },
    { key: "logs", title: "Advanced / Logs", sub: "Server console tail" },
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

function SetupChecklistPanel({ onNavigate }) {
  const [checklist, setChecklist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  async function loadChecklist() {
    try {
      setLoading(true);
      setMessage("");
      const res = await fetch(`${API_BASE}/api/settings/setup/checklist`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load setup checklist");
      }

      setChecklist(json);
    } catch (err) {
      setMessage(err.message || "Failed to load setup checklist");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadChecklist();
  }, []);

  const items = Array.isArray(checklist?.items) ? checklist.items : [];
  const needsAttention = items.filter((item) => item.status === "needs_attention");

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Setup Checklist</h2>
          <span>tenant readiness before beta use</span>
        </div>
        <button type="button" className="settings-action-btn secondary" onClick={loadChecklist}>
          Refresh
        </button>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">Readiness</div>
          <div className="settings-fleet-summary">
            <div>
              <strong>{loading ? "..." : checklist?.summary?.ready || 0}</strong>
              <span>ready</span>
            </div>
            <div>
              <strong>{loading ? "..." : checklist?.summary?.needsAttention || 0}</strong>
              <span>needs attention</span>
            </div>
            <div>
              <strong>{loading ? "..." : checklist?.summary?.skipped || 0}</strong>
              <span>skipped</span>
            </div>
            <div>
              <strong>{loading ? "..." : checklist?.summary?.optional || 0}</strong>
              <span>optional</span>
            </div>
          </div>
          {message ? <span className="settings-message">{message}</span> : null}
          {!loading && !needsAttention.length ? (
            <div className="settings-empty-state">
              No required setup gaps are currently blocking this tenant.
            </div>
          ) : null}
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Checklist items</div>
          <div className="settings-list">
            {items.map((item) => (
              <div className="settings-list-row" key={item.key}>
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
                <div className="settings-list-row-actions">
                  <span className="settings-status-badge">{item.status}</span>
                  {item.section ? (
                    <button
                      type="button"
                      className="settings-action-btn secondary"
                      onClick={() => onNavigate(item.section)}
                    >
                      Open
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {!loading && !items.length ? (
              <div className="settings-empty-state">No checklist data available.</div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function UsersAccessPanel() {
  const [users, setUsers] = useState([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("operator");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function loadUsers() {
    try {
      setLoading(true);
      setMessage("");
      const res = await fetch(`${API_BASE}/api/auth/users`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load users");
      }

      setUsers(Array.isArray(json.users) ? json.users : []);
    } catch (err) {
      setMessage(err.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function invite() {
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setMessage("Enter an email address first.");
      return;
    }

    try {
      setSaving(true);
      setMessage("");
      const res = await fetch(`${API_BASE}/api/auth/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cleanEmail, role }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to invite user");
      }

      setEmail("");
      setMessage(`Invited ${json.user?.email || cleanEmail}.`);
      await loadUsers();
    } catch (err) {
      setMessage(err.message || "Failed to invite user");
    } finally {
      setSaving(false);
    }
  }

  async function updateUser(userId, patch) {
    try {
      setSaving(true);
      setMessage("");
      const res = await fetch(`${API_BASE}/api/auth/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to update user");
      }

      setUsers((current) =>
        current.map((user) => (String(user.id) === String(userId) ? json.user : user))
      );
    } catch (err) {
      setMessage(err.message || "Failed to update user");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Users & Access</h2>
          <span>invite users and assign tenant roles</span>
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">Invite user</div>
          <div className="settings-empty-state">
            Invited users claim access by signing in with the same email address.
          </div>
          <div className="settings-form-grid">
            <label className="settings-field">
              <span>Email</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="settings-field">
              <span>Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="owner">Owner</option>
                <option value="operator">Operator</option>
                <option value="viewer">Viewer</option>
                <option value="family">Family</option>
              </select>
            </label>
          </div>
          <div className="settings-form-actions">
            <button type="button" className="settings-action-btn" disabled={saving} onClick={invite}>
              {saving ? "Saving..." : "Invite User"}
            </button>
            <button type="button" className="settings-action-btn secondary" onClick={loadUsers}>
              Refresh
            </button>
            {message ? <span className="settings-message">{message}</span> : null}
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">Current users</div>
          <div className="settings-list">
            {users.map((user) => (
              <div className="settings-list-row" key={user.id}>
                <div>
                  <strong>{user.email}</strong>
                  <span>
                    {user.display_name || (user.invited ? "Invited user" : "Signed-in user")}
                  </span>
                </div>
                <div className="settings-list-row-actions">
                  <select
                    value={user.role || "viewer"}
                    disabled={saving}
                    onChange={(e) => updateUser(user.id, { role: e.target.value })}
                  >
                    <option value="owner">Owner</option>
                    <option value="operator">Operator</option>
                    <option value="viewer">Viewer</option>
                    <option value="family">Family</option>
                  </select>
                  <button
                    type="button"
                    className="settings-action-btn secondary"
                    disabled={saving}
                    onClick={() => updateUser(user.id, { is_active: !user.is_active })}
                  >
                    {user.is_active ? "Disable" : "Enable"}
                  </button>
                </div>
              </div>
            ))}
            {!loading && !users.length ? (
              <div className="settings-empty-state">No users found.</div>
            ) : null}
          </div>
        </div>
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

function MessagesSettingsPanel() {
  const [form, setForm] = useState(DEFAULT_IMAP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");

  function updateField(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function loadImapSettings() {
    try {
      setLoading(true);
      setMessage("");
      const res = await fetch(`${API_BASE}/api/settings/integrations.imap`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load IMAP settings");
      }

      setForm({
        ...DEFAULT_IMAP_SETTINGS,
        ...(json.value || {}),
        pass: "",
      });
    } catch (err) {
      setMessage(err.message || "Failed to load IMAP settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadImapSettings();
  }, []);

  function payload() {
    return {
      enabled: form.enabled !== false,
      host: form.host,
      port: Number(form.port || 993),
      secure: form.secure !== false,
      user: form.user,
      pass: form.pass || "__KEEP__",
      targetMailboxes: form.targetMailboxes,
      lookbackHours: Number(form.lookbackHours || 72),
      ingestLimit: Number(form.ingestLimit || 100),
      connectionTimeout: Number(form.connectionTimeout || 90000),
      greetingTimeout: Number(form.greetingTimeout || 30000),
      socketTimeout: Number(form.socketTimeout || 600000),
    };
  }

  async function saveImapSettings() {
    try {
      setSaving(true);
      setMessage("");
      const res = await fetch(`${API_BASE}/api/settings/integrations.imap`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save IMAP settings");
      }

      setForm({
        ...DEFAULT_IMAP_SETTINGS,
        ...(json.value || {}),
        pass: "",
      });
      setMessage("IMAP settings saved.");
    } catch (err) {
      setMessage(err.message || "Failed to save IMAP settings");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    try {
      setTesting(true);
      setMessage("");
      const res = await fetch(`${API_BASE}/api/settings/integrations.imap/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok || json.ok === false) {
        throw new Error(json?.error || "IMAP test failed");
      }

      setMessage(
        `IMAP connected. Checked ${(json.checkedMailboxes || []).join(", ") || "INBOX"}.`
      );
    } catch (err) {
      setMessage(err.message || "IMAP test failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Messages & Inbox</h2>
          <span>Turo email intake and message setup</span>
        </div>
      </div>

      <div className="settings-form">
        <div className="settings-group">
          <div className="settings-group-title">IMAP intake</div>
          <div className="settings-empty-state">
            Configure the mailbox Denmark scans for Turo messages. Leave disabled
            for tenants that will not use email intake.
          </div>

          <label className="settings-check-row">
            <input
              type="checkbox"
              checked={form.enabled !== false}
              onChange={(e) => updateField("enabled", e.target.checked)}
            />
            <span>Enable IMAP message intake</span>
          </label>

          <div className="settings-form-grid">
            <label className="settings-field">
              <span>Host</span>
              <input
                value={form.host || ""}
                onChange={(e) => updateField("host", e.target.value)}
                placeholder="imap.example.com"
              />
            </label>
            <label className="settings-field">
              <span>Port</span>
              <input
                type="number"
                value={form.port || 993}
                onChange={(e) => updateField("port", e.target.value)}
              />
            </label>
            <label className="settings-field">
              <span>User</span>
              <input
                value={form.user || ""}
                onChange={(e) => updateField("user", e.target.value)}
                placeholder="turo@example.com"
              />
            </label>
            <label className="settings-field">
              <span>Password</span>
              <input
                type="password"
                value={form.pass || ""}
                onChange={(e) => updateField("pass", e.target.value)}
                placeholder={form.passConfigured ? "Saved; leave blank to keep" : "App password"}
              />
            </label>
            <label className="settings-field">
              <span>Mailboxes</span>
              <input
                value={form.targetMailboxes || "INBOX"}
                onChange={(e) => updateField("targetMailboxes", e.target.value)}
              />
            </label>
            <label className="settings-field">
              <span>Lookback hours</span>
              <input
                type="number"
                value={form.lookbackHours || 72}
                onChange={(e) => updateField("lookbackHours", e.target.value)}
              />
            </label>
            <label className="settings-field">
              <span>Ingest limit</span>
              <input
                type="number"
                value={form.ingestLimit || 100}
                onChange={(e) => updateField("ingestLimit", e.target.value)}
              />
            </label>
            <div className="settings-field">
              <span>Source</span>
              <strong>{loading ? "Loading..." : form.source || "database"}</strong>
            </div>
          </div>

          <label className="settings-check-row">
            <input
              type="checkbox"
              checked={form.secure !== false}
              onChange={(e) => updateField("secure", e.target.checked)}
            />
            <span>Use TLS</span>
          </label>

          <div className="settings-form-actions">
            <button
              type="button"
              className="settings-action-btn"
              disabled={saving || loading}
              onClick={saveImapSettings}
            >
              {saving ? "Saving..." : "Save IMAP"}
            </button>
            <button
              type="button"
              className="settings-action-btn secondary"
              disabled={testing || loading}
              onClick={testConnection}
            >
              {testing ? "Testing..." : "Test Connection"}
            </button>
            {message ? <span className="settings-message">{message}</span> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function AlertSettingsPanel() {
  const [form, setForm] = useState(DEFAULT_BRIDGE_ALERT_SETTINGS);
  const [smsForm, setSmsForm] = useState(DEFAULT_SMS_ALERT_SETTINGS);
  const [voltageForm, setVoltageForm] = useState(DEFAULT_VOLTAGE_ALERT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingSms, setSavingSms] = useState(false);
  const [sendingSmsTest, setSendingSmsTest] = useState(false);
  const [message, setMessage] = useState("");
  const dirtyRef = useRef(false);
  const voltageDirtyRef = useRef(false);
  const saveSeqRef = useRef(0);
  const voltageSaveSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        setLoading(true);
        const [bridgeRes, smsRes, voltageRes] = await Promise.all([
          fetch(`${API_BASE}/api/settings/alerts.bridge`),
          fetch(`${API_BASE}/api/settings/alerts.sms`),
          fetch(`${API_BASE}/api/settings/alerts.voltage`),
        ]);
        const bridgeJson = await bridgeRes.json().catch(() => ({}));
        const smsJson = await smsRes.json().catch(() => ({}));
        const voltageJson = await voltageRes.json().catch(() => ({}));

        if (!bridgeRes.ok) {
          throw new Error(bridgeJson?.error || "Failed to load alert settings");
        }
        if (!smsRes.ok) {
          throw new Error(smsJson?.error || "Failed to load SMS settings");
        }
        if (!voltageRes.ok) {
          throw new Error(voltageJson?.error || "Failed to load voltage settings");
        }

        if (cancelled) return;
        dirtyRef.current = false;
        voltageDirtyRef.current = false;
        setForm(mergeBridgeAlertSettings(bridgeJson.value));
        setSmsForm(mergeSmsAlertSettings(smsJson.value));
        setVoltageForm(mergeVoltageAlertSettings(voltageJson.value));
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

  useEffect(() => {
    if (!voltageDirtyRef.current) return undefined;

    const payload = mergeVoltageAlertSettings(voltageForm);
    const saveSeq = voltageSaveSeqRef.current + 1;
    voltageSaveSeqRef.current = saveSeq;

    setSaving(true);
    setMessage("Saving...");

    const timeoutId = window.setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/settings/alerts.voltage`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: payload }),
        });
        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(json?.error || "Failed to save voltage alert settings");
        }

        if (saveSeq !== voltageSaveSeqRef.current) return;

        voltageDirtyRef.current = false;
        setVoltageForm(mergeVoltageAlertSettings(json.value || payload));
        setMessage("Saved");
      } catch (err) {
        if (saveSeq === voltageSaveSeqRef.current) {
          setMessage(err.message || "Failed to save voltage alert settings");
        }
      } finally {
        if (saveSeq === voltageSaveSeqRef.current) {
          setSaving(false);
        }
      }
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [voltageForm]);

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

  function updateVoltageField(key, value) {
    voltageDirtyRef.current = true;
    setVoltageForm((current) =>
      mergeVoltageAlertSettings({
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

  async function sendSmsTest() {
    try {
      setSendingSmsTest(true);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/settings/alerts.sms/test`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok || json.ok === false) {
        throw new Error(json?.error || json?.reason || "Failed to send test SMS");
      }

      setMessage(
        `Test text sent${json.sid ? ` (${json.sid})` : ""}.`
      );
    } catch (err) {
      setMessage(err.message || "Failed to send test SMS");
    } finally {
      setSendingSmsTest(false);
    }
  }

  const smsFormLooksConfigured = Boolean(
    smsForm.accountSid &&
      (smsForm.authToken || smsForm.authTokenConfigured) &&
      smsForm.senderNumber &&
      smsForm.receiverNumber
  );

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
              disabled={loading || savingSms || sendingSmsTest}
            >
              {savingSms ? "Saving..." : "Save Text Alerts"}
            </button>
            <button
              type="button"
              className="settings-action-btn secondary"
              disabled={
                loading ||
                savingSms ||
                sendingSmsTest ||
                smsForm.enabled === false ||
                !smsFormLooksConfigured
              }
              onClick={sendSmsTest}
            >
              {sendingSmsTest ? "Sending..." : "Send Test"}
            </button>
          </div>
          <small className="settings-field-note">
            Send Test uses the currently saved settings. Save first after making
            credential changes.
          </small>
        </form>

        <div className="settings-group">
          <div className="settings-group-title">Battery voltage</div>
          <label className="settings-checkbox-row">
            <input
              type="checkbox"
              checked={voltageForm.enabled !== false}
              onChange={(event) =>
                updateVoltageField("enabled", event.target.checked)
              }
            />
            <span>Enable low-voltage alerts</span>
          </label>
          <small className="settings-field-note">
            Denmark watches the latest valid telematics voltage for each active
            vehicle. Values below the threshold create urgent board signals and
            can send SMS texts.
          </small>
          <div className="settings-form-grid">
            <label className="settings-field">
              <span>Low-voltage threshold</span>
              <input
                type="number"
                min="10"
                max="13.5"
                step="0.1"
                disabled={voltageForm.enabled === false}
                value={voltageForm.lowVoltageThreshold}
                onChange={(event) =>
                  updateVoltageField("lowVoltageThreshold", event.target.value)
                }
              />
              <small className="settings-field-note">
                Default is 11.90v. Readings below this create an urgent signal.
              </small>
            </label>
            <label className="settings-checkbox-row settings-checkbox-row--field">
              <input
                type="checkbox"
                checked={voltageForm.boardEnabled !== false}
                disabled={voltageForm.enabled === false}
                onChange={(event) =>
                  updateVoltageField("boardEnabled", event.target.checked)
                }
              />
              <span>Show on dispatch board</span>
            </label>
            <label className="settings-checkbox-row settings-checkbox-row--field">
              <input
                type="checkbox"
                checked={voltageForm.smsEnabled !== false}
                disabled={voltageForm.enabled === false}
                onChange={(event) =>
                  updateVoltageField("smsEnabled", event.target.checked)
                }
              />
              <span>Send SMS text</span>
            </label>
          </div>
        </div>

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
    battery_installed_at: toDateInputValue(vehicle.battery_installed_at),
    onboarding_date: toDateInputValue(vehicle.onboarding_date),
    first_trip_start: toDateInputValue(vehicle.first_trip_start),
    effective_onboarding_date: toDateInputValue(
      vehicle.effective_onboarding_date
    ),
    onboarding_date_source: vehicle.onboarding_date_source || "",
    retired_at: toDateInputValue(vehicle.retired_at),
    lockbox_pin_public: vehicle.lockbox_pin_public !== false,
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

      <div className="settings-field">
        <span>Guest printout</span>
        <label className="settings-check-row">
          <input
            type="checkbox"
            checked={form.lockbox_pin_public !== false}
            onChange={(e) => update("lockbox_pin_public", e.target.checked)}
          />
          <span>Publish lockbox PIN</span>
        </label>
      </div>

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

function instructionsToText(instructions) {
  if (Array.isArray(instructions)) {
    return instructions.map((line) => String(line || "").trim()).filter(Boolean).join("\n");
  }

  return String(instructions || "").trim();
}

function textToInstructions(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function promptSettingsToForm(settings) {
  const value = settings && typeof settings === "object" ? settings : {};

  return {
    dailyBrief: {
      version: String(value.dailyBrief?.version || ""),
      systemPrompt: String(value.dailyBrief?.systemPrompt || ""),
      instructionsText: instructionsToText(value.dailyBrief?.instructions),
    },
    vehiclePurchaseReview: {
      version: String(value.vehiclePurchaseReview?.version || ""),
      systemPrompt: String(value.vehiclePurchaseReview?.systemPrompt || ""),
    },
    weeklyFleetValuation: {
      version: String(value.weeklyFleetValuation?.version || ""),
      prompt: String(value.weeklyFleetValuation?.prompt || ""),
    },
  };
}

function promptFormToSettings(form) {
  return {
    dailyBrief: {
      version: form.dailyBrief.version.trim(),
      systemPrompt: form.dailyBrief.systemPrompt.trim(),
      instructions: textToInstructions(form.dailyBrief.instructionsText),
    },
    vehiclePurchaseReview: {
      version: form.vehiclePurchaseReview.version.trim(),
      systemPrompt: form.vehiclePurchaseReview.systemPrompt.trim(),
    },
    weeklyFleetValuation: {
      version: form.weeklyFleetValuation.version.trim(),
      prompt: form.weeklyFleetValuation.prompt.trim(),
    },
  };
}

function AiPromptSettingsPanel() {
  const [form, setForm] = useState(EMPTY_AI_PROMPT_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function loadPrompts() {
    try {
      setLoading(true);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/settings/ai.prompts`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load AI prompts");
      }

      setForm(promptSettingsToForm(json.value));
    } catch (err) {
      setMessage(err.message || "Failed to load AI prompts");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPrompts();
  }, []);

  function updatePrompt(section, field, value) {
    setForm((current) => ({
      ...current,
      [section]: {
        ...current[section],
        [field]: value,
      },
    }));
  }

  async function savePrompts(event) {
    event.preventDefault();

    try {
      setSaving(true);
      setMessage("Saving...");

      const res = await fetch(`${API_BASE}/api/settings/ai.prompts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: promptFormToSettings(form) }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save AI prompts");
      }

      setForm(promptSettingsToForm(json.value));
      setMessage("Saved");
    } catch (err) {
      setMessage(err.message || "Failed to save AI prompts");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>AI Prompts</h2>
          <span>daily brief, purchase review, and fleet valuation</span>
        </div>
      </div>

      <form className="settings-form" onSubmit={savePrompts}>
        {loading ? (
          <div className="settings-empty-state">Loading AI prompts...</div>
        ) : (
          <>
            <div className="settings-group">
              <div className="settings-group-title">Daily briefing</div>
              <div className="settings-form-grid">
                <label className="settings-field">
                  <span>Version</span>
                  <input
                    value={form.dailyBrief.version}
                    onChange={(event) =>
                      updatePrompt("dailyBrief", "version", event.target.value)
                    }
                  />
                </label>
                <label className="settings-field settings-field-wide">
                  <span>System prompt</span>
                  <textarea
                    className="settings-textarea"
                    rows={4}
                    value={form.dailyBrief.systemPrompt}
                    onChange={(event) =>
                      updatePrompt("dailyBrief", "systemPrompt", event.target.value)
                    }
                  />
                </label>
                <label className="settings-field settings-field-wide">
                  <span>Brief instructions</span>
                  <textarea
                    className="settings-textarea"
                    rows={14}
                    value={form.dailyBrief.instructionsText}
                    onChange={(event) =>
                      updatePrompt("dailyBrief", "instructionsText", event.target.value)
                    }
                  />
                </label>
              </div>
            </div>

            <div className="settings-group">
              <div className="settings-group-title">Vehicle purchase review</div>
              <div className="settings-form-grid">
                <label className="settings-field">
                  <span>Version</span>
                  <input
                    value={form.vehiclePurchaseReview.version}
                    onChange={(event) =>
                      updatePrompt(
                        "vehiclePurchaseReview",
                        "version",
                        event.target.value
                      )
                    }
                  />
                </label>
                <label className="settings-field settings-field-wide">
                  <span>System prompt</span>
                  <textarea
                    className="settings-textarea"
                    rows={10}
                    value={form.vehiclePurchaseReview.systemPrompt}
                    onChange={(event) =>
                      updatePrompt(
                        "vehiclePurchaseReview",
                        "systemPrompt",
                        event.target.value
                      )
                    }
                  />
                </label>
              </div>
            </div>

            <div className="settings-group">
              <div className="settings-group-title">Weekly fleet valuation</div>
              <div className="settings-form-grid">
                <label className="settings-field">
                  <span>Version</span>
                  <input
                    value={form.weeklyFleetValuation.version}
                    onChange={(event) =>
                      updatePrompt("weeklyFleetValuation", "version", event.target.value)
                    }
                  />
                </label>
                <label className="settings-field settings-field-wide">
                  <span>Prompt</span>
                  <textarea
                    className="settings-textarea"
                    rows={8}
                    value={form.weeklyFleetValuation.prompt}
                    onChange={(event) =>
                      updatePrompt("weeklyFleetValuation", "prompt", event.target.value)
                    }
                  />
                </label>
              </div>
            </div>
          </>
        )}

        <div className="settings-form-actions">
          <button type="submit" className="settings-action-btn" disabled={saving || loading}>
            {saving ? "Saving..." : "Save prompts"}
          </button>
          <button
            type="button"
            className="settings-action-btn secondary"
            disabled={saving || loading}
            onClick={loadPrompts}
          >
            Reload
          </button>
          {message ? <span className="settings-message">{message}</span> : null}
        </div>
      </form>
    </section>
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
  runningMaintenanceCleanup,
  savingSyncEnabled,
  onConnect,
  onSync,
  onPreviewCleanup,
  onRunCleanup,
  onCleanupMaintenanceEvents,
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
            : "Enable trip event syncing for this tenant"}
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
            Scans Denmark trip events on the selected calendar, then removes
            duplicate copies while keeping the newest shared event.
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
            {cleanupPreview.safety?.ignoredPrefixOnlyEvents ? (
              <span>
                Ignored prefix-only{" "}
                <strong>{cleanupPreview.safety.ignoredPrefixOnlyEvents}</strong>
              </span>
            ) : null}
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

      <div className="settings-calendar-cleanup">
        <div>
          <strong>Maintenance calendar cleanup</strong>
          <span>
            Removes Denmark-created maintenance reminders from the selected
            calendar. Maintenance planning stays in the message queue.
          </span>
        </div>
        <div className="settings-form-actions">
          <button
            type="button"
            className="settings-action-btn settings-action-btn--danger"
            disabled={loading || runningMaintenanceCleanup || !status?.connected}
            onClick={onCleanupMaintenanceEvents}
          >
            {runningMaintenanceCleanup
              ? "Removing..."
              : "Remove Maintenance Events"}
          </button>
        </div>
      </div>
    </div>
  );
}

const INTEGRATION_SWITCH_LABELS = [
  ["imap", "IMAP message intake", "Polls the configured mailbox for Turo messages."],
  ["googleCalendar", "Google Calendar sync", "Creates and updates trip calendar events."],
  ["dimo", "DIMO telemetry", "Polls shared DIMO vehicles for location, odometer, and diagnostics."],
  ["bouncie", "Bouncie telemetry", "Polls Bouncie devices where configured."],
  ["plaid", "Plaid banking", "Imports bank and card activity with production cost guards."],
  ["tolls", "Toll import", "Runs toll import jobs."],
  ["fmv", "FMV estimates", "Refreshes market value estimates when stale."],
  ["businessMetrics", "Business metrics snapshots", "Creates periodic business metric snapshots."],
  ["publicAvailability", "Public availability push", "Pushes availability snapshots to a public site."],
];

function IntegrationSwitchesCard({ switches, onChange, saving }) {
  const value = {
    ...DEFAULT_INTEGRATION_ENABLEMENT,
    ...(switches || {}),
  };

  return (
    <div className="settings-group">
      <div className="settings-group-title">Tenant automation switches</div>
      <div className="settings-empty-state">
        Disable optional integrations on test tenants or for customers who do not use
        that provider. Disabled jobs are skipped by the scheduler.
      </div>
      <div className="settings-vehicle-list">
        {INTEGRATION_SWITCH_LABELS.map(([key, label, description]) => (
          <div className="settings-vehicle-row" key={key}>
            <div>
              <strong>{label}</strong>
              <span>{description}</span>
            </div>
            <label className="settings-check-row">
              <input
                type="checkbox"
                checked={value[key] !== false}
                disabled={saving}
                onChange={(e) => onChange(key, e.target.checked)}
              />
              <span>{value[key] !== false ? "Enabled" : "Disabled"}</span>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

function TollSettingsCard({
  settings,
  loading,
  saving,
  testing,
  statusMessage,
  onChange,
  onSave,
  onTest,
}) {
  const form = mergeTollSettings(settings);
  const providerOptions = Array.isArray(form.providerOptions)
    ? form.providerOptions
    : DEFAULT_TOLL_SETTINGS.providerOptions;
  const selectedProvider =
    providerOptions.find((option) => option.value === form.provider) ||
    providerOptions[0] ||
    null;
  const technicalConfig = form.technicalConfig || {};

  return (
    <div className="settings-group">
      <div className="settings-group-title">Toll provider</div>
      <div className="settings-empty-state">
        Choose the toll authority for this tenant and save the account login.
        Provider-specific browser and fingerprint settings are managed by app
        administrators.
      </div>

      <label className="settings-check-row">
        <input
          type="checkbox"
          checked={form.enabled !== false}
          disabled={loading || saving}
          onChange={(e) => onChange("enabled", e.target.checked)}
        />
        <span>Enable toll provider import</span>
      </label>

      <div className="settings-form-grid">
        <label className="settings-field">
          <span>Provider</span>
          <select
            value={form.provider}
            disabled={loading || saving}
            onChange={(e) => onChange("provider", e.target.value)}
          >
            {providerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          <span>Lookback days</span>
          <input
            type="number"
            min="1"
            max="365"
            value={form.lookbackDays}
            disabled={loading || saving}
            onChange={(e) => onChange("lookbackDays", e.target.value)}
          />
        </label>
        <label className="settings-field settings-field-wide">
          <span>Provider website</span>
          <input
            value={selectedProvider?.activityUrl || form.activityUrl || ""}
            readOnly
            disabled
          />
        </label>
        <label className="settings-field">
          <span>Username</span>
          <input
            value={form.username}
            disabled={loading || saving}
            onChange={(e) => onChange("username", e.target.value)}
            placeholder="Toll account username"
          />
        </label>
        <label className="settings-field">
          <span>Password</span>
          <input
            type="password"
            value={form.password || ""}
            disabled={loading || saving}
            onChange={(e) => onChange("password", e.target.value)}
            placeholder={
              form.passwordConfigured ? "Saved; leave blank to keep" : "Password"
            }
          />
        </label>
        <div className="settings-field">
          <span>Source</span>
          <strong>{loading ? "Loading..." : form.source || "database"}</strong>
        </div>
      </div>

      <div className="settings-vehicle-list">
        <div className="settings-vehicle-row">
          <strong>Provider config</strong>
          <span>
            {loading
              ? "Loading..."
              : form.configured
                ? "Ready"
                : "Needs URL, API match, username, and password"}
          </span>
        </div>
      </div>

      <details className="settings-vehicle-config-card">
        <summary className="settings-vehicle-config-head">
          <div>
            <strong>Provider details</strong>
            <span>Read-only import settings</span>
          </div>
        </summary>
        <div className="settings-vehicle-list">
          <div className="settings-vehicle-row">
            <strong>Source key</strong>
            <span>{technicalConfig.sourceKey || form.sourceKey}</span>
          </div>
          <div className="settings-vehicle-row">
            <strong>Activity API match</strong>
            <span>{technicalConfig.activityApiPattern || form.activityApiPattern}</span>
          </div>
          <div className="settings-vehicle-row">
            <strong>Fingerprint</strong>
            <span>{technicalConfig.fingerprintFields || "Default provider fields"}</span>
          </div>
          <div className="settings-vehicle-row">
            <strong>Fingerprint salt</strong>
            <span>
              {technicalConfig.fingerprintSaltConfigured ? "Configured" : "Not used"}
            </span>
          </div>
          <div className="settings-vehicle-row">
            <strong>Timeout</strong>
            <span>{technicalConfig.timeoutMs || 45000} ms</span>
          </div>
        </div>
      </details>

      <div className="settings-form-actions">
        <button
          type="button"
          className="settings-action-btn"
          disabled={loading || saving}
          onClick={onSave}
        >
          {saving ? "Saving..." : "Save Toll Provider"}
        </button>
        <button
          type="button"
          className="settings-action-btn secondary"
          disabled={loading || testing}
          onClick={onTest}
        >
          {testing ? "Testing..." : "Test Provider"}
        </button>
        {statusMessage ? (
          <span className="settings-message">{statusMessage}</span>
        ) : null}
      </div>
    </div>
  );
}

function IntegrationsSettingsPanel() {
  const [config, setConfig] = useState(null);
  const [bankingForm, setBankingForm] = useState({
    clientId: "",
    environment: "production",
    secret: "",
  });
  const [connections, setConnections] = useState(null);
  const [mercuryConfig, setMercuryConfig] = useState(null);
  const [dimoConfig, setDimoConfig] = useState(null);
  const [dimoStatus, setDimoStatus] = useState([]);
  const [googleCalendarStatus, setGoogleCalendarStatus] = useState(null);
  const [tollSettings, setTollSettings] = useState(DEFAULT_TOLL_SETTINGS);
  const [integrationSwitches, setIntegrationSwitches] = useState(
    DEFAULT_INTEGRATION_ENABLEMENT
  );
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingBankingConfig, setSavingBankingConfig] = useState(false);
  const [syncingMercury, setSyncingMercury] = useState(false);
  const [syncingGoogleCalendar, setSyncingGoogleCalendar] = useState(false);
  const [previewingGoogleCalendarCleanup, setPreviewingGoogleCalendarCleanup] =
    useState(false);
  const [runningGoogleCalendarCleanup, setRunningGoogleCalendarCleanup] =
    useState(false);
  const [
    runningGoogleCalendarMaintenanceCleanup,
    setRunningGoogleCalendarMaintenanceCleanup,
  ] = useState(false);
  const [googleCalendarCleanupPreview, setGoogleCalendarCleanupPreview] =
    useState(null);
  const [savingGoogleCalendarSyncEnabled, setSavingGoogleCalendarSyncEnabled] =
    useState(false);
  const [savingIntegrationSwitches, setSavingIntegrationSwitches] = useState(false);
  const [savingTollSettings, setSavingTollSettings] = useState(false);
  const [testingTollSettings, setTestingTollSettings] = useState(false);
  const [tollMessage, setTollMessage] = useState("");
  const [message, setMessage] = useState("");

  async function loadBankingState() {
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
        tollSettingsRes,
        integrationSwitchesRes,
      ] = await Promise.all([
        fetch(`${API_BASE}/api/plaid/config`),
        fetch(`${API_BASE}/api/plaid/summary`),
        fetch(`${API_BASE}/api/banking/mercury/config`),
        fetch(`${API_BASE}/api/dimo/config`),
        fetch(`${API_BASE}/api/dimo/status`),
        fetch(`${API_BASE}/api/integrations/google-calendar/status`),
        fetch(`${API_BASE}/api/settings/integrations.tolls`),
        fetch(`${API_BASE}/api/settings/integrations.enabled`),
      ]);

      const configJson = await configRes.json().catch(() => ({}));
      const connectionsJson = await connectionsRes.json().catch(() => ({}));
      const mercuryConfigJson = await mercuryConfigRes.json().catch(() => ({}));
      const dimoConfigJson = await dimoConfigRes.json().catch(() => ({}));
      const dimoStatusJson = await dimoStatusRes.json().catch(() => []);
      const googleCalendarStatusJson = await googleCalendarStatusRes
        .json()
        .catch(() => ({}));
      const tollSettingsJson = await tollSettingsRes.json().catch(() => ({}));
      const integrationSwitchesJson = await integrationSwitchesRes
        .json()
        .catch(() => ({}));

      if (!configRes.ok) {
        throw new Error(configJson?.error || "Failed to load Plaid config");
      }

      if (!connectionsRes.ok) {
        throw new Error(
          connectionsJson?.error || "Failed to load Plaid connections"
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

      if (!tollSettingsRes.ok) {
        throw new Error(tollSettingsJson?.error || "Failed to load toll settings");
      }

      if (!integrationSwitchesRes.ok) {
        throw new Error(
          integrationSwitchesJson?.error || "Failed to load integration switches"
        );
      }

      setConfig(configJson);
      setBankingForm((current) => ({
        ...current,
        clientId: configJson.clientId || "",
        environment: "production",
        secret: "",
      }));
      setConnections(connectionsJson);
      setMercuryConfig(mercuryConfigJson);
      setDimoConfig(dimoConfigJson);
      setDimoStatus(Array.isArray(dimoStatusJson) ? dimoStatusJson : []);
      setGoogleCalendarStatus(googleCalendarStatusJson);
      setTollSettings(mergeTollSettings(tollSettingsJson.value || {}));
      setIntegrationSwitches({
        ...DEFAULT_INTEGRATION_ENABLEMENT,
        ...(integrationSwitchesJson.value || {}),
      });
    } catch (err) {
      setMessage(err.message || "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBankingState();
  }, []);

  async function saveBankingEnrollment(enrollment, options = {}) {
    const accessToken = enrollment?.accessToken;

    if (!accessToken) {
      throw new Error("Banking did not return an access token");
    }

    const res = await fetch(`${API_BASE}/api/banking/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: accessToken,
        replace_existing: options.replaceExisting === true,
      }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(json?.error || "Failed to save Banking connection");
    }

    return json;
  }

  async function savePlaidConfig(event) {
    event?.preventDefault();
    try {
      setSavingBankingConfig(true); setMessage("");
      const res = await fetch(`${API_BASE}/api/plaid/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bankingForm) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to save Plaid settings");
      setConfig(json); setBankingForm((current) => ({ ...current, clientId: json.clientId || current.clientId, environment: json.environment, secret: "" }));
      setMessage("Plaid settings saved.");
    } catch (err) { setMessage(err.message || "Failed to save Plaid settings"); }
    finally { setSavingBankingConfig(false); }
  }

  async function connectPlaid(itemId = null) {
    try {
      setConnecting(true); setMessage("");
      const Plaid = await loadPlaidLinkScript();
      const tokenRes = await fetch(`${API_BASE}/api/plaid/link-token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(itemId ? { itemId } : {}) });
      const tokenJson = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok) throw new Error(tokenJson?.error || "Failed to create Plaid Link token");
      const handler = Plaid.create({ token: tokenJson.link_token,
        onSuccess: async (publicToken, metadata) => {
          try { if (itemId) { setMessage("Plaid connection repaired."); await loadBankingState(); return; }
            const res = await fetch(`${API_BASE}/api/plaid/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicToken, metadata }) });
            const json = await res.json().catch(() => ({})); if (!res.ok) throw new Error(json?.error || "Failed to save Plaid Item");
            setMessage("Plaid connection saved. Running initial transaction import…"); await syncPlaid();
          } catch (err) { setMessage(err.message || "Failed to save Plaid connection"); } finally { setConnecting(false); }
        }, onExit: () => setConnecting(false), onEvent: (name, metadata) => console.info("[plaid-link]", name, metadata) });
      handler.open();
    } catch (err) { setConnecting(false); setMessage(err.message || "Failed to open Plaid Link"); }
  }

  async function syncPlaid() {
    try { setSyncing(true); const res = await fetch(`${API_BASE}/api/plaid/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "settings" }) });
      const json = await res.json().catch(() => ({})); if (!res.ok) throw new Error(json?.error || "Failed to sync Plaid");
      setMessage(json.skipped ? `Plaid production guard active. Next transaction pull: ${new Date(json.nextAllowedAt).toLocaleString()}.` : `Plaid fetched ${json.fetched || 0} transactions; ${json.inserted || 0} were new.`);
      await loadBankingState();
    } catch (err) { setMessage(err.message || "Failed to sync Plaid"); } finally { setSyncing(false); }
  }

  async function deletePlaidItem(itemId) {
    if (!window.confirm("Disconnect this account? Denmark will deactivate the Item through Plaid and permanently delete its saved access token. Previously imported transaction history will remain in the Inbox.")) return;
    try { const res=await fetch(`${API_BASE}/api/plaid/items/${encodeURIComponent(itemId)}`,{method:"DELETE"}); const json=await res.json().catch(()=>({})); if(!res.ok)throw new Error(json?.error||"Failed to disconnect Plaid account"); setMessage(`${json.institutionName||"Plaid account"} disconnected. Imported history was retained.`); await loadBankingState(); }
    catch(err){setMessage(err.message||"Failed to disconnect Plaid account");}
  }

  async function persistBankingConfig() {
    const res = await fetch(`${API_BASE}/api/banking/connect/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bankingForm),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || "Failed to save Banking settings");
    setConfig((current) => ({ ...current, ...json }));
    setBankingForm((current) => ({
      ...current,
      applicationId: json.applicationId || current.applicationId,
      environment: json.environment || current.environment,
      staleTransactionDays:
        json.staleTransactionDays || current.staleTransactionDays,
      certificate: "",
      privateKey: "",
    }));
    return json;
  }

  async function saveBankingConfig(event) {
    event?.preventDefault();
    try {
      setSavingBankingConfig(true);
      setMessage("");
      await persistBankingConfig();
      setMessage("Banking integration settings saved and active.");
    } catch (err) {
      setMessage(err.message || "Failed to save Banking settings");
    } finally {
      setSavingBankingConfig(false);
    }
  }

  async function connectBanking({ repair = true } = {}) {
    try {
      setConnecting(true);
      setMessage("");
      setSavingBankingConfig(true);
      const savedConfig = await persistBankingConfig();
      setSavingBankingConfig(false);
      const activeConfig = { ...config, ...savedConfig };

      if (!activeConfig.configured) {
        throw new Error("Save the Banking application ID and credentials first.");
      }

      const BankingConnect = await loadBankingConnectScript();

      if (!BankingConnect?.setup) {
        throw new Error("Banking Connect did not initialize");
      }

      const repairTarget = getBankingRepairTarget(connections);
      const repairEnrollmentId = repairTarget?.enrollment_id || null;
      const connectOptions = {
        applicationId: activeConfig.applicationId,
        environment: activeConfig.environment || "development",
        products: repair
          ? activeConfig.products || ["transactions", "balance"]
          : ["transactions"],
        ...(repair
          ? { selectAccount: activeConfig.selectAccount || "multiple" }
          : {}),
        ...(!repair && repairTarget?.institution?.id
          ? { institution: repairTarget.institution.id }
          : {}),
        ...(repair &&
        connections?.sync_status?.status === "warning" &&
        repairEnrollmentId
          ? { enrollmentId: repairEnrollmentId }
          : {}),
        onSuccess: async (enrollment) => {
          try {
            const result = await saveBankingEnrollment(enrollment, {
              replaceExisting: !repair,
            });
            setMessage(
              result.replaced
                ? "Stale Banking connection replaced. Syncing transactions..."
                : result.created
                ? "Banking connection saved. Syncing transactions..."
                : "Banking connection already existed. Syncing transactions..."
            );
            await syncBanking();
            await loadBankingState();
          } catch (err) {
            setMessage(err.message || "Failed to save Banking connection");
          } finally {
            setConnecting(false);
          }
        },
        onExit: () => {
          setConnecting(false);
        },
        onFailure: (failure) => {
          const failureMessage =
            failure?.message || failure?.code || "Banking Connect failed";
          console.error("[banking-connect] enrollment failed", failure);
          setMessage(`Banking Connect failed: ${failureMessage}`);
          setConnecting(false);
        },
      };
      console.info("[banking-connect] opening", {
        applicationId: connectOptions.applicationId,
        environment: connectOptions.environment,
        products: connectOptions.products,
        institution: connectOptions.institution || null,
        enrollmentId: connectOptions.enrollmentId || null,
        repair,
      });
      const bankingConnect = BankingConnect.setup(connectOptions);

      bankingConnect.open();
    } catch (err) {
      setSavingBankingConfig(false);
      setConnecting(false);
      setMessage(err.message || "Failed to open Banking Connect");
    }
  }

  async function syncBanking() {
    try {
      setSyncing(true);

      const res = await fetch(`${API_BASE}/api/banking/sync`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          json?.error || json?.errors?.[0]?.error || "Failed to sync Banking"
        );
      }
      if (json?.errors?.length) {
        throw new Error(
          json.errors.map((item) => `${item.source}: ${item.error}`).join("; ")
        );
      }

      setMessage(
        `Banking returned ${json.processed || 0} transaction${
          Number(json.processed || 0) === 1 ? "" : "s"
        }; ${json.inserted || 0} ${
          Number(json.inserted || 0) === 1 ? "was" : "were"
        } new.`
      );
      await loadBankingState();
    } catch (err) {
      setMessage(err.message || "Failed to sync Banking");
    } finally {
      setSyncing(false);
    }
  }

  async function syncMercury() {
    try {
      setSyncingMercury(true);
      setMessage("");

      const res = await fetch(`${API_BASE}/api/banking/mercury/sync`, {
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
      await loadBankingState();
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
      await loadBankingState();
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
      await loadBankingState();
    } catch (err) {
      setMessage(err.message || "Failed to save Google Calendar setting");
    } finally {
      setSavingGoogleCalendarSyncEnabled(false);
    }
  }

  async function setIntegrationEnabled(key, enabled) {
    const next = {
      ...DEFAULT_INTEGRATION_ENABLEMENT,
      ...(integrationSwitches || {}),
      [key]: enabled,
    };

    try {
      setSavingIntegrationSwitches(true);
      setIntegrationSwitches(next);
      const res = await fetch(`${API_BASE}/api/settings/integrations.enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save integration switch");
      }

      setIntegrationSwitches({
        ...DEFAULT_INTEGRATION_ENABLEMENT,
        ...(json.value || next),
      });
      setMessage(`${key} ${enabled ? "enabled" : "disabled"} for this tenant.`);
    } catch (err) {
      setMessage(err.message || "Failed to save integration switch");
      await loadBankingState();
    } finally {
      setSavingIntegrationSwitches(false);
    }
  }

  function updateTollSetting(field, value) {
    setTollMessage("");
    setTollSettings((current) => ({
      ...mergeTollSettings(current),
      [field]: value,
    }));
  }

  function tollPayload() {
    const form = mergeTollSettings(tollSettings);
    return {
      enabled: form.enabled !== false,
      provider: form.provider,
      username: form.username,
      password: form.password || "__KEEP__",
      lookbackDays: Number(form.lookbackDays || 30),
    };
  }

  async function saveTollProviderSettings() {
    try {
      setSavingTollSettings(true);
      setTollMessage("");
      setMessage("");
      const res = await fetch(`${API_BASE}/api/settings/integrations.tolls`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tollPayload()),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save toll provider settings");
      }

      setTollSettings(mergeTollSettings(json.value || {}));
      setTollMessage("Toll provider settings saved.");
    } catch (err) {
      setTollMessage(err.message || "Failed to save toll provider settings");
    } finally {
      setSavingTollSettings(false);
    }
  }

  async function testTollProviderSettings() {
    try {
      setTestingTollSettings(true);
      setTollMessage("");
      setMessage("");
      const res = await fetch(`${API_BASE}/api/settings/integrations.tolls/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tollPayload()),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok || json.ok === false) {
        throw new Error(json?.error || "Toll provider test failed");
      }

      setTollMessage(
        `${json.providerLabel || "Toll provider"} responded with ${
          json.recordsSeen || 0
        } toll record${Number(json.recordsSeen || 0) === 1 ? "" : "s"}${
          json.recordsUnfiltered != null &&
          Number(json.recordsUnfiltered) !== Number(json.recordsSeen || 0)
            ? ` (${json.recordsUnfiltered} before lookback filter)`
            : ""
        }.`
      );
    } catch (err) {
      setTollMessage(err.message || "Toll provider test failed");
    } finally {
      setTestingTollSettings(false);
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
      await loadBankingState();
    } catch (err) {
      setMessage(err.message || "Failed to clean calendar duplicates");
    } finally {
      setRunningGoogleCalendarCleanup(false);
    }
  }

  async function cleanupGoogleCalendarMaintenanceEvents() {
    const confirmed = window.confirm(
      "Remove Denmark-created maintenance reminders from the selected Google Calendar? Trip events will be left alone."
    );
    if (!confirmed) return;

    try {
      setRunningGoogleCalendarMaintenanceCleanup(true);
      setMessage("");

      const res = await fetch(
        `${API_BASE}/api/integrations/google-calendar/maintenance-events/cleanup`,
        { method: "POST" }
      );
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to remove maintenance events");
      }

      setGoogleCalendarCleanupPreview(null);
      setMessage(
        `Removed ${json.removedEvents || 0} maintenance calendar event${
          Number(json.removedEvents || 0) === 1 ? "" : "s"
        }${json.failedEvents ? ` with ${json.failedEvents} failure(s)` : ""}.`
      );
      await loadBankingState();
    } catch (err) {
      setMessage(err.message || "Failed to remove maintenance calendar events");
    } finally {
      setRunningGoogleCalendarMaintenanceCleanup(false);
    }
  }

  const latestConnected = connections?.latest_connected_at
    ? new Date(connections.latest_connected_at).toLocaleString()
    : "Never";
  const repairTarget = getBankingRepairTarget(connections);
  const repairEnrollmentId = repairTarget?.enrollment_id || null;
  const canRepairBanking =
    connections?.sync_status?.status === "warning" && Boolean(repairEnrollmentId);

  return (
    <section className="panel settings-main-panel">
      <div className="panel-header">
        <div>
          <h2>Integrations</h2>
          <span>banking, telemetry, and external systems</span>
        </div>
      </div>

      <div className="settings-form">
        <IntegrationSwitchesCard
          switches={integrationSwitches}
          saving={savingIntegrationSwitches}
          onChange={setIntegrationEnabled}
        />

        <TollSettingsCard
          settings={tollSettings}
          loading={loading}
          saving={savingTollSettings}
          testing={testingTollSettings}
          statusMessage={tollMessage}
          onChange={updateTollSetting}
          onSave={saveTollProviderSettings}
          onTest={testTollProviderSettings}
        />

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
          runningMaintenanceCleanup={runningGoogleCalendarMaintenanceCleanup}
          savingSyncEnabled={savingGoogleCalendarSyncEnabled}
          onConnect={connectGoogleCalendar}
          onSync={syncGoogleCalendar}
          onPreviewCleanup={previewGoogleCalendarCleanup}
          onRunCleanup={runGoogleCalendarCleanup}
          onCleanupMaintenanceEvents={cleanupGoogleCalendarMaintenanceEvents}
          onSyncEnabledChange={setGoogleCalendarSyncEnabled}
        />

        <div className="settings-group">
          <div className="settings-group-title">Plaid</div>
          <div className="settings-empty-state">
            Plaid imports bank and card transactions into the existing Inbox. Transaction pulls are limited to once every 8 hours. A paid live balance is taken weekly, then advanced locally from imported transactions.
          </div>
          <form onSubmit={savePlaidConfig}>
            <div className="settings-form-grid">
              <label className="settings-field"><span>Client ID</span><input type="text" value={bankingForm.clientId || ""} onChange={(event)=>setBankingForm((current)=>({...current,clientId:event.target.value}))} autoComplete="off" /></label>
              <label className="settings-field"><span>Environment</span><input type="text" value="Production" disabled /></label>
              <label className="settings-field"><span>Secret</span><input type="password" value={bankingForm.secret || ""} placeholder={config?.secretConfigured ? "Saved; leave blank to keep" : "Plaid secret"} onChange={(event)=>setBankingForm((current)=>({...current,secret:event.target.value}))} autoComplete="new-password" /></label>
            </div>
            <small className="settings-field-note">The production secret is encrypted before storage.</small>
            <div className="settings-form-actions"><button type="submit" className="settings-action-btn" disabled={loading||savingBankingConfig}>{savingBankingConfig?"Saving…":"Save Plaid Settings"}</button></div>
          </form>
          <div className="settings-vehicle-list">
            <div className="settings-vehicle-row"><strong>Items</strong><span>{loading?"Loading…":connections?.items?.length||0}</span></div>
            <div className="settings-vehicle-row"><strong>Latest Plaid transaction</strong><span>{connections?.latestTransaction?formatIntegrationDate(connections.latestTransaction):"None imported"}</span></div>
            <div className="settings-vehicle-row"><strong>Last transaction pull</strong><span>{connections?.lastSync?.lastCheckedAt?`${formatIntegrationDate(connections.lastSync.lastCheckedAt)} · fetched ${connections.lastSync.fetched||0}, imported ${connections.lastSync.inserted||0}${connections.lastSync.skippedBeforeCutoff?`, ${connections.lastSync.skippedBeforeCutoff} before cutoff`:""}`:"No completed pull recorded"}</span></div>
            <div className="settings-vehicle-row"><strong>Production guards</strong><span>Transactions: 8 hours · Live balance anchor: 7 days</span></div>
            <div className="settings-vehicle-row"><strong>Ingestion begins</strong><span>July 1, 2026 (earlier transactions are always rejected)</span></div>
            <div className="settings-vehicle-row"><strong>Webhook URL</strong><span>{connections?.webhook?.webhookUrl||"Set the public base URL in Settings"}</span></div>
            <div className="settings-vehicle-row"><strong>Last webhook</strong><span>{connections?.webhook?.lastDelivery?.receivedAt?`${new Date(connections.webhook.lastDelivery.receivedAt).toLocaleString()} · ${connections.webhook.lastDelivery.webhookType||"unknown"}/${connections.webhook.lastDelivery.webhookCode||"unknown"}`:"None received"}</span></div>
            {(connections?.items||[]).map((item)=><div className="settings-vehicle-row" key={item.item_id}><strong>{item.institution_name||"Plaid Item"}</strong><span>{item.transactions_last_success_at?`Synced ${new Date(item.transactions_last_success_at).toLocaleString()}`:"Not synced"} {item.last_error?<em>{item.last_error.message}</em>:null} <button type="button" className="settings-action-btn secondary" onClick={()=>connectPlaid(item.item_id)}>Repair</button> <button type="button" className="settings-action-btn secondary" onClick={()=>deletePlaidItem(item.item_id)}>Disconnect Account</button></span></div>)}
          </div>
          <div className="settings-form-actions">
            <button type="button" className="settings-action-btn" disabled={loading||connecting||!config?.configured} onClick={()=>connectPlaid()}>{connecting?"Opening…":"Connect with Plaid"}</button>
            <button type="button" className="settings-action-btn secondary" disabled={loading||syncing||!(connections?.items?.length)} onClick={syncPlaid}>{syncing?"Syncing…":"Sync Plaid"}</button>
            {message?<span className="settings-message">{message}</span>:null}
          </div>
        </div>

        {false ? (<div className="settings-group">
          <div className="settings-group-title">Banking</div>
          <div className="settings-empty-state">
            Connect another bank or card through Banking. New connections are added
            to the sync pool; existing expense matching still happens in Inbox.
          </div>

          <form onSubmit={saveBankingConfig}>
            <div className="settings-form-grid">
              <label className="settings-field">
                <span>Application ID</span>
                <input
                  type="text"
                  value={bankingForm.applicationId}
                  onChange={(event) =>
                    setBankingForm((current) => ({
                      ...current,
                      applicationId: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </label>
              <label className="settings-field">
                <span>Environment</span>
                <select
                  value={bankingForm.environment}
                  onChange={(event) =>
                    setBankingForm((current) => ({
                      ...current,
                      environment: event.target.value,
                    }))
                  }
                >
                  <option value="development">Development</option>
                  <option value="production">Production</option>
                </select>
              </label>
              <label className="settings-field">
                <span>Stale transaction warning (days)</span>
                <input
                  type="number"
                  min="1"
                  value={bankingForm.staleTransactionDays}
                  onChange={(event) =>
                    setBankingForm((current) => ({
                      ...current,
                      staleTransactionDays: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Client certificate</span>
                <textarea
                  rows="3"
                  value={bankingForm.certificate}
                  placeholder={
                    config?.certificateConfigured
                      ? "Saved; leave blank to keep"
                      : "Paste PEM or base64-encoded PEM"
                  }
                  onChange={(event) =>
                    setBankingForm((current) => ({
                      ...current,
                      certificate: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </label>
              <label className="settings-field">
                <span>Private key</span>
                <textarea
                  rows="3"
                  value={bankingForm.privateKey}
                  placeholder={
                    config?.privateKeyConfigured
                      ? "Saved; leave blank to keep"
                      : "Paste PEM or base64-encoded PEM"
                  }
                  onChange={(event) =>
                    setBankingForm((current) => ({
                      ...current,
                      privateKey: event.target.value,
                    }))
                  }
                  autoComplete="new-password"
                />
              </label>
            </div>
            <small className="settings-field-note">
              Certificate and private key values are encrypted before being stored.
              Leave either secret blank to retain its saved value.
            </small>
            <div className="settings-form-actions">
              <button
                type="submit"
                className="settings-action-btn"
                disabled={loading || savingBankingConfig}
              >
                {savingBankingConfig ? "Saving..." : "Save Banking Settings"}
              </button>
            </div>
          </form>

          <div className="settings-vehicle-list">
            <div className="settings-vehicle-row">
              <strong>Connections</strong>
              <span>{loading ? "Loading..." : connections?.token_count || 0}</span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Connection added</strong>
              <span>{loading ? "Loading..." : latestConnected}</span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Last sync attempt</strong>
              <span>
                {loading
                  ? "Loading..."
                  : connections?.sync_status?.lastCheckedAt
                  ? `${new Date(
                      connections.sync_status.lastCheckedAt
                    ).toLocaleString()} (${connections.sync_status.status})`
                  : "Never recorded"}
              </span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Latest Banking transaction</strong>
              <span>
                {loading
                  ? "Loading..."
                  : connections?.accounts?.[0]?.latest_transaction_date
                  ? formatIntegrationDate(
                      connections.accounts[0].latest_transaction_date
                    )
                  : "None imported"}
              </span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Repair target</strong>
              <span>
                {loading
                  ? "Loading..."
                  : repairEnrollmentId
                  ? `${repairTarget?.institution?.name || "Banking"} ${
                      repairTarget?.last_four
                        ? `****${repairTarget.last_four} `
                        : ""
                    }(${repairEnrollmentId})`
                  : "No live enrollment ID returned"}
              </span>
            </div>
            <div className="settings-vehicle-row">
              <strong>Connect config</strong>
              <span>
                {loading
                  ? "Loading..."
                  : config?.configured
                  ? `${config.environment || "development"} (${config.source || "settings"})`
                  : "Missing Banking credentials"}
              </span>
            </div>
          </div>

          {connections?.sync_status?.status === "error" ? (
            <div className="settings-message error">
              Banking sync is failing:{" "}
              {connections.sync_status.errors?.[0]?.message || "Unknown error"}
              {connections.sync_status.errors?.some((item) => item.reconnectRequired)
                ? " Reconnect the bank with Connect Bank to replace the expired authorization."
                : " Try Sync Banking again and check the server log if the error continues."}
            </div>
          ) : null}

          {connections?.sync_status?.status === "warning" ? (
            <div className="settings-message warning">
              Banking responded successfully, but the feed may be stale:{" "}
              {connections.sync_status.warning}. Reconnect the affected bank if
              recent posted transactions are missing.
            </div>
          ) : null}

          <div className="settings-form-actions">
            <button
              type="button"
              className="settings-action-btn"
              disabled={loading || connecting || !config?.configured}
              onClick={() => connectBanking({ repair: true })}
            >
              {connecting
                ? "Opening..."
                : canRepairBanking
                ? "Repair Banking Connection"
                : "Connect Bank"}
            </button>
            {canRepairBanking ? (
              <button
                type="button"
                className="settings-action-btn secondary"
                disabled={loading || connecting || !config?.configured}
                onClick={() => connectBanking({ repair: false })}
              >
                Replace Banking Connection
              </button>
            ) : null}
            <button
              type="button"
              className="settings-action-btn secondary"
              disabled={loading || syncing || !connections?.token_count}
              onClick={syncBanking}
            >
              {syncing ? "Syncing..." : "Sync Banking"}
            </button>
            {message ? <span className="settings-message">{message}</span> : null}
          </div>
        </div>) : null}

        <div className="settings-group">
          <div className="settings-group-title">Mercury</div>
          <div className="settings-empty-state">
            Mercury uses its direct API token and imports into the same Inbox
            review flow as Plaid card transactions.
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

function getLogLevelClass(entry) {
  const level = String(entry?.level || "log").trim().toLowerCase();
  if (level === "error") return "settings-log-line--error";
  if (level === "warn") return "settings-log-line--warn";
  if (level === "debug") return "settings-log-line--debug";
  if (level === "info") return "settings-log-line--info";
  return "settings-log-line--log";
}

function ServerLogsSettingsPanel() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [followTail, setFollowTail] = useState(true);
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
    if (!autoRefresh) return undefined;
    const interval = window.setInterval(() => {
      loadLogs({ append: true });
    }, 3000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, entries]);

  useEffect(() => {
    if (!followTail || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [entries, followTail]);

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
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            <span>Auto-refresh</span>
          </label>
          <label className="settings-checkbox-row settings-log-follow">
            <input
              type="checkbox"
              checked={followTail}
              onChange={(event) => setFollowTail(event.target.checked)}
            />
            <span>Follow tail</span>
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

          <div ref={logRef} className="settings-json-view settings-log-view">
            {entries.length ? (
              entries.map((entry) => (
                <div
                  key={entry.id}
                  className={`settings-log-line ${getLogLevelClass(entry)}`}
                >
                  {formatLogLine(entry)}
                </div>
              ))
            ) : (
              <div className="settings-log-line settings-log-line--empty">
                {loading
                  ? "Loading server logs..."
                  : "No server log entries captured yet."}
              </div>
            )}
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

    if (activeSection === "setup") {
      return {
        title: "Tenant readiness",
        body:
          "This checklist is the beta onboarding map. Required items should be ready; optional integrations can be skipped deliberately.",
      };
    }

    if (activeSection === "users") {
      return {
        title: "Access model",
        body:
          "Invite users by email, then assign the least powerful role that fits their work. Owners can change settings and manage other users.",
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

    if (activeSection === "messages") {
      return {
        title: "Inbox intake",
        body:
          "IMAP is the simplest high-value integration for beta tenants because it can create trip/message context before telemetry or banking exists.",
      };
    }

    if (activeSection === "alerts") {
      return {
        title: "Noise control",
        body:
          "SMS and Android bridge alerts should be explicit per tenant. If a tenant does not use the bridge, disable it here so stale notices stay quiet.",
      };
    }

    if (activeSection === "backup") {
      return {
        title: "Tenant safety",
        body:
          "Backup and restore are the escape hatch for migration and disaster recovery. Validate staged files before replacing tenant data.",
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
        title: "Integration control",
        body:
          "Use the switches to disable optional provider jobs on test tenants. Provider cards still show whether the underlying credentials are configured.",
      };
    }

    if (activeSection === "ai") {
      return {
        title: "Prompt control",
        body:
          "These prompts are stored in app settings and are read by the daily briefing, AI vehicle purchase review, and weekly fleet valuation jobs when they run.",
      };
    }

    if (activeSection === "maintenance") {
      return {
        title: "Maintenance ops",
        body:
          "This section is now focused on fleet maintenance and telemetry diagnostics. Alerts and backup have their own sections.",
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
  const [activeSection, setActiveSection] = useState("setup");

  return (
    <>
      <SectionList activeSection={activeSection} onChange={setActiveSection} />

      {activeSection === "setup" ? (
        <SetupChecklistPanel onNavigate={setActiveSection} />
      ) : activeSection === "users" ? (
        <UsersAccessPanel />
      ) : activeSection === "dispatch" ? (
        <DispatchSettingsPanel
          settings={dispatchSettings}
          onSaved={onDispatchSettingsSaved}
        />
      ) : activeSection === "fleet" ? (
        <FleetSettingsPanel />
      ) : activeSection === "messages" ? (
        <MessagesSettingsPanel />
      ) : activeSection === "auth" ? (
        <AuthPublicUrlSettingsPanel />
      ) : activeSection === "locations" ? (
        <LocationsSettingsPanel />
      ) : activeSection === "alerts" ? (
        <AlertSettingsPanel />
      ) : activeSection === "backup" ? (
        <DatabaseSettingsPanel />
      ) : activeSection === "expenses" ? (
        <ExpenseSettingsPanel />
      ) : activeSection === "marketplace" ? (
        <MarketplaceSettingsPanel />
      ) : activeSection === "website" ? (
        <PublicExportSettingsPanel />
      ) : activeSection === "integrations" ? (
        <IntegrationsSettingsPanel />
      ) : activeSection === "ai" ? (
        <AiPromptSettingsPanel />
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


