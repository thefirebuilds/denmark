const { execFileSync } = require("child_process");
const path = require("path");

function cleanEnv(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") return null;
  return trimmed;
}

function readGitValue(args) {
  const gitCandidates =
    process.platform === "win32"
      ? [
          "git",
          "C:\\Program Files\\Git\\cmd\\git.exe",
          "C:\\Program Files\\Git\\bin\\git.exe",
        ]
      : ["git"];

  for (const gitPath of gitCandidates) {
    try {
      return execFileSync(gitPath, args, {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDeploymentLabel(updatedAt, version) {
  if (!updatedAt) {
    return version ? `updated ${version.slice(0, 7)}` : "code version unknown";
  }

  const updatedLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(updatedAt);

  return `updated ${updatedLabel}`;
}

function getDeploymentInfo() {
  const envCommit = cleanEnv(process.env.DENMARK_BUILD_COMMIT);
  const envTime = cleanEnv(process.env.DENMARK_BUILD_TIME);
  const gitCommit = readGitValue(["rev-parse", "HEAD"]);
  const gitTime = readGitValue(["log", "-1", "--format=%cI"]);

  const version = envCommit || gitCommit || null;
  const updatedAt = normalizeDate(envTime) || normalizeDate(gitTime);

  return {
    codeUpdatedAt: updatedAt ? updatedAt.toISOString() : null,
    codeVersion: version,
    deploymentLabel: formatDeploymentLabel(updatedAt, version),
  };
}

module.exports = {
  getDeploymentInfo,
};
