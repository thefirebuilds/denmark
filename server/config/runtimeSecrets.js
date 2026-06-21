const fs = require("fs");

function cleanSecret(value) {
  return String(value || "").trim();
}

function getRuntimeSecret(name, fallback = "") {
  const direct = cleanSecret(process.env[name]);
  if (direct) return direct;

  const filePath = cleanSecret(process.env[`${name}_FILE`]);
  if (!filePath) return fallback;

  return cleanSecret(fs.readFileSync(filePath, "utf8")) || fallback;
}

function getRuntimeNumber(name, fallback) {
  const value = Number(getRuntimeSecret(name, ""));
  return Number.isFinite(value) ? value : fallback;
}

module.exports = {
  getRuntimeNumber,
  getRuntimeSecret,
};
