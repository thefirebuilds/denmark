const DEFAULT_VEHICLE_PRIVILEGES = [1, 3, 4, 5, 6, 8];
// 1 = all-time, non-location data
// 3 = current location
// 4 = all-time location
// 5 = view VIN credentials
// 6 = live data streams
// 8 = approximate location
//
// Adjust this if you want less access by default.
// IMPORTANT: requesting a privilege here does not grant it by magic.
// The vehicle owner must have actually shared that permission with your app in DIMO.

let dimoModulePromise = null;
let developerJwtCache = null;

// cache key must include tokenId + privilege set, not just tokenId
const vehicleJwtCache = new Map();

const DEVELOPER_JWT_CACHE_MS = 8 * 60 * 1000;
const VEHICLE_JWT_CACHE_MS = 8 * 60 * 1000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function normalizeTokenId(tokenId) {
  const numericTokenId = Number(tokenId);

  if (!Number.isInteger(numericTokenId) || numericTokenId <= 0) {
    throw new Error(`Invalid DIMO tokenId: ${tokenId}`);
  }

  return numericTokenId;
}

function normalizePrivileges(privileges) {
  const list = Array.isArray(privileges) && privileges.length
    ? privileges
    : DEFAULT_VEHICLE_PRIVILEGES;

  const normalized = [...new Set(
    list.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
  )].sort((a, b) => a - b);

  if (!normalized.length) {
    throw new Error("At least one DIMO vehicle privilege must be requested");
  }

  return normalized;
}

function getVehicleJwtCacheKey(tokenId, privileges) {
  return Array.isArray(privileges) && privileges.length
    ? `${tokenId}:${privileges.join(",")}`
    : `${tokenId}:granted`;
}

async function getDimoModule() {
  if (!dimoModulePromise) {
    dimoModulePromise = import("@dimo-network/data-sdk");
  }
  return dimoModulePromise;
}

async function getDimoSdk() {
  const mod = await getDimoModule();
  const DIMO = mod.DIMO || mod.default?.DIMO || mod.default;

  if (!DIMO) {
    throw new Error("Could not load DIMO SDK export");
  }

  return new DIMO("Production");
}

function getCached(cacheEntry) {
  if (!cacheEntry || cacheEntry.expiresAt <= Date.now()) return null;
  return cacheEntry.value;
}

async function getDimoDeveloperJwt({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = getCached(developerJwtCache);
    if (cached) return cached;
  }

  const dimo = await getDimoSdk();
  const developerJwt = await dimo.auth.getDeveloperJwt({
    client_id: requireEnv("DIMO_CLIENT_ID"),
    domain: requireEnv("DIMO_REDIRECT_URL"),
    private_key: requireEnv("DIMO_API_KEY"),
  });

  developerJwtCache = {
    value: developerJwt,
    expiresAt: Date.now() + DEVELOPER_JWT_CACHE_MS,
  };

  return developerJwt;
}

async function getDimoVehicleJwt(
  tokenId,
  {
    forceRefresh = false,
    privileges = null,
  } = {}
) {
  const numericTokenId = normalizeTokenId(tokenId);
  const normalizedPrivileges = Array.isArray(privileges) && privileges.length
    ? normalizePrivileges(privileges)
    : null;
  const cacheKey = getVehicleJwtCacheKey(numericTokenId, normalizedPrivileges);

  if (!forceRefresh) {
    const cached = getCached(vehicleJwtCache.get(cacheKey));
    if (cached) return cached;
  }

  const dimo = await getDimoSdk();
  const developerJwt = await getDimoDeveloperJwt({ forceRefresh });

  const vehicleJwt = normalizedPrivileges
    ? await dimo.tokenexchange.exchange({
        ...developerJwt,
        tokenId: numericTokenId,
        privileges: normalizedPrivileges,
      })
    : await dimo.tokenexchange.getVehicleJwt({
        ...developerJwt,
        tokenId: numericTokenId,
      });

  vehicleJwtCache.set(cacheKey, {
    value: vehicleJwt,
    expiresAt: Date.now() + VEHICLE_JWT_CACHE_MS,
  });

  return vehicleJwt;
}

async function getDimoDeveloperAuthHeader(options = {}) {
  const developerJwt = await getDimoDeveloperJwt(options);
  const authHeader = developerJwt?.headers?.Authorization;

  if (!authHeader) {
    throw new Error("DIMO developer JWT missing Authorization header");
  }

  return authHeader;
}

async function getDimoVehicleAuthHeader(tokenId, options = {}) {
  const vehicleJwt = await getDimoVehicleJwt(tokenId, options);
  const authHeader = vehicleJwt?.headers?.Authorization;

  if (!authHeader) {
    throw new Error(
      `DIMO vehicle JWT missing Authorization header for tokenId=${tokenId}`
    );
  }

  return authHeader;
}

function clearDimoAuthCache() {
  developerJwtCache = null;
  vehicleJwtCache.clear();
}

module.exports = {
  clearDimoAuthCache,
  getDimoDeveloperJwt,
  getDimoVehicleJwt,
  getDimoVehicleAuthHeader,
  getDimoDeveloperAuthHeader,
  DEFAULT_VEHICLE_PRIVILEGES,
};
