const crypto = require("crypto");

function normalizeText(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePlate(value) {
  return normalizeText(value).replace(/[^A-Z0-9]/g, "");
}

const DEFAULT_FINGERPRINT_FIELDS = [
  "trxnAt",
  "licensePlate",
  "amount",
  "agencyName",
  "facilityName",
  "plazaName",
  "laneName",
  "direction",
  "transType",
];

function parseFingerprintFields(value) {
  const fields = String(value || "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  return fields.length ? fields : DEFAULT_FINGERPRINT_FIELDS;
}

function fingerprintValue(record, field) {
  if (field === "licensePlate" || field === "licensePlateNormalized") {
    return normalizePlate(record.licensePlate || record.licensePlateNormalized);
  }

  if (field === "amount") {
    return Number(record.amount || 0).toFixed(2);
  }

  return normalizeText(record[field]);
}

function buildTollFingerprint(record, options = {}) {
  const parts = parseFingerprintFields(options.fields || options.fingerprintFields).map(
    (field) => fingerprintValue(record, field)
  );

  if (options.salt || options.fingerprintSalt) {
    parts.push(normalizeText(options.salt || options.fingerprintSalt));
  }

  return crypto
    .createHash("sha256")
    .update(parts.join("|"))
    .digest("hex");
}

module.exports = {
  normalizePlate,
  buildTollFingerprint,
  parseFingerprintFields,
};
