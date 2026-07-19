const pool = require("../../db");

const SETTINGS_KEY = "integrations.enabled";

const DEFAULT_INTEGRATION_ENABLEMENT = Object.freeze({
  imap: true,
  bouncie: true,
  dimo: true,
  plaid: true,
  tolls: true,
  googleCalendar: true,
  fmv: true,
  businessMetrics: true,
  dailyBrief: true,
  publicAvailability: true,
});

function normalizeIntegrationEnablement(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = { ...DEFAULT_INTEGRATION_ENABLEMENT };

  for (const key of Object.keys(DEFAULT_INTEGRATION_ENABLEMENT)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      normalized[key] = input[key] !== false;
    }
  }

  return normalized;
}

async function getIntegrationEnablement(client = pool) {
  const { rows } = await client.query(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SETTINGS_KEY]
  );

  return normalizeIntegrationEnablement(rows[0]?.value || {});
}

async function saveIntegrationEnablement(input = {}, client = pool) {
  const current = await getIntegrationEnablement(client);
  const value = normalizeIntegrationEnablement({
    ...current,
    ...(input && typeof input === "object" ? input : {}),
  });

  const { rows } = await client.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      RETURNING value
    `,
    [SETTINGS_KEY, JSON.stringify(value)]
  );

  return normalizeIntegrationEnablement(rows[0]?.value || value);
}

async function isIntegrationEnabled(name, client = pool) {
  const settings = await getIntegrationEnablement(client);
  return settings[name] !== false;
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_INTEGRATION_ENABLEMENT,
  normalizeIntegrationEnablement,
  getIntegrationEnablement,
  saveIntegrationEnablement,
  isIntegrationEnabled,
};
