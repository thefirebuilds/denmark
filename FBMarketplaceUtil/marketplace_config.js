// Customer-facing configuration for the Denmark Facebook Marketplace utility.
//
// Change the first API/app URL to your Denmark tenant. Keep the localhost
// entries if you also use the extension against a local development instance.
globalThis.FCG_MARKETPLACE_CONFIG = {
  apiBases: [
    "https://denmark.freshcoastgarage.com",
    "http://127.0.0.1:5000",
    "http://localhost:5000",
    "http://127.0.0.1:3001",
    "http://localhost:3001",
  ],
  appUrlPatterns: [
    "https://denmark.freshcoastgarage.com/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
  ],
};
