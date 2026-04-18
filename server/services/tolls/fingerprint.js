const crypto = require("crypto");

function normalizeText(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePlate(value) {
  return normalizeText(value).replace(/[^A-Z0-9]/g, "");
}

function buildTollFingerprint(record) {
  const parts = [
    record.trxnAt || "",
    normalizePlate(record.licensePlate),
    Number(record.amount || 0).toFixed(2),
    normalizeText(record.agencyName),
    normalizeText(record.facilityName),
    normalizeText(record.plazaName),
    normalizeText(record.laneName),
    normalizeText(record.direction),
    normalizeText(record.transType),
  ];

  return crypto
    .createHash("sha256")
    .update(parts.join("|"))
    .digest("hex");
}

module.exports = {
  normalizePlate,
  buildTollFingerprint,
};