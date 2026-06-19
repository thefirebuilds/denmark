#!/usr/bin/env node

require("dotenv").config({ path: "../.env" });

const pool = require("../server/db");
const {
  applyTripCloseoutSignalsFromMessage,
  extractFuelReimbursementFromText,
} = require("../server/services/saveMessage");

async function main() {
  const { rows } = await pool.query(`
    SELECT id, trip_id, subject, normalized_text_body
    FROM messages
    WHERE trip_id IS NOT NULL
      AND message_type = 'reimbursement_invoice'
    ORDER BY message_timestamp DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
  `);

  let applied = 0;
  let withFuel = 0;

  for (const row of rows) {
    const fuel = extractFuelReimbursementFromText(row.normalized_text_body);
    if (fuel?.fuelTotal != null) {
      withFuel += 1;
    }

    await applyTripCloseoutSignalsFromMessage({
      tripId: row.trip_id,
      messageType: "reimbursement_invoice",
      normalizedTextBody: row.normalized_text_body,
    });
    applied += 1;
  }

  console.log(
    `[reimbursement:apply] applied ${applied} invoice message(s); ${withFuel} included fuel reimbursement`
  );
}

main()
  .catch((error) => {
    console.error(`[reimbursement:apply] failed: ${error.message || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => null);
  });
