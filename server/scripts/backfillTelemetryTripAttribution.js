const pool = require("../db");
const {
  backfillTelemetryTripAttribution,
  ensureTelemetryTripAttributionSchema,
} = require("../services/telemetry/tripAttribution");

async function main() {
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const all = process.argv.includes("--all");
  const limit = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : 50000;

  await ensureTelemetryTripAttributionSchema(pool);
  const result = await backfillTelemetryTripAttribution({ all, limit }, pool);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
