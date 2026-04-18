import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

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

async function main() {
  const clientId = requireEnv('DIMO_CLIENT_ID');

  const query = `
    query GetVehicleByDevLicense($clientId: Address!) {
      vehicles(filterBy: { privileged: $clientId }, first: 10) {
        totalCount
        nodes {
          tokenId
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

  const response = await fetch('https://identity-api.dimo.zone/query', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        clientId,
      },
    }),
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});