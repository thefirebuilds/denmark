const originalEmitWarning = process.emitWarning.bind(process);

function isDeprecatedPunycodeWarning(warning, type, code) {
  if (code === "DEP0040") {
    return true;
  }

  if (warning && typeof warning === "object" && warning.code === "DEP0040") {
    return true;
  }

  const message =
    typeof warning === "string" ? warning : warning && warning.message;

  return (
    type === "DeprecationWarning" &&
    typeof message === "string" &&
    message.includes("`punycode` module is deprecated")
  );
}

process.emitWarning = function emitWarningWithoutPunycodeNoise(
  warning,
  type,
  code,
  ...args
) {
  if (isDeprecatedPunycodeWarning(warning, type, code)) {
    return;
  }

  return originalEmitWarning(warning, type, code, ...args);
};
