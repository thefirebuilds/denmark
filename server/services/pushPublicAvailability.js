const crypto = require("crypto");
const { getPublicAvailability } = require("./publicAvailability");

async function pushPublicAvailabilitySnapshot() {
  const url = process.env.PUBLIC_AVAILABILITY_INGEST_URL;
  const bearerToken = process.env.PUBLIC_AVAILABILITY_BEARER_TOKEN;
  const hmacSecret = process.env.PUBLIC_AVAILABILITY_HMAC_SECRET;

  if (!url || !bearerToken || !hmacSecret) {
    throw new Error("Missing PUBLIC_AVAILABILITY_* environment variables");
  }

  const vehicles = await getPublicAvailability();

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "denmark-node",
    vehicles,
  };

  const timestamp = new Date().toISOString();
  const rawBody = JSON.stringify(payload);

  const signature = crypto
    .createHmac("sha256", hmacSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
      "X-Denmark-Timestamp": timestamp,
      "X-Denmark-Signature": `sha256=${signature}`,
    },
    body: rawBody,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Availability push failed: ${response.status} ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

async function pushPublicAvailabilitySnapshotSafe(reason = "unspecified") {
  try {
    const result = await pushPublicAvailabilitySnapshot();
    console.log(`[availability] push ok | reason=${reason}`);
    return result;
  } catch (error) {
    console.error(
      `[availability] push failed | reason=${reason} error=${error?.message || error}`
    );
    return null;
  }
}

module.exports = {
  pushPublicAvailabilitySnapshot,
  pushPublicAvailabilitySnapshotSafe,
};
