const {
  getDimoVehicleAuthHeader,
  getDimoDeveloperAuthHeader,
} = require("./auth");

const TELEMETRY_URL = "https://telemetry-api.dimo.zone/query";
const IDENTITY_URL = "https://identity-api.dimo.zone/query";

const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;
const COORDINATE_SIGNAL_FIELDS = new Set([
  "currentLocationCoordinates",
  "currentLocationApproximateCoordinates",
]);
const SCALAR_SIGNAL_FIELDS = new Set(["lastSeen"]);
const UNSUPPORTED_LATEST_FIELDS = new Set(["availableSignals", "vinVC"]);
const SAFE_SIGNAL_ALLOWLIST = new Set([
  "lastSeen",
  "currentLocationAltitude",
  "currentLocationCoordinates",
  "currentLocationApproximateCoordinates",
  "currentLocationHeading",
  "exteriorAirTemperature",
  "isIgnitionOn",
  "lowVoltageBatteryCurrentVoltage",
  "obdDTCList",
  "obdDistanceWithMIL",
  "obdIsPluggedIn",
  "obdRunTime",
  "obdStatusDTCCount",
  "powertrainCombustionEngineDieselExhaustFluidLevel",
  "powertrainCombustionEngineECT",
  "powertrainCombustionEngineSpeed",
  "powertrainCombustionEngineTPS",
  "powertrainFuelSystemRelativeLevel",
  "powertrainTransmissionTravelledDistance",
  "speed",
]);

const FALLBACK_SIGNAL_ALLOWLIST = SAFE_SIGNAL_ALLOWLIST;

const SIGNALS_BLOCKED_BY_PRIVILEGE = {
  GetLocationHistory: new Set([
    "currentLocationAltitude",
    "currentLocationCoordinates",
    "currentLocationHeading",
  ]),
  GetApproximateLocation: new Set(["currentLocationApproximateCoordinates"]),
  GetVINCredential: new Set(["vinVCLatest"]),
};

let signalCollectionFieldCache = null;

function cleanString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function toBooleanOrNull(value) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return null;

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;

  return null;
}

function normalizeTokenId(tokenId) {
  const numericTokenId = Number(tokenId);
  if (!Number.isInteger(numericTokenId) || numericTokenId <= 0) {
    throw new Error(`Invalid DIMO tokenId: ${tokenId}`);
  }
  return numericTokenId;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function getGraphQLErrorMessages(err) {
  const messages = [];

  if (err?.message) messages.push(String(err.message));

  for (const graphQLError of err?.body?.errors || []) {
    if (graphQLError?.message) messages.push(String(graphQLError.message));
    if (graphQLError?.extensions) {
      messages.push(JSON.stringify(graphQLError.extensions));
    }
  }

  if (typeof err?.body === "string") messages.push(err.body);
  return messages;
}

function extractMissingPrivilegesFromGraphQLErrorMessage(message) {
  const text = Array.isArray(message)
    ? message.join("\n")
    : String(message || "");
  const found = new Set();

  for (const match of text.matchAll(/privilege:([A-Za-z0-9_]+)/g)) {
    found.add(match[1]);
  }

  for (const privilege of Object.keys(SIGNALS_BLOCKED_BY_PRIVILEGE)) {
    if (text.includes(privilege)) found.add(privilege);
  }

  return [...found];
}

function getSignalsBlockedByPrivileges(signalNames, missingPrivileges) {
  const candidates = new Set(signalNames || []);
  const blocked = new Set();

  for (const privilege of missingPrivileges || []) {
    const signals = SIGNALS_BLOCKED_BY_PRIVILEGE[privilege];
    if (!signals) continue;

    for (const signalName of signals) {
      if (candidates.has(signalName)) blocked.add(signalName);
    }
  }

  return [...blocked];
}

function removeSignalsBlockedByPrivileges(signalNames, missingPrivileges) {
  const blocked = new Set(
    getSignalsBlockedByPrivileges(signalNames, missingPrivileges)
  );

  return (signalNames || []).filter((signalName) => !blocked.has(signalName));
}

async function postGraphQL({
  url,
  query,
  variables = {},
  authHeader = null,
}) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (authHeader) {
    headers.Authorization = authHeader;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    const err = new Error(
      `DIMO API failed: HTTP ${res.status} ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }

  if (body?.errors?.length) {
    const err = new Error(`DIMO GraphQL errors: ${JSON.stringify(body.errors)}`);
    err.body = body;
    throw err;
  }

  return body;
}

function getDimoFleetFromEnv() {
  const raw = process.env.DIMO_FLEET_JSON;
  if (!raw || !raw.trim()) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid DIMO_FLEET_JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid DIMO_FLEET_JSON: expected an array");
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid DIMO_FLEET_JSON[${index}]: expected an object`);
    }

    const tokenId = normalizeTokenId(item.tokenId);
    const inactive = toBooleanOrNull(item.inactive) === true;
    const explicitActive = toBooleanOrNull(item.active);
    const active = explicitActive == null ? !inactive : explicitActive && !inactive;

    return {
      tokenId,
      active,
      nickname: cleanString(item.nickname),
      vin: cleanString(item.vin),
      make: cleanString(item.make),
      model: cleanString(item.model),
      year: item.year == null || item.year === "" ? null : Number(item.year),
      standard_engine: cleanString(item.standard_engine),
    };
  });
}

