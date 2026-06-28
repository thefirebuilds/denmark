const { loginAndCreatePage } = require("./session");

const EZTAG_TIMEOUT_MS = Number(process.env.EZTAG_TIMEOUT_MS || 45000);

function filterRecordsByLookback(records, lookbackDays) {
  const days = Number(lookbackDays);
  if (!Number.isFinite(days) || days <= 0) return records;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return records.filter((record) => {
    const value = new Date(record?.trxnDate || record?.transactionDate || 0).getTime();
    return !Number.isFinite(value) || value >= cutoff;
  });
}

async function fetchTollTransactions(settings = {}) {
  const { browser, page } = await loginAndCreatePage(settings);
  const activityUrl = settings.activityUrl || "https://www.hctra.org/AccountActivity";
  const activityApiPattern =
    settings.activityApiPattern ||
    "/api/sessions/AccountActivity/SearchAccountActivity";
  const timeoutMs = Number(settings.timeoutMs || EZTAG_TIMEOUT_MS);

  try {
    page.on("response", async (resp) => {
      if (resp.url().includes(activityApiPattern)) {
        console.log("EZTAG browser response:", resp.status(), resp.url());
      }
    });

    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(activityApiPattern),
      { timeout: timeoutMs }
    );

    console.log("[tolls:hctra] opening account activity");
    await page.goto(activityUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const response = await responsePromise;
    const status = response.status();
    const text = await response.text();

    if (!response.ok()) {
      throw new Error(
        `EZTAG browser response failed: ${status} ${String(text || "").slice(0, 500)}`
      );
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `EZTAG browser response was not JSON: ${String(text || "").slice(0, 500)}`
      );
    }

    if (!Array.isArray(json?.records)) {
      throw new Error(
        `EZTAG browser response missing records[]: ${JSON.stringify(json).slice(0, 500)}`
      );
    }

    return {
      payload: json,
      records: filterRecordsByLookback(json.records, settings.lookbackDays),
      recordsUnfiltered: json.records.length,
      requestPayload: null,
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  fetchTollTransactions,
  filterRecordsByLookback,
};
