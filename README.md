# Denmark2.0

Denmark2.0 is a working operations console for running a small Turo-centered vehicle fleet.

It pulls together trips, messages, vehicle telemetry, maintenance state, tolls, expenses, Google Calendar sync, and sourcing work into one local app so the daily question becomes:

`What matters right now?`

This is not generic fleet software and it is not a polished SaaS product. It is a real operations tool shaped around one host workflow, with real-world edge cases, partial integrations, and active iteration.

## What Denmark does today

### Dispatch and trip operations
- Shows a priority-sorted open trip queue with operational timing
- Tracks `in_progress`, `upcoming`, `unconfirmed`, closeout, overdue, and near-term pickup/return slices
- Supports trip detail editing and workflow-stage transitions
- Keeps fleet and trip views aware of blockers, turnarounds, and next required activity

### Messages and notifications
- Ingests Turo-related email through IMAP and links messages to trips where possible
- Tracks unread message state and message-driven operational notices
- Accepts Android bridge notifications at `POST /api/notifications/turo`
- Deduplicates bridge events, stores raw payloads, and applies lightweight classification
- Supports acknowledging/snoozing operational notices, including vehicle diagnostic notices
- Filters obvious low-value bridge noise such as partner-offer style notifications

### Vehicle telemetry
- Integrates with:
  - Bouncie
  - DIMO
- Maintains live status feeds for vehicles
- Stores telemetry snapshots and signal history
- Shows a fleet map with last known locations, freshness, stale telemetry, and recent running state
- Supports odometer, MIL/check-engine, battery, coolant, RPM, and engine-running checks where provider signals are available
- Tracks DIMO diagnostic first-reported and last-seen timestamps so latched codes are easier to reason about

### Maintenance and readiness
- Stores maintenance rules, tasks, and events in Postgres
- Shows fleet maintenance summaries, queue views, next interval due, and guest-facing safety/preflight exports
- Correlates maintenance events with queue items and recurring rules
- Supports lockbox PIN editing and host-side readiness workflows

### Financials and tolls
- Tracks expenses and associates them to trips or vehicles where possible
- Splits shared/general expense across the active fleet for metrics purposes
- Imports and audits toll activity with trip matching logic
- Surfaces trip-summary financial details and vehicle-level metrics
- Tracks business metrics, fleet utilization, trip-length distribution, and trip-length income performance

### Calendar and host workflow
- Syncs trip events into Google Calendar
- Creates and updates trip-linked calendar events
- Supports Google auth connection storage and sync metadata
- Can push public availability snapshots to another system when configured

### Marketplace and sourcing
- Ingests vehicle listings for sourcing workflow
- Stores candidate vehicles and review preferences
- Supports filtering, hide/ignore behavior, and enrichment work
- Includes FMV estimate storage and scheduled stale-estimate refresh support

### Mobile direction
- Desktop UI remains the primary control surface
- A mobile maintenance shell now exists as an alternate view
- Mobile presentation is still partial, not full parity

## Current architecture

- Frontend: React 19 + Vite
- Backend: Node.js + Express
- Database: PostgreSQL
- Local integrations: IMAP, Google Calendar, Bouncie, DIMO, Teller, HCTRA, Android notification bridge
- Auth: local development bypass or OIDC-backed sessions with permission-gated API routes
- Scheduler: startup and interval jobs for IMAP, telemetry, tolls, banking, alerts, metrics, FMV, retention, availability, and calendar reconciliation

Code shape today:
- `src/` contains the React app and operational panels
- `server/routes/` contains HTTP routes
- `server/services/` contains ingestion, sync, telemetry, maintenance, and scheduler logic
- `server/db/schema.sql` is the destructive repave/bootstrap path
- `server/db/migrations/` holds targeted follow-on schema changes

## Current state

Denmark is useful now, but not finished.

What is solid enough for daily use:
- trip queue and trip detail workflow
- maintenance queue and vehicle readiness views
- toll and expense review workflow
- live Bouncie/DIMO vehicle status views and fleet map
- Google Calendar sync foundations
- Android bridge ingestion receiver
- OIDC/session auth foundations and local development bypass
- business metrics, trip-length metrics, and public availability export foundations

What is still evolving:
- mobile parity beyond maintenance
- stricter normalization of legacy trip status vs workflow stage
- better shared-expense attribution by historical fleet composition
- deeper DIMO signal interpretation and anomaly handling
- stronger notification-to-trip linking
- more complete subsystem-specific setup and recovery docs

