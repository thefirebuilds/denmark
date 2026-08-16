const { ensureAuthTables } = require("../auth/store");
const {
  ensureNotificationEventsTable,
} = require("../routes/notificationRoutes");
const {
  ensureGoogleCalendarConnectionHealthColumns,
} = require("../services/googleCalendar/googleCalendarStore");
const {
  ensureVehicleFmvEstimatesTable,
} = require("../services/vehicles/fmvEstimateService");
const {
  ensureBusinessMetricsTables,
} = require("../services/metrics/businessMetricsService");
const {
  ensureMetricsIndexes,
} = require("../services/metrics/metricsIndexes");
const {
  ensureVehicleOdometerRollupTable,
} = require("../services/vehicles/odometerRollupService");
const {
  ensureVehicleAliasesTable,
} = require("../services/vehicles/vehicleAliases");
const {
  ensureVehicleRuntimeSchema,
} = require("../services/vehicles/vehicleRuntimeSchema");
const {
  ensureTripRuntimeSchema,
} = require("../services/trips/tripRuntimeSchema");
const {
  ensureMaintenanceRuntimeSchema,
} = require("../services/maintenance/maintenanceRuntimeSchema");
const {
  ensureVehicleIdentityConstraints,
} = require("../services/vehicles/vehicleIdentityConstraints");
const {
  ensureApplicationUniqueConstraints,
} = require("../services/database/applicationUniqueConstraints");
const { ensureBankingRuntimeSchema } = require("../services/banking/bankingRuntimeSchema");
const {
  ensureSystemActivityLogTable,
} = require("../services/systemActivityLog");
const { ensureIncomeTables } = require("../services/income/incomeService");
const { ensureFleetAlertTables } = require("../services/alerts/fleetAlerts");
const { ensureAlertDeviceSchema } = require("../services/physicalAlerts/alertRepository");
const {
  ensureAuthPublicUrlSettings,
} = require("../services/authPublicUrlSettings");
const {
  ensureAiPromptSettings,
} = require("../services/aiPromptSettings");
const {
  ensureMessageRuntimeSchema,
} = require("../services/messageRuntimeSchema");
const {
  backfillTripLocationsFromStoredMessages,
  backfillCanceledTripAmountsFromStoredMessages,
} = require("../services/saveMessage");
const { ensureTollAuditSchema } = require("../services/tolls/tollAuditService");

const STARTUP_ENSURE_TIMEOUT_MS = Number(
  process.env.STARTUP_ENSURE_TIMEOUT_MS || 30000
);

function withStartupEnsureTimeout(label, promise) {
  let timeoutHandle = null;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `Startup schema ensure timed out after ${STARTUP_ENSURE_TIMEOUT_MS}ms: ${label}`
        )
      );
    }, STARTUP_ENSURE_TIMEOUT_MS);
    timeoutHandle.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}

async function initializeStartupTables() {
  console.log("[server] ensuring banking runtime schema");
  await withStartupEnsureTimeout("banking runtime schema", ensureBankingRuntimeSchema());
  console.log("[server] ensuring vehicle identity constraints");
  await withStartupEnsureTimeout(
    "vehicle identity constraints",
    ensureVehicleIdentityConstraints()
  );
  console.log("[server] ensuring application unique constraints");
  await withStartupEnsureTimeout(
    "application unique constraints",
    ensureApplicationUniqueConstraints()
  );
  console.log("[server] ensuring runtime support tables");
  const startupEnsures = [
    ["notification events", ensureNotificationEventsTable],
    ["vehicle FMV estimates", ensureVehicleFmvEstimatesTable],
    ["business metrics", ensureBusinessMetricsTables],
    ["metrics indexes", ensureMetricsIndexes],
    ["vehicle odometer rollups", ensureVehicleOdometerRollupTable],
    ["vehicle aliases", ensureVehicleAliasesTable],
    ["message runtime schema", ensureMessageRuntimeSchema],
    ["vehicle runtime schema", ensureVehicleRuntimeSchema],
    ["trip runtime schema", ensureTripRuntimeSchema],
    ["maintenance runtime schema", ensureMaintenanceRuntimeSchema],
    ["toll audit schema", ensureTollAuditSchema],
    ["income tables", ensureIncomeTables],
    ["fleet alerts", ensureFleetAlertTables],
    ["physical alert devices", ensureAlertDeviceSchema],
    ["Google Calendar health columns", ensureGoogleCalendarConnectionHealthColumns],
    ["auth tables", ensureAuthTables],
    ["system activity log", ensureSystemActivityLogTable],
    ["auth public URL settings", ensureAuthPublicUrlSettings],
    ["AI prompt settings", ensureAiPromptSettings],
  ];

  for (const [label, ensureFn] of startupEnsures) {
    console.log(`[server] ensuring ${label}`);
    await withStartupEnsureTimeout(label, ensureFn());
  }
  console.log("[server] backfilling trip pickup/return locations");
  await withStartupEnsureTimeout(
    "trip location backfill",
    backfillTripLocationsFromStoredMessages()
  );
  console.log("[server] backfilling canceled trip financial values");
  await withStartupEnsureTimeout(
    "canceled trip amount backfill",
    backfillCanceledTripAmountsFromStoredMessages()
  );
}

module.exports = {
  initializeStartupTables,
  withStartupEnsureTimeout,
};
