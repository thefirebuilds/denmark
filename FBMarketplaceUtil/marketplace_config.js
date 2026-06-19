// Customer-facing configuration for the Denmark Facebook Marketplace utility.
//
// Set this to the Denmark tenant this extension should write to.
// Keep one apiBases entry for normal use. Add localhost entries only when you
// intentionally want fallback writes to a local development tenant.
globalThis.FCG_MARKETPLACE_CONFIG = {
  apiBases: [
    "https://denmark.freshcoastgarage.com",
    // "http://127.0.0.1:5000",
    // "http://localhost:5000",
    // "http://127.0.0.1:3001",
    // "http://localhost:3001",
  ],
  appUrlPatterns: [
    "https://denmark.freshcoastgarage.com/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
  ],
};
