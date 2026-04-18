import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { DIMO } from '@dimo-network/data-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load ../.env relative to this script file
dotenv.config({
  path: path.resolve(__dirname, '../../.env'),
});

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

async function main() {
  const clientId = requireEnv('DIMO_CLIENT_ID');
  const redirectUrl = requireEnv('DIMO_REDIRECT_URL');
  const apiKey = requireEnv('DIMO_API_KEY');

  const dimo = new DIMO('Production');

  const developerJwt = await dimo.auth.getDeveloperJwt({
    client_id: clientId,
    domain: redirectUrl,
    private_key: apiKey,
  });

  console.log('Developer JWT response:');
  console.log(JSON.stringify(developerJwt, null, 2));

  if (developerJwt?.accessToken) {
    console.log('\nAccess token:\n');
    console.log(developerJwt.accessToken);
  } else if (developerJwt?.access_token) {
    console.log('\nAccess token:\n');
    console.log(developerJwt.access_token);
  }
}

main().catch((err) => {
  console.error('\nFailed to get DIMO Developer JWT.');
  console.error(err?.message || err);
  process.exit(1);
});