## Known gaps and rough edges

These are worth knowing before you trust the repo blindly.

### Documentation gaps
- The README had drifted behind the product shape; this file is catching up, but some subsystem docs are still implicit in code.
- There is not yet a dedicated operator handbook for common recovery/debug procedures.

### Local environment assumptions
- The app assumes a local Postgres-backed workflow.
- The schema repave file is intentionally destructive.
- Some workflows depend on real provider credentials and real local `.env` values.

### Authentication and access control
- Denmark now includes an authentication and authorization layer, but you need to decide whether it is actually enforced in your environment.
- Local development can run with:
  - `AUTH_ENFORCED=false`
  - this bypasses real login and treats the app as trusted local development
- Real login/session enforcement starts when:
  - `AUTH_ENFORCED=true`
  - and valid OIDC provider settings are present
- If the frontend or backend is reachable beyond your own tightly controlled machine, real auth should be enforced.

#### Simple practice setup: Google as the login provider

If you want the easiest human-login path to practice with, use Google.

1. In Google Cloud Console, create or reuse a project.
2. Configure the OAuth consent screen.
3. Create an `OAuth client ID` of type `Web application`.
4. Put these values in `.env`:

```dotenv
AUTH_ENFORCED=true
AUTH_COOKIE_SECURE=false
AUTH_OWNER_EMAILS=you@example.com

OIDC_ENABLED=true
OIDC_PROVIDER_NAME=google
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_SCOPES=openid profile email
```

If you already use Google Calendar sync in Denmark, you can reuse the same Google OAuth client:
- leave `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as-is
- omit `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`
- Denmark will fall back to the `GOOGLE_*` values automatically for auth

5. Bootstrap/start Denmark, then open **Settings > Authentication**.
6. Set the public app base URL.
7. Copy the computed Google OAuth redirect URI into Google Cloud Console under **Authorized redirect URIs**. If you use the Google Calendar integration with the same OAuth client, copy that computed calendar redirect URI too.
8. Open Denmark and use `Sign in`.

Notes:
- `AUTH_ENFORCED=false` means no real login is happening, even if OIDC values are present.
- The existing `GOOGLE_*` settings for Calendar sync are separate from these `OIDC_*` settings, even if they come from the same Google project.
- For local testing, `AUTH_COOKIE_SECURE=false` is expected on plain `http://localhost`.
- If a copied/restored local database still has a deployed `auth.public_base_url`, local development will use the current localhost request URL for OAuth redirects instead of sending the browser to the deployed tenant.

### Frontend build/runtime caveats
- Vite wants Node `20.19+` or `22.12+`.
- Running with Node `22.9.0` may still work in some places, but it produces warnings and can trip local build behavior.
- Mobile access in dev is supported, but it depends on the Vite LAN host/proxy setup and a reachable local backend.

### Data quality reality
- Some legacy trip rows still carry stale raw `status` values even when `workflow_stage` and `queue_bucket` are correct.
- DIMO coverage varies by vehicle and available permissions/signals.
- DIMO MIL/check-engine state can latch until the device/provider stops reporting it; Denmark records first-reported/last-seen data and supports snooze/acknowledge rather than assuming the app receives ECU clear events.
- Running-state display is intentionally freshness-gated because provider engine signals can arrive separately from location check-ins.
- Not every notification, email, or toll event can be perfectly linked on first pass.

## Help test and shape Denmark

Denmark is at the stage where real operators can make it much better.

If you run cars on Turo, manage a small fleet, build host-side tools, or just like working on messy real-world operations software, you are invited to test the app and help decide what it should become.

Good ways to help:
- try the app against a real or practice fleet workflow
- report where the queue, messages, trip state, or metrics feel wrong
- share examples of Turo emails, Android notifications, toll cases, reimbursement invoices, and telemetry edge cases that Denmark should understand better
- help improve setup docs, migrations, deployment notes, and recovery playbooks
- propose features that would save actual host time, not just look good in a demo
- contribute code, tests, parsers, integrations, or UI cleanup

This project may eventually become a hosted product, a self-hosted operator toolkit, a developer community around fleet automation, or some mix of those. The next step is not pretending that answer is obvious. The next step is getting more hands and more workflows into the loop.

The Discord is the center of that loop:

