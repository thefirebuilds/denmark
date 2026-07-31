const pool = require("../../db");

let ensurePromise = null;

async function ensureTollAuditSchema(client = pool) {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await client.query(`
        ALTER TABLE toll_charges
          ADD COLUMN IF NOT EXISTS attributed_at timestamptz,
          ADD COLUMN IF NOT EXISTS attributed_by text;

        CREATE TABLE IF NOT EXISTS toll_charge_assignment_history (
          id bigserial PRIMARY KEY,
          toll_charge_id bigint NOT NULL REFERENCES toll_charges(id) ON DELETE CASCADE,
          previous_trip_id bigint,
          next_trip_id bigint,
          changed_at timestamptz NOT NULL DEFAULT NOW(),
          changed_by text NOT NULL DEFAULT 'system'
        );

        CREATE INDEX IF NOT EXISTS idx_toll_assignment_history_charge
          ON toll_charge_assignment_history(toll_charge_id, changed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_toll_assignment_history_trip
          ON toll_charge_assignment_history(next_trip_id, changed_at DESC);

        CREATE TABLE IF NOT EXISTS trip_toll_billing_snapshots (
          id bigserial PRIMARY KEY,
          trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          invoice_message_id integer REFERENCES messages(id) ON DELETE SET NULL,
          billed_at timestamptz NOT NULL,
          billed_amount numeric(10,2) NOT NULL DEFAULT 0,
          attributed_amount numeric(10,2) NOT NULL DEFAULT 0,
          attributed_count integer NOT NULL DEFAULT 0,
          unresolved_vehicle_window_count integer NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL DEFAULT NOW(),
          UNIQUE(invoice_message_id)
        );

        CREATE TABLE IF NOT EXISTS trip_toll_billing_snapshot_items (
          snapshot_id bigint NOT NULL REFERENCES trip_toll_billing_snapshots(id) ON DELETE CASCADE,
          toll_charge_id bigint NOT NULL REFERENCES toll_charges(id) ON DELETE RESTRICT,
          amount numeric(10,2) NOT NULL,
          attributed_at timestamptz,
          PRIMARY KEY(snapshot_id, toll_charge_id)
        );

        CREATE OR REPLACE FUNCTION record_toll_trip_assignment()
        RETURNS trigger AS $$
        BEGIN
          IF OLD.matched_trip_id IS DISTINCT FROM NEW.matched_trip_id THEN
            NEW.attributed_at = CASE WHEN NEW.matched_trip_id IS NULL THEN NULL ELSE NOW() END;
            NEW.attributed_by = COALESCE(NULLIF(current_setting('denmark.toll_assignment_actor', true), ''), 'system');
            INSERT INTO toll_charge_assignment_history (
              toll_charge_id, previous_trip_id, next_trip_id, changed_at, changed_by
            ) VALUES (
              NEW.id, OLD.matched_trip_id, NEW.matched_trip_id, NOW(), NEW.attributed_by
            );
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_toll_charge_assignment_history ON toll_charges;
        CREATE TRIGGER trg_toll_charge_assignment_history
          BEFORE UPDATE OF matched_trip_id ON toll_charges
          FOR EACH ROW EXECUTE FUNCTION record_toll_trip_assignment();

        UPDATE toll_charges
        SET attributed_at = COALESCE(attributed_at, created_at),
            attributed_by = COALESCE(attributed_by, 'legacy_backfill')
        WHERE matched_trip_id IS NOT NULL
          AND attributed_at IS NULL;
      `);
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

async function captureTripTollBillingSnapshot({
  tripId,
  invoiceMessageId,
  billedAt,
  billedAmount,
}) {
  await ensureTollAuditSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const snapshot = await client.query(
      `
        WITH trip_context AS (
          SELECT t.id, t.trip_start, t.trip_end, v.id AS vehicle_id
          FROM trips t
          LEFT JOIN vehicles v ON v.turo_vehicle_id = t.turo_vehicle_id
          WHERE t.id = $1
          LIMIT 1
        ), attributed AS (
          SELECT COUNT(tc.id)::integer AS count, COALESCE(SUM(tc.amount), 0)::numeric(10,2) AS total
          FROM toll_charges tc
          WHERE tc.matched_trip_id = $1
        ), unresolved AS (
          SELECT COUNT(tc.id)::integer AS count
          FROM toll_charges tc
          CROSS JOIN trip_context ctx
          WHERE tc.matched_trip_id IS NULL
            AND tc.matched_vehicle_id = ctx.vehicle_id
            AND tc.trxn_at BETWEEN ctx.trip_start - INTERVAL '2 hours'
              AND ctx.trip_end + INTERVAL '168 hours'
            AND COALESCE(tc.review_status, '') NOT IN ('dismissed', 'ignored')
        )
        INSERT INTO trip_toll_billing_snapshots (
          trip_id, invoice_message_id, billed_at, billed_amount,
          attributed_amount, attributed_count, unresolved_vehicle_window_count
        )
        SELECT $1, $2, $3, $4, attributed.total, attributed.count, unresolved.count
        FROM attributed, unresolved
        ON CONFLICT (invoice_message_id) DO NOTHING
        RETURNING id
      `,
      [tripId, invoiceMessageId, billedAt || new Date().toISOString(), billedAmount || 0]
    );
    if (snapshot.rows[0]?.id) {
      await client.query(
        `
          INSERT INTO trip_toll_billing_snapshot_items (
            snapshot_id, toll_charge_id, amount, attributed_at
          )
          SELECT $1, id, amount, attributed_at
          FROM toll_charges
          WHERE matched_trip_id = $2
          ON CONFLICT DO NOTHING
        `,
        [snapshot.rows[0].id, tripId]
      );
    }
    await client.query("COMMIT");
    return snapshot.rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { ensureTollAuditSchema, captureTripTollBillingSnapshot };
