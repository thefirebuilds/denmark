// denmark/FBCarScraper/content_detail.js

(() => {
  if (!location.pathname.includes("/marketplace/item/")) return;

  const API_BASES = [
    "http://127.0.0.1:5000",
    "http://localhost:5000",
    "http://127.0.0.1:3001",
    "http://localhost:3001",
  ];

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const AUTO_ENRICH_FLAG = "fcg_enrich=1";
  const AUTO_ENRICH_READY_PATTERNS = [
    /Listed\s+.+?\s+in\s+[A-Za-z .'-]+,\s*[A-Z]{2}/i,
    /\b(?:19\d{2}|20\d{2})\s+[A-Za-z0-9][^$]{2,120}?\s+\$\s?\d[\d,]*/i,
    /\$\s?\d[\d,]*/,
  ];
  const UNAVAILABLE_PAGE_PATTERNS = [
    /This Listing Isn't Available Anymore/i,
    /This Listing Isnt Available Anymore/i,
    /It may have been sold or expired/i,
  ];

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

  function toast(msg, ok = true) {
    const el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText =
      "position:fixed;top:16px;right:16px;z-index:999999;" +
      `background:${ok ? "#111" : "#8a1f1f"};color:#fff;` +
      "padding:10px 12px;border-radius:10px;" +
      "font:14px/1.3 system-ui;box-shadow:0 8px 24px rgba(0,0,0,.35);";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ok ? 2500 : 4000);
  }

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

  function extractVin(text = "") {
    const s = String(text).toUpperCase();
    let m = s.match(/\bVIN[:\s]*([A-HJ-NPR-Z0-9]{17})\b/);
    if (m) return m[1];
    m = s.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
    return m ? m[1] : null;
  }

  function clickSeeMore(root) {
    if (!root) return 0;

    let clicked = 0;
    const candidates = root.querySelectorAll("span, a, div, button");

    for (const el of candidates) {
      const txt = (el.innerText || "").trim().toLowerCase();
      if (txt !== "see more" && txt !== "see more…") continue;

      const r = el.getBoundingClientRect?.();
      if (!r || r.width < 6 || r.height < 6) continue;

      try {
        el.click();
        clicked++;
      } catch {}
    }

    return clicked;
  }

  function parseMileageNumber(value) {
    const digits = String(value || "").replace(/[,\s]+/g, "");
    const num = Number(digits);
    return Number.isFinite(num) ? num : null;
  }

  function isAutoEnrichMode() {
    return location.hash.includes(AUTO_ENRICH_FLAG);
  }

  function isUnavailableListingPage(text = "") {
    const normalized = clean(text || document.body?.innerText || "");
    if (!normalized) return false;
    return UNAVAILABLE_PAGE_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  function logAutoEnrichDiagnostics(stage, extra = {}) {
    const bodyText = clean(document.body?.innerText || "");
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => clean(node.innerText || ""))
      .filter(Boolean)
      .slice(0, 5);

    console.log(`[fcg-auto-enrich] ${stage}`, {
      url: normalizeUrl(location.href),
      hash: location.hash,
      title: document.title,
      unavailableDetected: isUnavailableListingPage(bodyText),
      headingSample: headings,
      bodySample: bodyText.slice(0, 600),
      ...extra,
    });
  }

  function extractDetailTitle(doc, rawText) {
    const directCandidates = [
      doc.querySelector("h1")?.innerText,
      doc.querySelector('meta[property="og:title"]')?.getAttribute("content"),
      doc.title?.replace(/\s*\|\s*Facebook.*$/i, ""),
    ]
      .map((value) => clean(value))
      .filter(Boolean);

    for (const candidate of directCandidates) {
      if (/^(notifications?|facebook|marketplace)$/i.test(candidate)) continue;
      if (candidate.length > 180) continue;
      return candidate;
    }

    const lineCandidates = String(rawText || "")
      .split("\n")
      .map((line) => clean(line))
      .filter(Boolean);

    for (const line of lineCandidates) {
      if (/^\$\s?\d/i.test(line)) continue;
      if (/^\d{1,3}(?:[,\s]\d{3})?\s*k?\s*miles?$/i.test(line)) continue;
      if (/^(listed|seller's description|seller information|description|send seller a message)\b/i.test(line)) continue;
      if (/^(notifications?|facebook|marketplace)$/i.test(line)) continue;
      if (line.length < 4 || line.length > 180) continue;
      return line;
    }

    return null;
  }

  function isolateListingText(rawText) {
    const flattened = clean(rawText);
    if (!flattened) {
      return { listingText: "", flattenedText: "" };
    }

    const startPatterns = [
      /\b(?:19\d{2}|20\d{2})\s+[A-Za-z0-9][^$]{2,120}?\s+\$\s?\d[\d,]*/i,
      /\$\s?\d[\d,]*\s+Listed\s+.+?\s+in\s+[A-Za-z .'-]+,\s*[A-Z]{2}/i,
      /\bListed\s+.+?\s+in\s+[A-Za-z .'-]+,\s*[A-Z]{2}/i,
    ];

    let startIdx = -1;
    for (const pattern of startPatterns) {
      const match = flattened.match(pattern);
      if (match && typeof match.index === "number") {
        startIdx = match.index;
        break;
      }
    }

    const working = startIdx >= 0 ? flattened.slice(startIdx) : flattened;
    const lower = working.toLowerCase();
    const endMarkers = [
      "today's picks",
      "todays picks",
      "send seller a message",
      "buy and sell groups",
      "marketplace access",
      "browse all notifications",
      "create multiple listings",
    ];

    let endIdx = working.length;
    for (const marker of endMarkers) {
      const idx = lower.indexOf(marker);
      if (idx !== -1) endIdx = Math.min(endIdx, idx);
    }

    return {
      listingText: clean(working.slice(0, endIdx)),
      flattenedText: flattened,
    };
  }

  function extractTitleFromListingText(listingText) {
    const text = clean(listingText);
    if (!text) return null;

    const pricedTitleMatch = text.match(
      /\b((?:19|20)\d{2}\s+[A-Za-z0-9][A-Za-z0-9/&.'-]*(?:\s+[A-Za-z0-9][A-Za-z0-9/&.'-]*){0,8})\s+\$\s?\d[\d,]*/i
    );
    if (pricedTitleMatch) return clean(pricedTitleMatch[1]);

    const lineTitleMatch = text.match(
      /\b((?:19|20)\d{2}\s+[A-Za-z0-9][^$]{2,120}?)(?:\s+Listed\b|\s+\$\s?\d)/i
    );
    if (lineTitleMatch) return clean(lineTitleMatch[1]);

    return null;
  }

  function extractListedMetadata(rawText, flattenedText) {
    const lines = String(rawText || "")
      .split("\n")
      .map((line) => clean(line))
      .filter(Boolean);

    const listedLine = lines.find((line) => /^listed\b/i.test(line));
    const source = listedLine || String(flattenedText || "");
    const match = source.match(/Listed\s+(.*?)\s+in\s+(.+)/i);

    if (!match) {
      return {
        listed_ago: null,
        listed_location: null,
      };
    }

    const listed_ago = clean(match[1]);
    const listed_location = clean(
      match[2]
        .split(
          /\s+(?:Message|About this vehicle|Driven\b|Automatic transmission|Location is approximate|Seller information|Seller details)\b/i
        )[0]
    );

    return {
      listed_ago: listed_ago || null,
      listed_location: listed_location || null,
    };
  }

  async function expandPage() {
    for (let i = 0; i < 4; i++) {
      clickSeeMore(document.body);
      await sleep(400);
    }
  }

  function hasEnoughDetailText() {
    const text = clean(document.body?.innerText || "");
    if (!text) return false;
    if (isUnavailableListingPage(text)) {
      if (isAutoEnrichMode()) {
        logAutoEnrichDiagnostics("unavailable-page-detected-in-ready-check");
      }
      return true;
    }
    return AUTO_ENRICH_READY_PATTERNS.some((pattern) => pattern.test(text));
  }

  async function waitForListingReady(timeoutMs = 4500) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (hasEnoughDetailText()) return true;
      await sleep(150);
    }
    const ready = hasEnoughDetailText();
    if (isAutoEnrichMode()) {
      logAutoEnrichDiagnostics("ready-timeout", {
        ready,
        timeoutMs,
      });
    }
    return ready;
  }

  function stopExtraPageLoading() {
    try {
      window.stop();
    } catch {}
  }

  async function scrapeDetail() {
    if (isAutoEnrichMode()) {
      await waitForListingReady();
      stopExtraPageLoading();
      clickSeeMore(document.body);
      await sleep(150);
    } else {
      await expandPage();
    }

    const bodyText = document.body?.innerText || "";
    const text = clean(bodyText);
    const { listingText, flattenedText } = isolateListingText(bodyText);
    const extractionText = listingText || text;
    const title =
      extractTitleFromListingText(extractionText) ||
      extractDetailTitle(document, listingText || bodyText);

    const priceMatch = extractionText.match(/\$\s?\d[\d,]*/);
    const price = priceMatch ? priceMatch[0].replace(/\s+/g, "") : null;

    const { listed_ago, listed_location } = extractListedMetadata(
      listingText || bodyText,
      extractionText
    );

    const drivenMatch = extractionText.match(/(\d{1,3}(?:[,\s]\d{3})*|\d+)\s+miles?/i);
    const driven_miles = drivenMatch ? parseMileageNumber(drivenMatch[1]) : null;

    const transmissionMatch = extractionText.match(/\b(Automatic|Manual)\s+transmission\b/i);
    const transmission = transmissionMatch ? transmissionMatch[1].toLowerCase() : null;

    const colorsMatch = extractionText.match(
      /Exterior color:\s*([^·\n]+)\s*·\s*Interior color:\s*([^\n]+)/i
    );
    const exterior_color = colorsMatch ? clean(colorsMatch[1]) : null;
    const interior_color = colorsMatch ? clean(colorsMatch[2]) : null;

    const nhtsaMatch = extractionText.match(/(\d)\/5\s+overall\s+NHTSA\s+safety\s+rating/i);
    const nhtsa_rating_overall = nhtsaMatch ? Number(nhtsaMatch[1]) : null;

    const fuelMatch = extractionText.match(/Fuel type:\s*([A-Za-z]+)/i);
    const fuel_type = fuelMatch ? clean(fuelMatch[1]) : null;

    const ownersMatch = extractionText.match(/\b(\d+)\s+owner(s)?\b/i);
    const owners = ownersMatch ? Number(ownersMatch[1]) : null;

    const paid_off = /\bpaid off\b/i.test(extractionText) ? true : null;

    const sellerNameMatch = extractionText.match(
      /Seller (?:information|details)\s+([A-Za-z .'-]+)\s+Joined Facebook in\s+(\d{4})/i
    );
    const seller_name = sellerNameMatch ? clean(sellerNameMatch[1]) : null;
    const seller_joined_year = sellerNameMatch ? Number(sellerNameMatch[2]) : null;

    let seller_description = null;
    const idx = extractionText.toLowerCase().indexOf("seller's description");
    if (idx !== -1) {
      const slice = extractionText.slice(idx);
      const sliceLower = slice.toLowerCase();
      const endMarkers = [
        "seller information",
        "seller details",
        "comment as",
        "send seller a message",
      ];

      let endIdx = -1;
      for (const m of endMarkers) {
        const j = sliceLower.indexOf(m);
        if (j !== -1) endIdx = endIdx === -1 ? j : Math.min(endIdx, j);
      }

      const descBlock = endIdx !== -1 ? slice.slice(0, endIdx) : slice;
      seller_description = clean(descBlock.replace(/seller's description/i, ""));
      if (seller_description && seller_description.length > 1600) {
        seller_description = seller_description.slice(0, 1600) + "…";
      }
    }

    const vin = extractVin(seller_description || "") || extractVin(extractionText);

    const keywords = [];
    const pushIf = (cond, kw) => {
      if (cond && !keywords.includes(kw)) keywords.push(kw);
    };

    const kwText = [extractionText, seller_description].filter(Boolean).join(" ");

    pushIf(/\bclean title\b/i.test(extractionText), "clean_title");
    pushIf(/\bsalvage\b/i.test(extractionText), "salvage");
    pushIf(/\brebuilt\b/i.test(extractionText), "rebuilt");
    pushIf(/\bdown payment\b/i.test(kwText), "down_payment");
    pushIf(/\bfinance\b|\bfinancing\b|\bcredito\b|\bcr[eé]dito\b/i.test(kwText), "financing");
    pushIf(/\bpaid off\b/i.test(kwText), "paid_off");
    pushIf(/\bcarfax\b/i.test(kwText), "carfax");
    pushIf(/\btitle\b/i.test(kwText), "title_mentioned");

    return {
      url: normalizeUrl(location.href),
      scraped_at: new Date().toISOString(),
      title,
      price,
      listed_ago,
      listed_location,
      vin,
      about: {
        driven_miles,
        transmission,
        exterior_color,
        interior_color,
        fuel_type,
        owners,
        paid_off,
        nhtsa_rating_overall,
      },
      seller: {
        name: seller_name,
        joined_year: seller_joined_year,
      },
      seller_description,
      keywords,
      raw_text_sample: (listingText || flattenedText).slice(0, 800),
    };
  }

  function downloadJson(payload, filenamePrefix = "marketplace_detail") {
    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const safeName = filenamePrefix.replace(/[^\w\-]+/g, "_").slice(0, 60);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName}.json`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  async function ignoreListing() {
    const url = normalizeUrl(location.href);
    if (!url) {
      toast("⚠️ Could not normalize listing URL", false);
      return false;
    }

    const result = await postJsonWithFallback(
      "/api/marketplace/listings/ignoreByUrl",
      { url }
    );

    if (!result.ok) {
      console.warn("[ignore] failed:", result.errors);
      toast("⚠️ Ignore failed", false);
      return false;
    }

    toast(`✅ Ignored via ${new URL(result.base).host}`);
    console.log("[ignore] ok:", result.data);
    return true;
  }

  async function enrichListing() {
    try {
      if (isUnavailableListingPage()) {
        logAutoEnrichDiagnostics("unavailable-page-before-ignore");
        const ignored = await ignoreListing();
        logAutoEnrichDiagnostics("unavailable-page-ignore-result", { ignored });
        if (!ignored) return false;
        toast("âœ… Unavailable listing ignored");
        return true;
      }

      const payload = await scrapeDetail();
      if (isAutoEnrichMode()) {
        logAutoEnrichDiagnostics("scrape-detail-payload-ready", {
          payloadTitle: payload?.title || null,
          payloadLocation: payload?.listed_location || null,
          payloadPrice: payload?.price || null,
        });
      }
      console.log("=== MARKETPLACE DETAIL ENRICH PAYLOAD ===");
      console.log(JSON.stringify(payload, null, 2));

      const result = await postJsonWithFallback("/api/marketplace/enrich", payload);

      if (!result.ok) {
        console.warn("[enrich] all targets failed:", result.errors);
        downloadJson(payload, "marketplace_detail_enrich_fallback");
        toast("⚠️ Enrich failed; downloaded JSON instead", false);
        return false;
      }

      toast(`✅ Listing enriched via ${new URL(result.base).host}`);
      console.log("[enrich] ok:", result.data);
      return true;
    } catch (e) {
      console.warn("[enrich] failed:", e);
      toast(`⚠️ Enrich failed: ${e?.message || e}`, false);
    }
  }

  async function maybeAutoEnrich() {
    if (!location.hash.includes(AUTO_ENRICH_FLAG)) return;

    const key = `fcg_auto_enrich:${normalizeUrl(location.href)}`;
    if (sessionStorage.getItem(key) === "done") return;

    sessionStorage.setItem(key, "done");

    await waitForListingReady(5000);
    stopExtraPageLoading();
    await sleep(250);
    const ok = await enrichListing();

    const cleanHash = location.hash
      .replace(AUTO_ENRICH_FLAG, "")
      .replace(/^#&?/, "#")
      .replace(/&&+/g, "&")
      .replace(/#$/, "");

    history.replaceState(null, "", `${location.pathname}${location.search}${cleanHash}`);

    try {
      await chrome.runtime.sendMessage({
        type: "fcg-auto-enrich-result",
        success: ok,
      });
    } catch (err) {
      console.warn("[auto-enrich] result notify failed:", err);
    }
  }

  function ensureButtons() {
    if (!document.getElementById("fcg-enrich-btn")) {
      const btn = document.createElement("button");
      btn.id = "fcg-enrich-btn";
      btn.textContent = "📌 Enrich → DB";
      btn.style.cssText =
        "position:fixed;top:64px;right:16px;z-index:999999;" +
        "background:#2563eb;color:#fff;border:0;border-radius:12px;" +
        "padding:10px 12px;cursor:pointer;" +
        "font:600 14px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.25);";

      btn.addEventListener("click", async () => {
        const old = btn.textContent;
        btn.disabled = true;
        btn.style.opacity = "0.75";
        btn.textContent = "⏳ Enriching...";
        try {
          await enrichListing();
        } finally {
          btn.disabled = false;
          btn.style.opacity = "1";
          btn.textContent = old;
        }
      });

      document.body.appendChild(btn);
    }

    if (!document.getElementById("fcg-ignore-btn")) {
      const btn = document.createElement("button");
      btn.id = "fcg-ignore-btn";
      btn.textContent = "🙈 Ignore (hide)";
      btn.style.cssText =
        "position:fixed;top:64px;right:170px;z-index:999999;" +
        "background:#444;color:#fff;border:0;border-radius:12px;" +
        "padding:10px 12px;cursor:pointer;" +
        "font:600 14px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.25);";

      btn.addEventListener("click", async () => {
        const old = btn.textContent;
        btn.disabled = true;
        btn.style.opacity = "0.75";
        btn.textContent = "⏳ Ignoring...";
        try {
          await ignoreListing();
        } finally {
          btn.disabled = false;
          btn.style.opacity = "1";
          btn.textContent = old;
        }
      });

      document.body.appendChild(btn);
    }
  }

  ensureButtons();
  const obs = new MutationObserver(() => ensureButtons());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  void maybeAutoEnrich();

  console.log("[content_detail] loaded for", normalizeUrl(location.href));
})();
