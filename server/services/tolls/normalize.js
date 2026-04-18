const { normalizePlate, buildTollFingerprint } = require("./fingerprint");

function isTollTransaction(raw) {
  const upper = String(raw?.transType || "").toUpperCase();

  return (
    upper.includes("AVI TRANSACTION") ||
    upper.includes("VIDEO TRANSACTION")
  );
}

function toIsoOrNull(value) {
  if (!value) return null;

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toPositiveAmount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.abs(num);
}

function normalizeTollRecord(raw) {
  const trxnAt = toIsoOrNull(raw?.trxnDate);
  const postedAt = toIsoOrNull(raw?.postedDate);
  const amount = toPositiveAmount(raw?.amount);

  if (!trxnAt || amount === null) {
    return null;
  }

  const normalized = {
    source: "hctra_eztag",
    trxnAt,
    postedAt,
    licensePlate: raw?.licensePlate || null,
    licenseState: raw?.licenseState || null,
    licensePlateNormalized: normalizePlate(raw?.licensePlate),
    vehicleNickname: raw?.vehicleNickName || null,
    amount,
    agencyName: raw?.agencyName || null,
    facilityName: raw?.facilityName || null,
    plazaName: raw?.plazaName || null,
    laneName: raw?.laneName || null,
    direction: raw?.direction || null,
    transType: raw?.transType || null,
    rawPayload: raw,
  };

  normalized.externalFingerprint = buildTollFingerprint(normalized);

  return normalized;
}

module.exports = {
  isTollTransaction,
  normalizeTollRecord,
};