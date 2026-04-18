import fs from 'fs/promises';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { DIMO } from '@dimo-network/data-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TELEMETRY_URL = 'https://telemetry-api.dimo.zone/query';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function getTokenId() {
  const arg = process.argv[2] || process.env.DIMO_VEHICLE_TOKEN_ID || '190628';
  const tokenId = Number(arg);

  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    throw new Error(`Invalid vehicleTokenId: ${arg}`);
  }

  return tokenId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(fn, attempts = 4, baseDelayMs = 1200) {
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status ?? null;

      if (![500, 502, 503, 504].includes(status) || i === attempts - 1) {
        throw err;
      }

      const waitMs = baseDelayMs * Math.pow(2, i);
      console.warn(`Upstream ${status}; retrying in ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }

  throw lastErr;
}

async function getVehicleAuthHeader(tokenId) {
  const dimo = new DIMO('Production');

  const developerJwt = await dimo.auth.getDeveloperJwt({
    client_id: requireEnv('DIMO_CLIENT_ID'),
    domain: requireEnv('DIMO_REDIRECT_URL'),
    private_key: requireEnv('DIMO_API_KEY'),
  });

  const vehicleJwt = await dimo.tokenexchange.getVehicleJwt({
    ...developerJwt,
    tokenId,
  });

  const authHeader = vehicleJwt?.headers?.Authorization;
  if (!authHeader) {
    throw new Error('Vehicle JWT did not include Authorization header.');
  }

  return authHeader;
}

async function postGraphQL(authHeader, query, variables = undefined) {
  const res = await fetch(TELEMETRY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(
      variables === undefined ? { query } : { query, variables }
    ),
  });

  const text = await res.text();

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    const error = new Error(
      `Telemetry API failed: HTTP ${res.status}\n${
        typeof body === 'string' ? body : JSON.stringify(body, null, 2)
      }`
    );
    error.status = res.status;
    error.body = body;
    throw error;
  }

  if (body?.errors?.length) {
    const error = new Error(`GraphQL errors:\n${JSON.stringify(body.errors, null, 2)}`);
    error.status = 200;
    error.body = body;
    throw error;
  }

  return body;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function unwrapType(typeRef) {
  let current = typeRef;
  while (current?.ofType) current = current.ofType;
  return current;
}

function typeRefToString(typeRef) {
  if (!typeRef) return 'UNKNOWN';
  if (typeRef.kind === 'NON_NULL') return `${typeRefToString(typeRef.ofType)}!`;
  if (typeRef.kind === 'LIST') return `[${typeRefToString(typeRef.ofType)}]`;
  return typeRef.name || typeRef.kind || 'UNKNOWN';
}

async function introspectType(authHeader, typeName) {
  const query = `
    query IntrospectType($typeName: String!) {
      __type(name: $typeName) {
        name
        kind
        fields {
          name
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                    ofType {
                      kind
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await retry(() => postGraphQL(authHeader, query, { typeName }));
  return result?.data?.__type ?? null;
}

async function buildTypeMap(authHeader, rootTypeName = 'SignalCollection') {
  const queue = [rootTypeName];
  const seen = new Set();
  const typeMap = new Map();

  while (queue.length) {
    const typeName = queue.shift();
    if (!typeName || seen.has(typeName)) continue;
    seen.add(typeName);

    const typeInfo = await introspectType(authHeader, typeName);
    if (!typeInfo) continue;

    typeMap.set(typeName, typeInfo);

    for (const field of typeInfo.fields || []) {
      const named = unwrapType(field.type);
      if (named?.kind === 'OBJECT' && named?.name && !seen.has(named.name)) {
        queue.push(named.name);
      }
    }
  }

  return typeMap;
}

function buildSelectionForType(typeName, typeMap, depth = 0, visited = new Set()) {
  if (depth > 6 || visited.has(typeName)) {
    return '';
  }

  const typeInfo = typeMap.get(typeName);
  if (!typeInfo?.fields?.length) {
    return '';
  }

  visited.add(typeName);

  const parts = [];

  for (const field of typeInfo.fields) {
    const named = unwrapType(field.type);

    if (!named) continue;

    if (named.kind === 'SCALAR' || named.kind === 'ENUM') {
      parts.push(field.name);
      continue;
    }

    if (named.kind === 'OBJECT') {
      const nested = buildSelectionForType(
        named.name,
        typeMap,
        depth + 1,
        new Set(visited)
      );

      if (nested.trim()) {
        parts.push(`${field.name} { ${nested} }`);
      } else {
        parts.push(field.name);
      }
    }
  }

  return parts.join(' ');
}

function buildSignalFieldSelections(availableSignals, typeMap) {
  const signalCollection = typeMap.get('SignalCollection');
  const fieldMap = new Map(
    (signalCollection?.fields || []).map((f) => [f.name, f])
  );

  const supported = [];
  const missingFromSchema = [];

  for (const signal of availableSignals) {
    const field = fieldMap.get(signal);

    if (!field) {
      missingFromSchema.push(signal);
      continue;
    }

    const named = unwrapType(field.type);

    if (!named) {
      missingFromSchema.push(signal);
      continue;
    }

    if (named.kind === 'SCALAR' || named.kind === 'ENUM') {
      supported.push({ signal, selection: signal, type: typeRefToString(field.type) });
      continue;
    }

    if (named.kind === 'OBJECT') {
      const nested = buildSelectionForType(named.name, typeMap);
      if (!nested.trim()) {
        supported.push({ signal, selection: signal, type: typeRefToString(field.type) });
      } else {
        supported.push({
          signal,
          selection: `${signal} { ${nested} }`,
          type: typeRefToString(field.type),
        });
      }
      continue;
    }

    missingFromSchema.push(signal);
  }

  return { supported, missingFromSchema };
}

async function fetchAvailableSignals(authHeader, tokenId) {
  const query = `
    query AvailableSignals {
      availableSignals(tokenId: ${tokenId})
    }
  `;

  const result = await retry(() => postGraphQL(authHeader, query));
  return result?.data?.availableSignals ?? [];
}

async function fetchSignalChunk(authHeader, tokenId, chunkSelections) {
  const selectionBlock = chunkSelections.map((x) => x.selection).join('\n');

  const query = `
    query SnapshotChunk {
      signalsLatest(tokenId: ${tokenId}) {
        ${selectionBlock}
      }
    }
  `;

  return retry(() => postGraphQL(authHeader, query));
}

async function main() {
  const tokenId = getTokenId();
  const authHeader = await getVehicleAuthHeader(tokenId);

  console.log(`Building DIMO dump for tokenId ${tokenId}...`);

  const availableSignals = await fetchAvailableSignals(authHeader, tokenId);
  console.log(`Available signals reported by DIMO: ${availableSignals.length}`);

  const typeMap = await buildTypeMap(authHeader, 'SignalCollection');
  const { supported, missingFromSchema } = buildSignalFieldSelections(
    availableSignals,
    typeMap
  );

  console.log(`Signals supported by introspected schema: ${supported.length}`);
  console.log(`Signals missing from schema map: ${missingFromSchema.length}`);

  const results = {};
  const chunkErrors = [];
  const chunks = chunkArray(supported, 10);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const names = chunk.map((x) => x.signal);
    console.log(`Querying chunk ${i + 1}/${chunks.length}: ${names.join(', ')}`);

    try {
      const result = await fetchSignalChunk(authHeader, tokenId, chunk);
      const latest = result?.data?.signalsLatest ?? {};

      for (const name of Object.keys(latest)) {
        results[name] = latest[name];
      }
    } catch (err) {
      chunkErrors.push({
        chunk: i + 1,
        signals: names,
        status: err?.status ?? null,
        message: err?.message ?? String(err),
        body: err?.body ?? null,
      });
    }
  }

  const typeSummary = Object.fromEntries(
    supported.map((x) => [x.signal, x.type])
  );

  const output = {
    generatedAt: new Date().toISOString(),
    tokenId,
    availableSignalCount: availableSignals.length,
    availableSignals,
    supportedSignalCount: supported.length,
    missingFromSchemaCount: missingFromSchema.length,
    missingFromSchema,
    supportedSignalTypes: typeSummary,
    latestSignals: results,
    chunkErrors,
  };

  const outDir = path.resolve(__dirname, '../tmp');
  await fs.mkdir(outDir, { recursive: true });

  const latestPath = path.join(outDir, `dimo_dump_latest_${tokenId}.json`);
  const historyPath = path.join(outDir, `dimo_dump_${tokenId}_${Date.now()}.json`);

  await fs.writeFile(latestPath, JSON.stringify(output, null, 2), 'utf8');
  await fs.writeFile(historyPath, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\nLatest dump written to: ${latestPath}`);
  console.log(`History dump written to: ${historyPath}`);
  console.log(`Collected latest values for ${Object.keys(results).length} signals.`);
  if (chunkErrors.length) {
    console.log(`Encountered ${chunkErrors.length} chunk errors. See output JSON.`);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});