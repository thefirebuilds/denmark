import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { DIMO } from '@dimo-network/data-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Your .env is in Denmark2.0/.env
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function requireTokenId() {
  const arg = process.argv[2];
  if (!arg || !arg.trim()) {
    throw new Error('Usage: node get-dimo-vehicle-jwt.mjs <vehicleTokenId>');
  }

  const tokenId = Number(arg);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    throw new Error(`Invalid vehicleTokenId: ${arg}`);
  }

  return tokenId;
}

async function main() {
  const clientId = requireEnv('DIMO_CLIENT_ID');
  const redirectUrl = requireEnv('DIMO_REDIRECT_URL');
  const apiKey = requireEnv('DIMO_API_KEY');
  const tokenId = requireTokenId();

  console.log('Using env file:', envPath);
  console.log('Vehicle tokenId:', tokenId);

  const dimo = new DIMO('Production');

  // 1) Get Developer JWT
  const developerJwt = await dimo.auth.getDeveloperJwt({
    client_id: clientId,
    domain: redirectUrl,
    private_key: apiKey,
  });

  console.log('\nDeveloper JWT acquired.');

  // 2) Exchange for Vehicle JWT
  const vehicleJwt = await dimo.tokenexchange.getVehicleJwt({
    ...developerJwt,
    tokenId,
  });

  console.log('\nVehicle JWT response:');
  console.log(JSON.stringify(vehicleJwt, null, 2));

  const vehicleAuthHeader =
    vehicleJwt?.headers?.Authorization ||
    (vehicleJwt?.token ? `Bearer ${vehicleJwt.token}` : null);

  if (!vehicleAuthHeader) {
    throw new Error('Could not find Authorization header or token in Vehicle JWT response.');
  }

  console.log('\nVehicle Authorization header:\n');
  console.log(vehicleAuthHeader);

  // 3) Optional telemetry smoke test
  const telemetryResponse = await dimo.telemetry.query({
    ...vehicleJwt,
    query: `
      query GetLatestSignals {
        signalsLatest(tokenId: ${tokenId}) {
          speed {
            value
            timestamp
          }
        }
      }
    `,
  });

  console.log('\nTelemetry response:');
  console.log(JSON.stringify(telemetryResponse, null, 2));
}

main().catch((err) => {
  console.error('\nFailed to get Vehicle JWT or query telemetry.');
  console.error(err?.message || err);
  process.exit(1);
});