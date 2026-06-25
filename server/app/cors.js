const cors = require("cors");

const defaultCors = cors({
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  credentials: true,
  exposedHeaders: ["Server-Timing", "X-Denmark-Route"],
});

const marketplaceAllowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5000",
  "http://127.0.0.1:5000",
  "https://www.facebook.com",
];

function isMarketplaceExtensionOrigin(origin) {
  if (!origin) return true;
  if (marketplaceAllowedOrigins.includes(origin)) return true;
  return /^chrome-extension:\/\/[a-z0-9]+$/i.test(origin);
}

const marketplaceCors = cors({
  origin(origin, callback) {
    callback(null, isMarketplaceExtensionOrigin(origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Accept",
    "Authorization",
    "X-Service-Token",
    "X-Denmark-Marketplace-Extension",
  ],
  credentials: true,
  optionsSuccessStatus: 204,
});

module.exports = {
  defaultCors,
  isMarketplaceExtensionOrigin,
  marketplaceCors,
};