function normalizeSharedVehicleNode(node) {
  if (!node?.tokenId) return null;

  const tokenId = normalizeTokenId(node.tokenId);
  const definition = node.definition || {};

  return {
    tokenId,
    tokenDID: cleanString(node.tokenDID),
    owner: cleanString(node.owner),
    make: cleanString(definition.make),
    model: cleanString(definition.model),
    year:
      definition.year == null || definition.year === ""
        ? null
        : Number(definition.year),
    vehicleDefinition: definition,
  };
}

function mergeDimoFleet(sharedVehicles, localFleet) {
  if (!Array.isArray(localFleet) || !localFleet.length) {
    return [];
  }

  const overridesByTokenId = new Map(
    (localFleet || []).map((vehicle) => [Number(vehicle.tokenId), vehicle])
  );
  const sharedByTokenId = new Map(
    (sharedVehicles?.nodes || [])
      .map(normalizeSharedVehicleNode)
      .filter(Boolean)
      .map((vehicle) => [vehicle.tokenId, vehicle])
  );

  return (localFleet || [])
    .filter((override) => override.active !== false)
    .map((override) => {
      const sharedVehicle = sharedByTokenId.get(Number(override.tokenId));

      if (!sharedVehicle) {
        console.warn(
          `DIMO tokenId=${override.tokenId} is in DIMO_FLEET_JSON but was not returned by Identity shared vehicles; skipping`
        );
        return null;
      }

      const vehicle = {
        ...sharedVehicle,
        ...Object.fromEntries(
          Object.entries(override).filter(([, value]) => value != null)
        ),
      };

      return {
        ...vehicle,
        dimo_token_id: vehicle.tokenId,
        external_vehicle_key: `dimo:${vehicle.tokenId}`,
      };
    })
    .filter(Boolean);
}

async function fetchDimoSharedVehicles({ first = 100 } = {}) {
  const clientId = cleanString(process.env.DIMO_CLIENT_ID);
  if (!clientId) {
    throw new Error("Missing DIMO_CLIENT_ID");
  }

  const authHeader = await getDimoDeveloperAuthHeader();

  const query = `
    query GetVehicleByDevLicense($clientId: Address!, $first: Int!) {
      vehicles(filterBy: { privileged: $clientId }, first: $first) {
        totalCount
        nodes {
          tokenId
          tokenDID
          owner
          definition {
            make
            model
            year
          }
        }
      }
    }
  `;

  const result = await postGraphQL({
    url: IDENTITY_URL,
    query,
    variables: { clientId, first },
    authHeader,
  });

  return result?.data?.vehicles ?? { totalCount: 0, nodes: [] };
}

async function getDimoFleet() {
  const [sharedVehicles, localFleet] = await Promise.all([
    fetchDimoSharedVehicles(),
    Promise.resolve(getDimoFleetFromEnv()),
  ]);

  const fleet = mergeDimoFleet(sharedVehicles, localFleet);

  if (!fleet.length) {
    console.warn(
      "DIMO fleet discovery returned no pollable vehicles from DIMO_FLEET_JSON"
    );
  }

  return {
    sharedVehicles,
    localFleet,
    fleet,
  };
}

async function fetchSignalCollectionFields(authHeader) {
  if (signalCollectionFieldCache) return signalCollectionFieldCache;

  const query = `
    query DimoSignalCollectionFields {
      __type(name: "SignalCollection") {
        fields {
          name
        }
      }
    }
  `;

  try {
    const result = await postGraphQL({
      url: TELEMETRY_URL,
      query,
      variables: {},
      authHeader,
    });

    const names = (result?.data?.__type?.fields || [])
      .map((field) => field?.name)
      .filter((name) => typeof name === "string" && GRAPHQL_NAME_RE.test(name));

    signalCollectionFieldCache = names.length
      ? new Set(names)
      : FALLBACK_SIGNAL_ALLOWLIST;
  } catch (err) {
    console.warn(
      "DIMO SignalCollection introspection failed; using fallback allowlist:",
      err.message || err
    );
    signalCollectionFieldCache = FALLBACK_SIGNAL_ALLOWLIST;
  }

  return signalCollectionFieldCache;
}

