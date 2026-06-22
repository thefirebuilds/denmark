(() => {
  const DEFAULT_APP_URL_PATTERNS = [
    "https://denmark.freshcoastgarage.com/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
  ];
  const MARKETPLACE_CONFIG = window.FCG_MARKETPLACE_CONFIG || {};
  const APP_URL_PATTERNS = Array.isArray(MARKETPLACE_CONFIG.appUrlPatterns)
    ? MARKETPLACE_CONFIG.appUrlPatterns
    : DEFAULT_APP_URL_PATTERNS;
  const START_EVENT = "fcg-marketplace-enrich-visible";
  const STATUS_EVENT = "fcg-marketplace-enrich-status";
  const READY_EVENT = "fcg-marketplace-extension-ready";
  const STATUS_REQUEST_EVENT = "fcg-marketplace-enrich-status-request";
  const READY_ATTR = "data-fcg-marketplace-extension-ready";

  function escapeRegex(value) {
    return String(value).replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }

  function matchesPattern(url, pattern) {
    const source = String(pattern || "").trim();
    if (!source) return false;

    const regex = new RegExp(`^${escapeRegex(source).replace(/\*/g, ".*")}$`);
    return regex.test(url);
  }

  if (!APP_URL_PATTERNS.some((pattern) => matchesPattern(location.href, pattern))) {
    return;
  }

  function emitStatus(detail) {
    window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail }));
  }

  document.documentElement.setAttribute(READY_ATTR, "1");
  window.dispatchEvent(new CustomEvent(READY_EVENT));

  window.addEventListener(START_EVENT, async (event) => {
    const urls = Array.isArray(event.detail?.urls) ? event.detail.urls : [];
    const minDelayMs = Number(event.detail?.minDelayMs || 0);
    const maxDelayMs = Number(event.detail?.maxDelayMs || minDelayMs || 0);
    const availabilityOnly = Boolean(event.detail?.availabilityOnly);
    emitStatus({
      running: urls.length > 0,
      total: urls.length,
      completed: 0,
      failed: 0,
      remaining: urls.length,
      phase: "bridge",
      error: urls.length ? "" : "No visible listings to enrich",
      updatedAt: Date.now(),
    });

    try {
      const response = await chrome.runtime.sendMessage({
        type: "fcg-start-enrich-queue",
        urls,
        minDelayMs,
        maxDelayMs,
        availabilityOnly,
      });
      if (response) emitStatus(response);
    } catch (err) {
      emitStatus({
        running: false,
        total: urls.length,
        completed: 0,
        failed: 0,
        error: err?.message || String(err),
      });
    }
  });

  window.addEventListener(STATUS_REQUEST_EVENT, async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "fcg-get-enrich-queue-status",
      });
      if (response) emitStatus(response);
    } catch (err) {
      emitStatus({
        running: false,
        total: 0,
        completed: 0,
        failed: 0,
        error: err?.message || String(err),
      });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "fcg-enrich-queue-status") return;
    emitStatus(message.payload);
  });
})();