```text
https://discord.gg/qBnMQm3X
```

Bring bugs, screenshots, awkward edge cases, feature ideas, or questions about running it locally. The most valuable feedback right now is specific: what broke, what was confusing, what saved time, and what would make Denmark worth trusting for more of your day.

## Install / run

There are two supported ways to run Denmark:

- Production or VM install: Docker Compose pulls the app image from GitHub Container Registry.
- Local development: install frontend and backend npm dependencies, run the Express API and Vite dev server separately.

The production container expects a valid `.env`. Docker Compose can start a local
Postgres service named `db`, and the schema is initialized with an explicit
bootstrap command.

### How releases work

Pushes to `main` run `.github/workflows/publish-container.yml`.

That workflow builds the repo Dockerfile and publishes:

```text
ghcr.io/thefirebuilds/denmark:latest
ghcr.io/thefirebuilds/denmark:<git-sha>
```

The server uses `docker-compose.yml` to pull and run the `latest` image.

### Server prerequisites

Install these on the VM:

- Docker Engine
- Docker Compose plugin
- Git, if you want to pull `docker-compose.yml` and docs from the repo
- A production `.env` file kept on the VM
- Optional: a reverse proxy or tunnel that terminates HTTPS and forwards to port `5000`

The compose file includes the app and an optional local Postgres service named
`db`. It does not run schema bootstrap automatically; run the bootstrap command
once for a fresh database.

### 1. Get the deploy files onto the VM

Recommended:

```bash
git clone <repo-url> Denmark2.0
cd Denmark2.0
```

If the repo is already cloned:

```bash
cd Denmark2.0
git pull
```

The VM mainly needs:

- `docker-compose.yml`
- `setup/`
- `.env`

The repo checkout is convenient for updates and docs, but the app code comes from the published container image.

### 2. Create the VM `.env`

Create `.env` next to `docker-compose.yml`. Do not commit this file.

Minimum production shape:

```dotenv
NODE_ENV=production
PGHOST=db
PGPORT=5432
PGDATABASE=denmark
PGUSER=postgres
PGPASSWORD=replace-with-postgres-password

PORT=5000
SESSION_SECRET=replace-with-long-random-session-secret
TOKEN_ENCRYPTION_KEY=replace-with-64-char-hex-or-long-random-secret
DENMARK_BRIDGE_SECRET=replace-with-shared-secret-for-android-bridge
AUTH_ENFORCED=true
AUTH_COOKIE_SECURE=true
AUTH_OWNER_EMAILS=you@example.com
```

Generate `SESSION_SECRET` on the VM with:

```bash
openssl rand -base64 48
```

If the container logs `SESSION_SECRET is required when NODE_ENV=production`,
the `.env` file being used by Docker Compose is missing that value or is not
next to `docker-compose.yml`.

Add any integrations you use:

- `BOUNCIE_*`
- `DIMO_*`
- `GOOGLE_*`
- `IMAP_*`
- `EZTAG_*`
- `TELLER_*`
- `OPENAI_*`, if using FMV enrichment
- `PUBLIC_AVAILABILITY_*`, if pushing availability to another site
- `TWILIO_*`, if operational text alerts are enabled in your environment

For login in production, configure OIDC provider identity in `.env`:

```dotenv
OIDC_ENABLED=true
OIDC_PROVIDER_NAME=google
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_SCOPES=openid profile email
```

After bootstrap, open **Settings > Authentication**, set the public app base URL
such as `https://your-domain.example`, and copy the computed Google OAuth
redirect URI into Google Cloud Console under **Authorized redirect URIs**. If you
use Google Calendar sync with the same OAuth client, copy the computed Calendar
redirect URI from that same settings section. This public URL lives in
`app_settings`, not `.env`, so customer/tenant deployments do not require
rebuilding or editing environment files for their browser URL.

For DIMO, map known vehicles deliberately in **Settings > Fleet** by saving each
vehicle's DIMO token ID. Live DIMO polling constructs the fleet shape from the
database vehicle records instead of reading per-vehicle token IDs from `.env`.

### 3. Log in to GHCR if needed

If the GHCR package is private, create a GitHub personal access token with `read:packages`, then run this on the VM:

