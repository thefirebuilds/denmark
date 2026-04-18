const API_BASES = [
  "http://127.0.0.1:5000",
  "http://localhost:5000",
  "http://127.0.0.1:3001",
  "http://localhost:3001",
];

const AUTO_ENRICH_FLAG = "fcg_enrich=1";
const APP_URL_PATTERNS = ["http://localhost/*", "http://127.0.0.1/*"];
const enrichQueueState = {
  pending: [],
  running: false,
  total: 0,
  completed: 0,
  failed: 0,
  currentTabId: null,
  currentUrl: null,
  currentWatchdogTimer: null,
  sourceWindowId: null,
  error: "",
};

async function postJsonWithFallback(path, payload, timeoutMs = 5000) {
  const errors = [];

  for (const base of API_BASES) {
    const url = `${base}${path}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        errors.push(`${url} -> HTTP ${resp.status} ${data?.error || resp.statusText}`);
        continue;
      }

      return { ok: true, base, url, data };
    } catch (err) {
      errors.push(`${url} -> ${err?.message || String(err)}`);
    }
  }

  return { ok: false, errors };
}

function normalizeListingUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    const m = url.pathname.match(/\/marketplace\/item\/(\d+)\//);
    if (m) return `${url.origin}/marketplace/item/${m[1]}/`;
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(u);
  }
}

function buildEnrichUrl(u) {
  const normalized = normalizeListingUrl(u);
  if (!normalized) return null;
  return normalized.includes("#")
    ? `${normalized}&${AUTO_ENRICH_FLAG}`
    : `${normalized}#${AUTO_ENRICH_FLAG}`;
}

function clearCurrentWatchdog() {
  if (!enrichQueueState.currentWatchdogTimer) return;
  clearTimeout(enrichQueueState.currentWatchdogTimer);
  enrichQueueState.currentWatchdogTimer = null;
}

async function finishCurrentEnrichTab(success, tabId = enrichQueueState.currentTabId) {
  clearCurrentWatchdog();

  if (success) {
    enrichQueueState.completed += 1;
    enrichQueueState.currentTabId = null;
    enrichQueueState.currentUrl = null;
    await broadcastQueueStatus();

    if (tabId) {
      chrome.tabs.remove(tabId, () => {
        void openNextEnrichTab();
      });
    } else {
      await openNextEnrichTab();
    }
    return;
  }

  enrichQueueState.failed += 1;
  enrichQueueState.running = false;
  enrichQueueState.error = `Enrich failed for ${enrichQueueState.currentUrl || "current listing"}`;
  enrichQueueState.currentTabId = null;
  enrichQueueState.currentUrl = null;
  await broadcastQueueStatus();
}

async function inspectUnavailableListingTab(tabId) {
  if (!tabId || tabId !== enrichQueueState.currentTabId) return;

  let results = null;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const bodyText = clean(document.body?.innerText || "");
        const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
          .map((node) => clean(node.innerText || ""))
          .filter(Boolean)
          .slice(0, 5);
        const unavailable =
          /This Listing Isn't Available Anymore/i.test(bodyText) ||
          /This Listing Isnt Available Anymore/i.test(bodyText) ||
          /It may have been sold or expired/i.test(bodyText);

        const diagnostic = {
          url: location.href,
          title: document.title,
          unavailable,
          headings,
          bodySample: bodyText.slice(0, 800),
        };
        console.log("[fcg-auto-enrich-background-inspect]", diagnostic);
        return diagnostic;
      },
    });
  } catch (err) {
    console.warn("[fcg-auto-enrich] background inspect failed:", err);
    return;
  }

  const diagnostic = results?.[0]?.result || null;
  console.log("[fcg-auto-enrich] background inspect result:", diagnostic);

  if (!diagnostic?.unavailable) return;

  const ignored = await postJsonWithFallback("/api/marketplace/listings/ignoreByUrl", {
    url: enrichQueueState.currentUrl || diagnostic.url,
  });

  console.log("[fcg-auto-enrich] unavailable ignore result:", ignored);
  await finishCurrentEnrichTab(Boolean(ignored.ok), tabId);
}

function armCurrentTabWatchdog(tabId) {
  clearCurrentWatchdog();
  enrichQueueState.currentWatchdogTimer = setTimeout(() => {
    void inspectUnavailableListingTab(tabId);
  }, 4500);
}