async function fetchDimoAvailableSignals(tokenId, authHeader = null) {
  const numericTokenId = normalizeTokenId(tokenId);
  const vehicleAuthHeader = authHeader || (await getDimoVehicleAuthHeader(numericTokenId));

  const query = `
    query AvailableSignals($tokenId: Int!) {
      availableSignals(tokenId: $tokenId)
    }
  `;

  const result = await postGraphQL({
    url: TELEMETRY_URL,
    query,
    variables: { tokenId: numericTokenId },
    authHeader: vehicleAuthHeader,
  });

  return result?.data?.availableSignals ?? [];
}

function buildLatestSignalSelection(signalName) {
  if (!GRAPHQL_NAME_RE.test(signalName)) return null;
  if (!SAFE_SIGNAL_ALLOWLIST.has(signalName)) return null;
  if (UNSUPPORTED_LATEST_FIELDS.has(signalName)) return null;

  if (SCALAR_SIGNAL_FIELDS.has(signalName)) {
    return signalName;
  }

  if (COORDINATE_SIGNAL_FIELDS.has(signalName)) {
    return `${signalName} { value { latitude longitude hdop } timestamp }`;
  }

  return `${signalName} { value timestamp }`;
}

async function buildDimoSignalSelections(availableSignals, authHeader) {
  const schemaAllowlist = await fetchSignalCollectionFields(authHeader);
  const selectedSignals = [];
  const skippedSignals = [];

  for (const signalName of availableSignals || []) {
    if (
      typeof signalName !== "string" ||
      !GRAPHQL_NAME_RE.test(signalName) ||
      !SAFE_SIGNAL_ALLOWLIST.has(signalName) ||
      !schemaAllowlist.has(signalName)
    ) {
      skippedSignals.push(signalName);
      continue;
    }

    const selection = buildLatestSignalSelection(signalName);
    if (!selection) {
      skippedSignals.push(signalName);
      continue;
    }

    selectedSignals.push({ name: signalName, selection });
  }

  return { selectedSignals, skippedSignals };
}

async function queryDimoSignalsLatest(tokenId, authHeader, selectedSignals) {
  const selectionBlock = selectedSignals
    .map((signal) => signal.selection)
    .join("\n");

  const query = `
    query SignalsLatest($tokenId: Int!) {
      signalsLatest(tokenId: $tokenId) {
        ${selectionBlock}
      }
    }
  `;

  return postGraphQL({
    url: TELEMETRY_URL,
    query,
    variables: { tokenId },
    authHeader,
  });
}