```bash
echo YOUR_GITHUB_PAT | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

You only need to do this again if the Docker login expires or the VM changes.

### 4. Run the installer

The shortest fresh-droplet path is:

```bash
bash setup/install.sh
```

That starts Postgres, pulls the app image, runs database bootstrap, verifies the
schema, and starts Denmark.

During first install, Docker may print one-off container creation lines before
the bootstrap logs appear. The installer prints an explicit
`waiting for postgres...` message until the database is ready. If bootstrap or
verification fails, the installer prints recent `db` and `app` logs and exits
before starting the app.

### Manual bootstrap steps

If you want to run the pieces by hand, start the local Postgres service first:

```bash
docker compose up -d db
```

Create the Denmark tables:

```bash
docker compose run --rm app npm run db:bootstrap
```

Verify the expected tables:

```bash
docker compose run --rm app npm run db:verify
```

The bootstrap command uses `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and
`PGPASSWORD` from `.env`. It is safe to run again; once the base schema exists it
only verifies/ensures runtime support tables. If it detects a partially
initialized schema, it refuses to reset it unless you explicitly pass
`-- --force-reset`.

### 5. Start the app

```bash
docker compose pull
docker compose up -d
```

The app listens on container port `5000`, mapped to VM port `5000`.

### 6. Check the app

```bash
docker compose ps
docker compose logs -f app
```

Basic health check:

```bash
curl http://localhost:5000/api/health
```

`/api/health` is intentionally suitable for deployment checks. Most operational APIs are auth-gated when `AUTH_ENFORCED=true`.

### Tenant backup and restore

Settings > Database uses native Postgres custom dumps for tenant backup and
restore. A backup contains the tenant database work product: vehicles, trips,
messages, settings, integrations, activity history, and related records. It does
not contain the Denmark application image or source code.

The app image includes PostgreSQL 18 client tools for `pg_dump` and
`pg_restore`, so tenants can restore dumps produced by current Denmark exports
without hitting archive header version errors.

Self-service migration or DR flow:

1. In the source tenant, open Settings > Database and download a tenant backup.
   The file uses the `.dump` format produced by `pg_dump -Fc`.
2. Upload that `.dump` file somewhere reachable, such as Google Drive, and set
   sharing to anyone with the link.
3. In the destination tenant, paste the public Google Drive share link under
   Cloud restore staging. The normal `/file/d/.../view?usp=sharing` link is
   expected. Denmark follows Drive's download prompt server-side and writes the
   staged file into `./imports` on the host through the compose mount at
   `/app/imports`.
4. Validate the staged backup. Denmark runs `pg_restore --list` to confirm the
   file is a Postgres custom dump.
5. Select the staged backup, type `RESTORE`, and start the restore. Denmark runs
   `pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error`
   in a background job.

Restore replaces the current tenant database. Use it for initial tenant standup
from an existing backup or for disaster recovery failover.

### 7. Update the VM later

After changes are merged to `main`, wait for the GitHub Actions container publish workflow to finish. Then run:

```bash
git pull
docker compose pull
docker compose run --rm app npm run db:bootstrap
docker compose up -d
```

If `docker compose pull` does not pick up a new image, confirm the `main` branch publish workflow completed successfully.

### Database bootstrap / repave

For normal first install or deployment updates, use the idempotent bootstrap:

```bash
npm run db:bootstrap
```

Inside Docker Compose:

```bash
docker compose run --rm app npm run db:bootstrap
```

Verification:

```bash
npm run db:verify
```

To also probe the running API, set `DENMARK_VERIFY_API_BASE_URL`:

```bash
DENMARK_VERIFY_API_BASE_URL=http://localhost:5000 npm run db:verify
```

The older schema file is still available as a destructive rebuild reference:

```text
server/db/schema.sql
```

Run from the repo root:

```bash
psql -U postgres -d postgres -f server/db/schema.sql
```

PowerShell:

```powershell
psql -U postgres -d postgres -f .\server\db\schema.sql
```

Notes:

- It creates the default `denmark` database if needed.
- It drops and recreates the public app schema.
- It does not include private operational data.
- It is destructive, so do not point it at a database you still need.
- Follow-on SQL files live in `server/db/migrations/`. They are targeted changes for existing databases and are not automatically applied by the container.
- Some runtime support tables are created or verified at startup, including notification events, auth tables, business metrics, income, FMV estimates, and fleet alert deliveries.

### Local development

Use this path only when editing the app locally.

Prerequisites:

