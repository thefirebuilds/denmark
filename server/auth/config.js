function isTruthy(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === "true";
}

function isAuthEnforced() {
  if (String(process.env.AUTH_ENFORCED || "").trim() !== "") {
    return isTruthy(process.env.AUTH_ENFORCED);
  }

  return process.env.NODE_ENV === "production";
}

module.exports = {
  isAuthEnforced,
};
