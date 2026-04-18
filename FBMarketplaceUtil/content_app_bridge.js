(() => {
  const START_EVENT = "fcg-marketplace-enrich-visible";
  const STATUS_EVENT = "fcg-marketplace-enrich-status";
  const READY_EVENT = "fcg-marketplace-extension-ready";
  const READY_ATTR = "data-fcg-marketplace-extension-ready";

  function emitStatus(detail) {
    window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail }));
  }

  document.documentElement.setAttribute(READY_ATTR, "1");
  window.dispatchEvent(new CustomEvent(READY_EVENT));

  window.addEventListener(START_EVENT, async (event) => {
    const urls = Array.isArray(event.detail?.urls) ? event.detail.urls : [];
    try {
      const response = await chrome.runtime.sendMessage({
        type: "fcg-start-enrich-queue",
        urls,
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

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "fcg-enrich-queue-status") return;
    emitStatus(message.payload);
  });
})();