function getQueueStatus() {
  return {
    running: enrichQueueState.running,
    total: enrichQueueState.total,
    completed: enrichQueueState.completed,
    failed: enrichQueueState.failed,
    remaining: enrichQueueState.pending.length,
    currentUrl: enrichQueueState.currentUrl,
    error: enrichQueueState.error,
  };
}

async function broadcastQueueStatus() {
  const tabs = await chrome.tabs.query({ url: APP_URL_PATTERNS });
  const payload = getQueueStatus();
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "fcg-enrich-queue-status",
          payload,
        });
      } catch {}
    })
  );
}

async function openNextEnrichTab() {
  if (!enrichQueueState.running) return;
  if (enrichQueueState.currentTabId) return;

  const nextUrl = enrichQueueState.pending.shift();
  if (!nextUrl) {
    enrichQueueState.running = false;
    enrichQueueState.currentUrl = null;
    await broadcastQueueStatus();
    return;
  }

  enrichQueueState.currentUrl = nextUrl;
  enrichQueueState.error = "";
  await broadcastQueueStatus();

  const tab = await chrome.tabs.create({
    url: buildEnrichUrl(nextUrl),
    active: true,
    windowId: enrichQueueState.sourceWindowId || undefined,
  });

  enrichQueueState.currentTabId = tab.id || null;
  armCurrentTabWatchdog(enrichQueueState.currentTabId);
  await broadcastQueueStatus();
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (apiBases) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      async function postJsonWithFallback(path, payload, timeoutMs = 5000) {
        const errors = [];

        for (const base of apiBases) {
          const url = `${base}${path}`;
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            const resp = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: controller.signal,
            });

            clearTimeout(timer);

            const data = await resp.json().catch(() => null);

            if (!resp.ok) {
              errors.push(`${url} -> HTTP ${resp.status} ${data?.error || resp.statusText}`);
              continue;
            }

            return { ok: true, base, data };
          } catch (err) {
            errors.push(`${url} -> ${err?.message || String(err)}`);
          }
        }

        return { ok: false, errors };
      }

      function normalizeUrl(u) {
        if (!u) return null;
        try {
          const url = new URL(u);
          const m = url.pathname.match(/\/marketplace\/item\/(\d+)\//);
          if (m) return `${url.origin}/marketplace/item/${m[1]}/`;
          return `${url.origin}${url.pathname}`;
        } catch {
          return u;
        }
      }

      const seen = new Set();

      function cleanText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function extractCardTitle(card) {
        const raw = cleanText(card.innerText || "");
        if (!raw) return null;

        const yearTitleMatch = raw.match(
          /\b((?:19|20)\d{2}\s+[A-Za-z0-9][A-Za-z0-9/&.'-]*(?:\s+[A-Za-z0-9][A-Za-z0-9/&.'-]*){0,8})(?=\s+[A-Za-z .'-]+,\s*[A-Z]{2}\b|\s+\d{1,3}(?:,\d{3})?\s*K?\s*miles?\b|$)/i
        );
        if (yearTitleMatch) {
          return cleanText(yearTitleMatch[1]).slice(0, 180);
        }

        let candidate = raw
          .replace(/^\s*just listed\b/i, "")
          .replace(/^\s*\$\s?\d[\d,]*/i, "")
          .replace(/^\s*free\b/i, "")
          .trim();

        candidate = candidate
          .replace(/\b(\d{1,3}(?:,\d{3})*|\d+)\s*k?\s*miles?\b.*$/i, "")
          .replace(/\b[A-Za-z .'-]+,\s*[A-Z]{2}\b.*$/i, "")
          .replace(/\bjust listed\b/i, "")
          .trim();

        if (/^(notifications?|facebook|marketplace)$/i.test(candidate)) return null;
        if (/^just$/i.test(candidate)) return null;
        if (candidate.length < 4) return null;

        return candidate.slice(0, 180);
      }

      function extractCardLocation(card) {
        const raw = cleanText(card.innerText || "");
        if (!raw) return null;

        const cityStateMatch = raw.match(/\b([A-Za-z .'-]+,\s*[A-Z]{2})\b/);
        if (!cityStateMatch) return null;

        return cleanText(cityStateMatch[1]).slice(0, 120);
      }

      function extractListings() {
        const items = [];
        const links = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));

        for (const a of links) {
          let href = a.getAttribute("href") || "";
          if (!href) continue;
          if (href.startsWith("/")) href = "https://www.facebook.com" + href;

          const norm = normalizeUrl(href);
          if (!norm || seen.has(norm)) continue;
          seen.add(norm);

          const card = a.closest('div[role="article"], div') || a;
          const raw = (card.innerText || "").replace(/\s+/g, " ").trim();
          if (!raw) continue;

          const priceMatch = raw.match(/\$\s?\d[\d,]*/);
          const milesMatch = raw.match(/(\d{1,3}(?:,\d{3})*|\d+)\s*K?\s*miles?/i);

          items.push({
            url: norm,
            title: extractCardTitle(card),
            price: priceMatch ? priceMatch[0].replace(/\s+/g, "") : null,
            mileage: milesMatch ? milesMatch[0] : null,
            listed_location: extractCardLocation(card),
            text: raw,
          });
        }

        return items;
      }

      const allByUrl = new Map();

      for (const item of extractListings()) allByUrl.set(item.url, item);

      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, 1600);
        await sleep(900 + Math.floor(Math.random() * 800));
        for (const item of extractListings()) {
          allByUrl.set(item.url, item);
        }
      }

      const results = Array.from(allByUrl.values());

      const payload = {
        url: location.href,
        title: document.title,
        extracted_at: new Date().toISOString(),
        count: results.length,
        results,
      };

      const result = await postJsonWithFallback("/api/marketplace/ingest", payload);

      if (result.ok) {
        const toast = document.createElement("div");
        toast.textContent = `✅ Ingested ${results.length} listings via ${new URL(result.base).host}`;
        toast.style.cssText =
          "position:fixed;top:16px;right:16px;z-index:999999;" +
          "background:#111;color:#fff;padding:10px 12px;border-radius:10px;" +
          "font:14px/1.3 system-ui;box-shadow:0 8px 24px rgba(0,0,0,.35);";
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
        return;
      }

      console.warn("Ingest failed:", result.errors);
    },
    args: [API_BASES],
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "fcg-start-enrich-queue") {
    const urls = Array.isArray(message.urls)
      ? Array.from(
          new Set(
            message.urls
              .map((url) => normalizeListingUrl(url))
              .filter(Boolean)
          )
        )
      : [];

    enrichQueueState.pending = [...urls];
    enrichQueueState.running = urls.length > 0;
    enrichQueueState.total = urls.length;
    enrichQueueState.completed = 0;
    enrichQueueState.failed = 0;
    enrichQueueState.currentTabId = null;
    enrichQueueState.currentUrl = null;
    enrichQueueState.sourceWindowId = sender?.tab?.windowId || null;
    enrichQueueState.error = urls.length ? "" : "No visible listings to enrich";

    void broadcastQueueStatus();
    if (urls.length) {
      void openNextEnrichTab();
    }

    sendResponse?.(getQueueStatus());
    return true;
  }

  if (message?.type === "fcg-auto-enrich-result") {
    const success = Boolean(message.success);
    const senderTabId = sender?.tab?.id;
    if (!senderTabId || senderTabId !== enrichQueueState.currentTabId) {
      sendResponse?.({ ok: false, error: "Sender tab does not match active enrich tab" });
      return true;
    }

    if (success) {
      void finishCurrentEnrichTab(true, senderTabId);
      sendResponse?.({ ok: true });
      return true;
    }

    void finishCurrentEnrichTab(false, senderTabId);
    sendResponse?.({ ok: true, stopped: true });
    return true;
  }

  if (message?.type !== "fcg-close-tab") return undefined;

  if (!sender?.tab?.id) {
    sendResponse?.({ ok: false, error: "No sender tab id" });
    return undefined;
  }

  chrome.tabs.remove(sender.tab.id, () => {
    if (chrome.runtime.lastError) {
      sendResponse?.({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    sendResponse?.({ ok: true });
  });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== enrichQueueState.currentTabId) return;
  clearCurrentWatchdog();
  enrichQueueState.currentTabId = null;
  enrichQueueState.currentUrl = null;
  if (enrichQueueState.running) {
    void openNextEnrichTab();
  }
});
