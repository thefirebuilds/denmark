const { chromium } = require("playwright");

const EZTAG_TIMEOUT_MS = Number(process.env.EZTAG_TIMEOUT_MS || 45000);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

async function loginAndCreatePage(settings = {}) {
  const username = settings.username || requireEnv("EZTAG_USERNAME");
  const password = settings.password || requireEnv("EZTAG_PASSWORD");
  const loginUrl = settings.loginUrl || "https://www.hctra.org/Login";
  const homeUrl = settings.homeUrl || "https://www.hctra.org/";
  const timeoutMs = Number(settings.timeoutMs || EZTAG_TIMEOUT_MS);

  console.log("[tolls:hctra] launching browser");
  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
      userAgent:
      settings.userAgent ||
      process.env.EZTAG_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    console.log("[tolls:hctra] opening login page");
    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    await page
      .locator(
        'input[type="email"], input[name*="user"], input[id*="user"], input[name*="email"], input[id*="email"]'
      )
      .first()
      .fill(username);

    await page
      .locator('input[type="password"], input[name*="pass"], input[id*="pass"]')
      .first()
      .fill(password);

    console.log("[tolls:hctra] submitting login");
    await page
      .locator(
        'button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In")'
      )
      .first()
      .click({ timeout: timeoutMs });

    await page.waitForLoadState("domcontentloaded", {
      timeout: timeoutMs,
    }).catch(() => null);

    console.log("[tolls:hctra] opening account home");
    await page.goto(homeUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    return { browser, context, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

module.exports = {
  loginAndCreatePage,
};
