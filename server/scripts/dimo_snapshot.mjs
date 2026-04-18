import fs from 'fs/promises';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { DIMO } from '@dimo-network/data-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

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

  if (!vehicleJwt?.headers?.Authorization) {
    throw new Error('Vehicle JWT did not include an Authorization header.');
  }

  return vehicleJwt.headers.Authorization;
}

async function postGraphQL(authHeader, query) {
  const res = await fetch('https://telemetry-api.dimo.zone/query', {
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

  if (!res.ok) {
    throw new Error(
      `Telemetry API failed: HTTP ${res.status}\n${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}`
    );
  }

  return body;
}

async function main() {
  const tokenId = getTokenId();
  const authHeader = await getVehicleAuthHeader(tokenId);

  const query = `
    query Snapshot {
      signalsLatest(tokenId: ${tokenId}) {
        speed { value timestamp }
        isIgnitionOn { value timestamp }
        powertrainTransmissionTravelledDistance { value timestamp }
        powertrainFuelSystemRelativeLevel { value timestamp }
        powertrainType { value timestamp }
      }
    }
  `;

  const result = await postGraphQL(authHeader, query);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    tokenId,
    latestSignals: result?.data?.signalsLatest ?? null,
    rawResponse: result,
  };

  const outDir = path.resolve(__dirname, '../tmp');
  await fs.mkdir(outDir, { recursive: true });

  const latestPath = path.join(outDir, `dimo_snapshot_latest_${tokenId}.json`);
  const historyPath = path.join(outDir, `dimo_snapshot_${tokenId}_${Date.now()}.json`);

  await fs.writeFile(latestPath, JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.writeFile(historyPath, JSON.stringify(snapshot, null, 2), 'utf8');

  console.log(`Latest snapshot written to: ${latestPath}`);
  console.log(`History snapshot written to: ${historyPath}`);
  console.log(JSON.stringify(snapshot, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});