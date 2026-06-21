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
Calendar refresh tokens and IMAP passwords.

Keep these in `.env` for now because they are deployment/runtime secrets:

- `PG*`
- `SESSION_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `DENMARK_BRIDGE_SECRET`
- OIDC/Google client secret
- provider credentials that do not yet have tenant settings UI

## Install

```bash
bash setup/install.sh
```

The installer:

1. Starts PostgreSQL.
2. Waits for Postgres readiness.
3. Pulls the current app image.
4. Runs database bootstrap.
5. Runs database verification.
6. Starts Denmark only if bootstrap and verification succeed.

Manual equivalent:

```bash
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
