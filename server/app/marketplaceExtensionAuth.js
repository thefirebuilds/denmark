const { requireMethodPermissions } = require("../auth/middleware");
const { isMarketplaceExtensionOrigin } = require("./cors");

const marketplaceExtensionWritePaths = new Set([
  "/enrich",
  "/ingest",
  "/listings/ignoreByUrl",
]);

function isMarketplaceExtensionWriteRequest(req) {
  const extensionHeader = String(
    req.get("x-denmark-marketplace-extension") || ""
  ).trim();
  const origin = String(req.get("origin") || "").trim();
  const originalPath = String(req.originalUrl || "").split("?")[0];
  const mountedPath = String(req.path || "").split("?")[0];
  const marketplacePath =
    originalPath.replace(/^\/api\/marketplace/i, "") || mountedPath;
  const hasExtensionMarker = extensionHeader === "1";
  const hasLegacyExtensionOrigin =
    origin === "https://www.facebook.com" ||
    /^chrome-extension:\/\/[a-z0-9]+$/i.test(origin);

  return (
    req.method === "POST" &&
    (marketplaceExtensionWritePaths.has(mountedPath) ||
      marketplaceExtensionWritePaths.has(marketplacePath)) &&
    (hasExtensionMarker || hasLegacyExtensionOrigin) &&
    isMarketplaceExtensionOrigin(origin)
  );
}

function allowMarketplaceExtensionWrite(req, res, next) {
  if (isMarketplaceExtensionWriteRequest(req)) {
    req.auth = {
      kind: "marketplace_extension",
      role: "owner",
      permissions: ["*"],
      isActive: true,
    };
  }

  return next();
}

function requireMarketplacePermissions(req, res, next) {
  if (isMarketplaceExtensionWriteRequest(req)) return next();
  return requireMethodPermissions({
    GET: "marketplace.read",
    POST: "marketplace.write",
    PUT: "marketplace.write",
    PATCH: "marketplace.write",
  })(req, res, next);
}

module.exports = {
  allowMarketplaceExtensionWrite,
  isMarketplaceExtensionWriteRequest,
  requireMarketplacePermissions,
};