async function fetchDimoSignalsLatest(tokenId, options = {}) {
  const numericTokenId = normalizeTokenId(tokenId);
  const authHeader =
    options.authHeader || (await getDimoVehicleAuthHeader(numericTokenId));

  const availableSignals =
    options.availableSignals || (await fetchDimoAvailableSignals(numericTokenId, authHeader));

  const { selectedSignals, skippedSignals } = await buildDimoSignalSelections(
    availableSignals,
    authHeader
  );
  const candidateSignalNames = selectedSignals.map((signal) => signal.name);

  if (!selectedSignals.length) {
    return {
      data: { signalsLatest: {} },
      meta: {
        availableSignals,
        availableSignalsCount: availableSignals.length,
        supportedSignalsCount: 0,
        requestedSignals: [],
        fetchedSignals: [],
        skippedSignals,
        missingPrivileges: [],
        degraded: true,
      },
    };
  }

  try {
    const result = await queryDimoSignalsLatest(
      numericTokenId,
      authHeader,
      selectedSignals
    );

    return {
      ...result,
      meta: {
        availableSignals,
        availableSignalsCount: availableSignals.length,
        supportedSignalsCount: selectedSignals.length,
        requestedSignals: candidateSignalNames,
        fetchedSignals: candidateSignalNames,
        skippedSignals,
        missingPrivileges: [],
        degraded: false,
      },
    };
  } catch (err) {
    const messages = getGraphQLErrorMessages(err);
    const missingPrivileges = unique(
      extractMissingPrivilegesFromGraphQLErrorMessage(messages)
    );

    if (!missingPrivileges.length) {
      throw err;
    }

    const blockedSignals = getSignalsBlockedByPrivileges(
      candidateSignalNames,
      missingPrivileges
    );
    const retrySignalNames = removeSignalsBlockedByPrivileges(
      candidateSignalNames,
      missingPrivileges
    );

    const retrySignals = selectedSignals.filter((signal) =>
      retrySignalNames.includes(signal.name)
    );
    const degradedSkippedSignals = unique([
      ...skippedSignals,
      ...blockedSignals,
    ]);

    if (!retrySignals.length) {
      return {
        data: { signalsLatest: {} },
        meta: {
          availableSignals,
          availableSignalsCount: availableSignals.length,
          supportedSignalsCount: selectedSignals.length,
          requestedSignals: [],
          initialRequestedSignals: candidateSignalNames,
          fetchedSignals: [],
          skippedSignals: degradedSkippedSignals,
          blockedSignals,
          missingPrivileges,
          degraded: true,
          degradedReason: "all_candidate_signals_blocked_by_privilege",
        },
      };
    }

    let retryResult;
    try {
      retryResult = await queryDimoSignalsLatest(
        numericTokenId,
        authHeader,
        retrySignals
      );
    } catch (retryErr) {
      const newRetryMissingPrivileges = extractMissingPrivilegesFromGraphQLErrorMessage(
        getGraphQLErrorMessages(retryErr)
      );

      if (!newRetryMissingPrivileges.length) {
        throw retryErr;
      }

      const retryMissingPrivileges = unique([
        ...missingPrivileges,
        ...newRetryMissingPrivileges,
      ]);

      const retryBlockedSignals = getSignalsBlockedByPrivileges(
        retrySignalNames,
        retryMissingPrivileges
      );

      return {
        data: { signalsLatest: {} },
        meta: {
          availableSignals,
          availableSignalsCount: availableSignals.length,
          supportedSignalsCount: selectedSignals.length,
          requestedSignals: [],
          initialRequestedSignals: candidateSignalNames,
          fetchedSignals: [],
          skippedSignals: unique([
            ...degradedSkippedSignals,
            ...retryBlockedSignals,
            ...retrySignalNames,
          ]),
          blockedSignals: unique([...blockedSignals, ...retryBlockedSignals]),
          missingPrivileges: retryMissingPrivileges,
          degraded: true,
          degradedReason: "retry_failed_due_to_missing_privileges",
        },
      };
    }

    return {
      ...retryResult,
      meta: {
        availableSignals,
        availableSignalsCount: availableSignals.length,
        supportedSignalsCount: selectedSignals.length,
        requestedSignals: retrySignalNames,
        initialRequestedSignals: candidateSignalNames,
        fetchedSignals: retrySignalNames,
        skippedSignals: degradedSkippedSignals,
        blockedSignals,
        missingPrivileges,
        degraded: true,
        degradedReason: "missing_privileges",
      },
    };
  }
}

async function fetchDimoVin(tokenId, authHeader = null) {
  const numericTokenId = normalizeTokenId(tokenId);
  const vehicleAuthHeader = authHeader || (await getDimoVehicleAuthHeader(numericTokenId));

  const query = `
    query VinLookup($tokenId: Int!) {
      vinVCLatest(tokenId: $tokenId) {
        vin
      }
    }
  `;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await postGraphQL({
        url: TELEMETRY_URL,
        query,
        variables: { tokenId: numericTokenId },
        authHeader: vehicleAuthHeader,
      });
      return {
        vin: cleanString(result?.data?.vinVCLatest?.vin),
        degraded: false,
        missingPrivileges: [],
      };
    } catch (err) {
      const msg = err.message || String(err);
      const missingPrivileges = unique(
        extractMissingPrivilegesFromGraphQLErrorMessage(
          getGraphQLErrorMessages(err)
        )
      );

      if (missingPrivileges.includes("GetVINCredential")) {
        return {
          vin: null,
          degraded: true,
          missingPrivileges,
        };
      }

      if (!msg.includes("HTTP 503") || attempt === 3) {
        console.warn(`DIMO VIN query failed for tokenId=${numericTokenId}:`, msg);
        return {
          vin: null,
          degraded: true,
          missingPrivileges,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  return {
    vin: null,
    degraded: true,
    missingPrivileges: [],
  };
}

module.exports = {
  TELEMETRY_URL,
  IDENTITY_URL,
  buildDimoSignalSelections,
  extractMissingPrivilegesFromGraphQLErrorMessage,
  fetchDimoAvailableSignals,
  fetchDimoSharedVehicles,
  fetchDimoSignalsLatest,
  fetchDimoVin,
  getSignalsBlockedByPrivileges,
  getDimoFleet,
  getDimoFleetFromEnv,
  mergeDimoFleet,
  removeSignalsBlockedByPrivileges,
  postGraphQL,
};