- Node.js `20.19+` or `22.12+`
- npm
- PostgreSQL with `psql` on PATH
- Git
- A local `.env` copied from `.env.example`

Install dependencies:

```bash
npm install
cd server
npm install
cd ..
```

Create and configure `.env`:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

At minimum, set the Postgres fields, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DENMARK_BRIDGE_SECRET`, and either leave `AUTH_ENFORCED=false` for trusted local development or configure OIDC before setting it to `true`.

Create or repave the local database if needed:

```bash
psql -U postgres -d postgres -f server/db/schema.sql
```

Start the backend:

```bash
cd server
npm run dev
```

Start the frontend dev server from another terminal:

```bash
npm run dev
```

Default local URLs:

- frontend: `http://localhost:5173`
- backend: `http://localhost:5000`

Build the deployable frontend bundle:

```bash
npx vite build
```

The Dockerfile uses `npx vite build` directly because the current deployable frontend bundle builds cleanly that way. The root `npm run build` also runs `tsc -b` first and may be stricter than the current JSX-heavy app shape.

Local startup behavior:
- the backend serves API routes from port `5000`
- Vite serves the frontend from port `5173`
- the scheduler starts after startup tables are ready
- startup jobs are cooldown-gated for 15 minutes to avoid immediately re-running every integration after quick restarts
- interval jobs include IMAP, Bouncie, DIMO, fleet alerts, tolls, Teller/Mercury, Google Calendar, business metrics, FMV refresh, telemetry retention, and public availability push

## Android Turo bridge webhook

Webhook:

```text
POST /api/notifications/turo
```

Local URL:

```text
http://localhost:5000/api/notifications/turo
```

LAN example:

```text
http://<workstation-lan-ip>:5000/api/notifications/turo
```

The request should send:
- `Content-Type: application/json`
- `X-Denmark-Bridge-Secret: <DENMARK_BRIDGE_SECRET>`

Example:

```bash
curl -X POST http://localhost:5000/api/notifications/turo \
  -H "Content-Type: application/json" \
  -H "X-Denmark-Bridge-Secret: $DENMARK_BRIDGE_SECRET" \
  -d '{
    "source": "android_notification_test",
    "app": "turo",
    "package": "com.relayrides.android.relayrides",
    "title": "Denmark bridge test",
    "body": "If this arrives, the bridge path is alive.",
    "posted_at_ms": 1777136400000,
    "device": "pixel-turo-bridge-01",
    "notification_key": "manual-test"
  }'
```

Behavior:
- if `DENMARK_BRIDGE_SECRET` is set and does not match, the route returns `401`
- if the secret is missing, the route is allowed but the server logs a warning
- duplicates are deduped by `event_hash`
- if `event_hash` is omitted, Denmark computes a fallback hash

## Useful scripts and commands

Frontend:

```bash
npm run dev
npm run build
npm run preview
```

Backend:

```bash
cd server
npm start
npm run dev
```

## Future improvements

These are the most obvious next improvements based on the current project shape.

### Product and workflow
- expand mobile beyond the maintenance shell
- deepen notification handling from Android bridge events into actual dispatch notices
- improve trip/vehicle/guest extraction from notifications and messages
- keep aligning summary pills, detail panels, and queue buckets so they tell the same story

### Data model and attribution
- move shared-expense attribution toward historically accurate fleet composition
- continue reducing stale legacy `status` dependence in favor of `workflow_stage` and derived queue state
- improve toll matching confidence and audit visibility

### Telemetry and maintenance
- keep expanding DIMO support and signal interpretation
- strengthen maintenance forecasting and post-trip task generation
- attach more host-side notes, evidence, and inspection history where useful

### Engineering and docs
- document subsystem-specific setup and recovery flows
- tighten startup/runtime verification for local environments
- introduce clearer migration application guidance
- keep hardening authentication, authorization, and deployment defaults before wider exposure
- continue breaking out reusable API base/config helpers on the frontend where old `localhost` assumptions still linger

## Design philosophy

Denmark is optimized for operational truth over polish.

That means:
- resilience beats elegance
- partial data beats broken pages
- host workflow beats generic abstraction
- real queue accuracy beats pretty dashboards
- local usefulness beats theoretical platform purity

## Status

Actively developed, actively used, and still being shaped around real fleet pain.

## Contact

Best way to reach the maintainer and the Denmark community is Discord:

```text
https://discord.gg/qBnMQm3X
```
