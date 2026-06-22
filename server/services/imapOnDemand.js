const pollImap = require("./imapPoller");
const { isIntegrationEnabled } = require("./integrations/integrationSettings");

const DEFAULT_DEBOUNCE_MS = 90 * 1000;

let pollInProgress = false;
let lastStartedAt = 0;
let queuedReason = null;

async function runOnDemandPoll(reason = "on-demand") {
  if (!(await isIntegrationEnabled("imap"))) {
    console.log(`[imap:on-demand] skipped | reason=${reason} enabled=false`);
    return { skipped: true, reason: "disabled" };
  }

  if (pollInProgress) {
    queuedReason = reason;
    console.log(`[imap:on-demand] queued | reason=${reason} alreadyRunning=true`);
    return { skipped: true, queued: true, reason: "already_running" };
  }

  pollInProgress = true;
  lastStartedAt = Date.now();
  const startedAt = Date.now();

  try {
    console.log(`[imap:on-demand] start | reason=${reason}`);
    await pollImap();
    return { ok: true };
  } catch (err) {
    console.error(`[imap:on-demand] failed | reason=${reason} error=${err.message || err}`);
    return { ok: false, error: err.message || String(err) };
  } finally {
    console.log(
      `[imap:on-demand] done | reason=${reason} durationMs=${Date.now() - startedAt}`
    );
    pollInProgress = false;

    const followUpReason = queuedReason;
    queuedReason = null;
    if (followUpReason) {
      setTimeout(() => {
        void runOnDemandPoll(`${followUpReason}:queued`);
      }, 1000);
    }
  }
}

function triggerImapPoll(reason = "on-demand", options = {}) {
  const debounceMs = Number(options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const now = Date.now();

  if (pollInProgress) {
    queuedReason = reason;
    return { queued: true, reason: "already_running" };
  }

  if (debounceMs > 0 && lastStartedAt && now - lastStartedAt < debounceMs) {
    return { skipped: true, reason: "debounced" };
  }

  setTimeout(() => {
    void runOnDemandPoll(reason);
  }, Number(options.delayMs || 0));

  return { queued: true, reason: "scheduled" };
}

module.exports = {
  triggerImapPoll,
  runOnDemandPoll,
};
