const BANKING_INGESTION_START_DATE = "2026-07-01";

function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function isWithinBankingIngestionWindow(value) {
  const date = toDateOnly(value);
  return Boolean(date && date >= BANKING_INGESTION_START_DATE);
}

function clampBankingStartDate(value) {
  const date = toDateOnly(value);
  return !date || date < BANKING_INGESTION_START_DATE
    ? BANKING_INGESTION_START_DATE
    : date;
}

module.exports = {
  BANKING_INGESTION_START_DATE,
  isWithinBankingIngestionWindow,
  clampBankingStartDate,
};
