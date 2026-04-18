const { chromium } = require("playwright");

const LOGIN_URL = "https://www.hctra.org/Login";
const HOME_URL = "https://www.hctra.org/";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

async function loginAndCreatePage() {
  const username = requireEnv("EZTAG_USERNAME");
  const password = requireEnv("EZTAG_PASSWORD");

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    userAgent:
      process.env.EZTAG_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

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

    await Promise.all([
      page.waitForLoadState("networkidle"),
      page
        .locator(
          'button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In")'
        )
        .first()
        .click(),
    ]);

    await page.goto(HOME_URL, { waitUntil: "networkidle" });

    return { browser, context, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

module.exports = {
  loginAndCreatePage,
};