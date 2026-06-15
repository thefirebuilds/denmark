function isTruthy(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === "true";
}

function readAuthEnforcedValue() {
  const configured = String(process.env.AUTH_ENFORCED || "").trim();
  if (configured !== "") return configured;

  const misspelled = String(process.env.AUTH_ENCORCED || "").trim();
  if (misspelled !== "") {
    console.warn(
      "[auth] AUTH_ENCORCED is misspelled; please rename it to AUTH_ENFORCED"
    );
    return misspelled;
  }

  return "";
}

function isAuthEnforced() {
  const configured = readAuthEnforcedValue();
  if (configured !== "") {
    return isTruthy(configured);
  }

  return process.env.NODE_ENV === "production";
}

module.exports = {
  isAuthEnforced,
};
