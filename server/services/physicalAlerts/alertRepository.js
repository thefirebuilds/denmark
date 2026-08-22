const crypto = require("crypto");
const pool = require("../../db");
const {
  SETTINGS_KEY: BOOKING_ALERT_SETTINGS_KEY,
  normalizeBookingAlertSettings,
} = require("./bookingAlertSettings");

async function ensureAlertDeviceSchema(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS alert_devices (
      id bigserial PRIMARY KEY,
      device_id text NOT NULL UNIQUE,
      display_name text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      last_seen_at timestamptz,
      last_status text,
      firmware_version text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id text PRIMARY KEY,
      type text NOT NULL,
      severity text NOT NULL,
      title text NOT NULL,
      message text NOT NULL,
      trip_id integer REFERENCES trips(id) ON DELETE SET NULL,
      device_id text REFERENCES alert_devices(device_id) ON UPDATE CASCADE ON DELETE SET NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key text UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      acknowledged_at timestamptz,
      acknowledged_by text,
      resolved_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_active_device
      ON alerts (device_id, severity, created_at DESC) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_alert_devices_enabled ON alert_devices (enabled, device_id);
  `);
}

function createAlertRepository(db = pool) {
  return {
    ensureSchema: () => ensureAlertDeviceSchema(db),
    async registerDevice(deviceId, displayName = deviceId) {
      const { rows } = await db.query(`INSERT INTO alert_devices (device_id,display_name)
        VALUES ($1,$2) ON CONFLICT (device_id) DO UPDATE SET display_name=EXCLUDED.display_name,
        updated_at=now() RETURNING *`, [deviceId, displayName]);
      return rows[0];
    },
    async createAlert(input) {
      const id = input.id || crypto.randomUUID();
      const { rows } = await db.query(`INSERT INTO alerts
        (id,type,severity,title,message,trip_id,device_id,metadata,dedupe_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
        ON CONFLICT (dedupe_key) DO UPDATE SET dedupe_key=alerts.dedupe_key
        RETURNING *, (id=$1) AS inserted`, [id,input.type,input.severity,input.title,input.message,
        input.tripId || null,input.deviceId || null,JSON.stringify(input.metadata || {}),input.dedupeKey || null]);
      return rows[0];
    },
    async markPublished(id, at = new Date()) {
      const { rows } = await db.query("UPDATE alerts SET published_at=COALESCE(published_at,$2) WHERE id=$1 RETURNING *", [id, at]);
      return rows[0] || null;
    },
    async acknowledge(id, by, at = new Date()) {
      const { rows } = await db.query(`UPDATE alerts SET acknowledged_at=COALESCE(acknowledged_at,$2),
        acknowledged_by=COALESCE(acknowledged_by,$3) WHERE id=$1 RETURNING *`, [id, at, by]);
      return rows[0] || null;
    },
    async resolve(id, at = new Date()) {
      const { rows } = await db.query("UPDATE alerts SET resolved_at=COALESCE(resolved_at,$2) WHERE id=$1 RETURNING *", [id, at]);
      return rows[0] || null;
    },
    async reopenBookingAlert(tripId) {
      const { rows } = await db.query(`UPDATE alerts SET resolved_at=NULL,acknowledged_at=NULL,
        acknowledged_by=NULL,published_at=NULL WHERE type='new_critical_booking' AND trip_id=$1
        AND resolved_at IS NOT NULL RETURNING *`, [tripId]);
      return rows[0] || null;
    },
    async getById(id) {
      const { rows } = await db.query("SELECT * FROM alerts WHERE id=$1", [id]);
      return rows[0] || null;
    },
    async listAlerts({ active = false, deviceId = null, limit = 100 } = {}) {
      const { rows } = await db.query(`SELECT * FROM alerts WHERE ($1::boolean=false OR resolved_at IS NULL)
        AND ($2::text IS NULL OR device_id=$2) ORDER BY created_at DESC LIMIT $3`, [active, deviceId, limit]);
      return rows;
    },
    async listUnconfirmedTrips() {
      const { rows } = await db.query(`SELECT id,reservation_id,vehicle_name,trip_start,workflow_stage
        FROM trips
        WHERE canceled_at IS NULL
          AND COALESCE(status,'') <> 'canceled'
          AND (
            workflow_stage = 'booked'
            OR (
              COALESCE(workflow_stage, '') NOT IN (
                'confirmed','ready_for_handoff','in_progress','turnaround',
                'awaiting_expenses','complete','closed','canceled'
              )
              AND (
                needs_review = TRUE
                OR status IN ('booked_unconfirmed','updated_unconfirmed')
              )
            )
          )
        ORDER BY trip_start`);
      return rows;
    },
    async getBookingAlertSettings() {
      const { rows } = await db.query("SELECT value FROM app_settings WHERE key=$1 LIMIT 1", [BOOKING_ALERT_SETTINGS_KEY]);
      return normalizeBookingAlertSettings(rows[0]?.value || {});
    },
    async listDevices(deviceId = null) {
      const { rows } = await db.query(`SELECT * FROM alert_devices WHERE ($1::text IS NULL OR device_id=$1)
        ORDER BY device_id`, [deviceId]);
      return rows;
    },
    async updateDeviceStatus(deviceId, status) {
      const { rows } = await db.query(`UPDATE alert_devices SET last_seen_at=$2,last_status=$3,
        firmware_version=COALESCE($4,firmware_version),updated_at=now() WHERE device_id=$1 AND enabled=true RETURNING *`,
        [deviceId,status.timestamp,status.state,status.firmware || null]);
      return rows[0] || null;
    },
  };
}

module.exports = { createAlertRepository, ensureAlertDeviceSchema };
