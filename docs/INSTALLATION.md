# Installation

This guide covers a managed tenant pod: one Docker Compose stack with the Denmark app container and a local PostgreSQL service.

## Requirements

On the VM or Droplet:

- Docker Engine
- Docker Compose plugin
- Git
- A DNS name and HTTPS reverse proxy or tunnel for production use
- A `.env` file kept beside `docker-compose.yml`

Recommended starting size for a real tenant is at least 2 GB RAM. Telemetry, restore jobs, browser automation, and scheduled integrations can overwhelm very small 512 MB instances.

## Clone The Repo

```bash
git clone https://github.com/thefirebuilds/denmark.git
cd denmark
```

If the repo is already present:

```bash
git pull
```

The running app code comes from `ghcr.io/thefirebuilds/denmark:latest`; the checkout supplies `docker-compose.yml`, setup scripts, docs, and `.env.example`.

## Create `.env`

```bash
cp .env.example .env
```

Minimum production shape:

```dotenv
NODE_ENV=production
PORT=5000
TZ=America/Chicago

PGHOST=db
PGPORT=5432
PGDATABASE=denmark
PGUSER=postgres
PGPASSWORD=replace-with-postgres-password
PGPOOL_MAX=6
PGCONNECT_TIMEOUT_MS=10000

SESSION_SECRET=replace-with-long-random-session-secret
TOKEN_ENCRYPTION_KEY=replace-with-long-random-secret
DENMARK_BRIDGE_SECRET=replace-with-android-bridge-secret

DENMARK_SWAP_SIZE=4G

AUTH_ENFORCED=true
AUTH_COOKIE_SECURE=true
AUTH_OWNER_EMAILS=owner@example.com

OIDC_ENABLED=true
OIDC_PROVIDER_NAME=google
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_SCOPES=openid profile email
GOOGLE_CLIENT_ID=replace-with-google-client-id
GOOGLE_CLIENT_SECRET=replace-with-google-client-secret
```

Generate a session secret:

```bash
openssl rand -base64 48
```

Generate and keep a stable token encryption key:

```bash
openssl rand -hex 32
```

Do not rotate `TOKEN_ENCRYPTION_KEY` without re-saving encrypted tenant
secrets. It protects database-stored integration secrets such as Google
Calendar refresh tokens, IMAP passwords, and SMS/Twilio auth tokens.
It also protects database-stored Bouncie and Teller access tokens as they are
created or migrated.

Keep these in `.env` for now because they are deployment/runtime secrets:

- `PG*`
- `SESSION_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `DENMARK_BRIDGE_SECRET`
- OIDC/Google client secret
- provider credentials that do not yet have tenant settings UI

Database connection settings are a bootstrap dependency: Denmark needs them
before it can connect to Postgres and read encrypted tenant settings. Move them
out of `.env` with Docker secrets, host-mounted secret files, or your platform's
secret manager, but do not store the primary Postgres connection password only
inside the same database it unlocks.

The app and setup scripts support Docker-style secret file variables for the
core bootstrap secrets:

```dotenv
PGPASSWORD_FILE=/run/secrets/denmark_pgpassword
SESSION_SECRET_FILE=/run/secrets/denmark_session_secret
TOKEN_ENCRYPTION_KEY_FILE=/run/secrets/denmark_token_encryption_key
DENMARK_BRIDGE_SECRET_FILE=/run/secrets/denmark_bridge_secret
BOUNCIE_CLIENT_SECRET_FILE=/run/secrets/denmark_bouncie_client_secret
# Teller credentials are managed in Settings > Integrations. Legacy
# TELLER_CERT_BASE64_FILE and TELLER_KEY_BASE64_FILE values are accepted as
# migration fallbacks until settings are saved there.
```

## Install

```bash
bash setup/install.sh
```

The installer:

1. Ensures host swap is enabled on Linux droplets when no swap exists.
2. Starts PostgreSQL.
3. Waits for Postgres readiness.
4. Pulls the current app image.
5. Runs database bootstrap.
6. Runs database verification.
7. Starts Denmark only if bootstrap and verification succeed.

Swap is configured by the host installer, not the Dockerfile. Dockerfiles build
container images and cannot safely enable swap on the Droplet host. The default
is `DENMARK_SWAP_SIZE=4G`; set `DENMARK_SWAP_SIZE=0` to skip swap setup.

Manual equivalent:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
docker compose up -d db
docker compose pull app
docker compose run --rm app npm run db:bootstrap
docker compose run --rm app npm run db:verify
docker compose up -d
```

## Health Check

```bash
docker compose ps
curl http://localhost:5000/api/health
docker compose logs -f app
```

With `AUTH_ENFORCED=true`, most API routes require login. `/api/health` is the deployment check.

## Reverse Proxy

`docker-compose.yml` binds the app to localhost:

```text
127.0.0.1:5000:5000
```

Put Nginx, Caddy, Traefik, Cloudflare Tunnel, or another HTTPS frontend in front of it. The public browser URL must match the public URL saved later in Settings > Authentication.

## Updates

After a push to `main` publishes a new container:

```bash
git pull
docker compose pull app
docker compose run --rm app npm run db:bootstrap
docker compose run --rm app npm run db:verify
docker compose up -d --force-recreate app
```

## Backup And Restore

In the app, use Settings > Maintenance > Database to:

- create a tenant `.dump` backup
- stage a restore from a public URL such as a Google Drive share link
- validate the dump
- restore after typing `RESTORE`
- delete old staged imports

Restore replaces tenant data. Use it for initial migration and disaster recovery.

CLI restore path:

```bash
mkdir -p imports
# copy rest.dump into ./imports
docker compose stop app
docker compose run --rm app sh -lc "pg_restore --clean --if-exists --no-owner --no-privileges -h db -p 5432 -U postgres -d denmark /app/imports/rest.dump"
docker compose run --rm app npm run db:bootstrap
docker compose run --rm app npm run db:verify
docker compose up -d app
```

If restore uses most of the VM memory, stop the app first and run restore while only Postgres is active.

## Local Development

```bash
cp .env.example .env
npm install
cd server
npm install
npm run dev
```

In another terminal:

```bash
npm run dev
```

Use `AUTH_ENFORCED=false` for trusted local development. Do not expose that tenant to the public internet.
