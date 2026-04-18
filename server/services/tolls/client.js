const { loginAndCreatePage } = require("./session");

const ACCOUNT_ACTIVITY_URL = "https://www.hctra.org/AccountActivity";

async function fetchTollTransactions() {
  const { browser, page } = await loginAndCreatePage();

  try {
    page.on("response", async (resp) => {
      if (resp.url().includes("/api/sessions/AccountActivity/SearchAccountActivity")) {
        console.log("EZTAG browser response:", resp.status(), resp.url());
      }
    });

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/sessions/AccountActivity/SearchAccountActivity"),
      { timeout: 30000 }
    );

    await page.goto(ACCOUNT_ACTIVITY_URL, { waitUntil: "networkidle" });

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
      records: json.records,
      requestPayload: null,
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  fetchTollTransactions,
};