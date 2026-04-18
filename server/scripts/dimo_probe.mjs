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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function postGraphQL(authHeader, query) {
  const res = await fetch(TELEMETRY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return {
    ok: res.ok,
    status: res.status,
    body,
  };
}

async function retryGraphQL(authHeader, query, attempts = 4, baseDelayMs = 1200) {
  let lastResult = null;

  for (let i = 0; i < attempts; i++) {
    const result = await postGraphQL(authHeader, query);
    lastResult = result;

    if (result.ok) {
      return result;
    }

    if (![500, 502, 503, 504].includes(result.status) || i === attempts - 1) {
      return result;
    }

    const waitMs = baseDelayMs * Math.pow(2, i);
    console.warn(`Upstream ${result.status}; retrying in ${waitMs}ms...`);
    await sleep(waitMs);
  }

  return lastResult;
}

function probeQuery(tokenId, field) {
  return `
    query Probe {
      signalsLatest(tokenId: ${tokenId}) {
        ${field} { value timestamp }
      }
    }
  `;
}

async function main() {
  const tokenId = getTokenId();
  const authHeader = await getVehicleAuthHeader(tokenId);

  const candidateSignals = [
    'powertrainFuelSystemAbsoluteLevel',
    'powertrainRange',
    'obdIntakeTemp',
    'obdEngineLoad',
    'powertrainCombustionEngineMAF',
    'powertrainCombustionEngineEngineOilLevel',
    'chassisAxleRow1WheelLeftTirePressure',
    'chassisAxleRow1WheelRightTirePressure',
    'chassisAxleRow2WheelLeftTirePressure',
    'chassisAxleRow2WheelRightTirePressure',
    'currentLocationApproximateCoordinates',
    'obdBarometricPressure',
    'vinVCLatest',
  ];

  const results = {};

  for (const signal of candidateSignals) {
    console.log(`Probing ${signal}...`);
    const query = probeQuery(tokenId, signal);
    const result = await retryGraphQL(authHeader, query);

    if (result.ok && !result.body?.errors?.length) {
      results[signal] = {
        ok: true,
        status: result.status,
        data: result.body?.data?.signalsLatest?.[signal] ?? null,
      };
    } else {
      results[signal] = {
        ok: false,
        status: result.status,
        errors: result.body?.errors ?? null,
        body: result.body,
      };
    }
  }

  const working = Object.fromEntries(
    Object.entries(results).filter(([, value]) => value.ok)
  );

  const failed = Object.fromEntries(
    Object.entries(results).filter(([, value]) => !value.ok)
  );

  const output = {
    generatedAt: new Date().toISOString(),
    tokenId,
    candidateSignals,
    workingCount: Object.keys(working).length,
    failedCount: Object.keys(failed).length,
    working,
    failed,
  };

  const outDir = path.resolve(__dirname, '../tmp');
  await fs.mkdir(outDir, { recursive: true });

  const latestPath = path.join(outDir, `dimo_probe_extra_latest_${tokenId}.json`);
  const historyPath = path.join(
    outDir,
    `dimo_probe_extra_${tokenId}_${Date.now()}.json`
  );

  await fs.writeFile(latestPath, JSON.stringify(output, null, 2), 'utf8');
  await fs.writeFile(historyPath, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\nLatest probe written to: ${latestPath}`);
  console.log(`History probe written to: ${historyPath}`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});