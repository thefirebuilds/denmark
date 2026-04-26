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

### Vehicle telemetry
- Integrates with:
  - Bouncie
  - DIMO
- Maintains live status feeds for vehicles
- Stores telemetry snapshots and signal history
- Supports odometer and engine-related operational checks, including DIMO RPM investigations

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

### Calendar and host workflow
- Syncs trip events into Google Calendar
- Creates and updates trip-linked calendar events
- Supports Google auth connection storage and sync metadata

### Marketplace and sourcing
- Ingests vehicle listings for sourcing workflow
- Stores candidate vehicles and review preferences
- Supports filtering, hide/ignore behavior, and enrichment work

### Mobile direction
- Desktop UI remains the primary control surface
- A mobile maintenance shell now exists as an alternate view
- Mobile presentation is still partial, not full parity

## Current architecture

- Frontend: React 19 + Vite
- Backend: Node.js + Express
- Database: PostgreSQL
- Local integrations: IMAP, Google Calendar, Bouncie, DIMO, Teller, HCTRA, Android notification bridge

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
- live Bouncie/DIMO vehicle status views
- Google Calendar sync foundations
- Android bridge ingestion receiver

What is still evolving:
- mobile parity beyond maintenance
- stricter normalization of legacy trip status vs workflow stage
- better shared-expense attribution by historical fleet composition
- deeper DIMO signal interpretation and anomaly handling
- stronger notification-to-trip linking
- more complete docs for every subsystem

## Known gaps and rough edges

These are worth knowing before you trust the repo blindly.

### Documentation gaps
- The README had drifted behind the product shape; this file is catching up, but some subsystem docs are still implicit in code.
- There is not yet a dedicated operator handbook for common recovery/debug procedures.

### Local environment assumptions
- The app assumes a local Postgres-backed workflow.
- The schema repave file is intentionally destructive.
- Some workflows depend on real provider credentials and real local `.env` values.

### Frontend build/runtime caveats
- Vite wants Node `20.19+` or `22.12+`.
- Running with Node `22.9.0` may still work in some places, but it produces warnings and can trip local build behavior.
- Mobile access in dev is supported, but it depends on the Vite LAN host/proxy setup and a reachable local backend.

### Data quality reality
- Some legacy trip rows still carry stale raw `status` values even when `workflow_stage` and `queue_bucket` are correct.
- DIMO coverage varies by vehicle and available permissions/signals.
- Not every notification, email, or toll event can be perfectly linked on first pass.

## Install / repave

This repo includes a full blank-install path for a new workstation or a rebuild after data loss.

### Prerequisites

- Node.js `20.19+` or `22.12+`
- npm
- PostgreSQL with `psql` on PATH
- Git

Expected local ports:
- frontend: `5173`
- backend: `5000`

### 1. Clone

```bash
git clone <repo-url> Denmark2.0
cd Denmark2.0
```

### 2. Create the schema

Bootstrap file:

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
- it creates the default `denmark` database if needed
- it drops and recreates the public app schema
- it does not include private operational data
- it is destructive, so do not point it at a database you still need

### 3. Create `.env`

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

Minimal local values:

```dotenv
PGHOST=localhost
PGPORT=5432
PGDATABASE=denmark
PGUSER=postgres
PGPASSWORD=replace-with-local-postgres-password
DATABASE_URL=postgres://postgres:replace-with-local-postgres-password@localhost:5432/denmark

PORT=5000
VITE_API_BASE_URL=http://localhost:5000
FRONTEND_BASE_URL=http://localhost:5173
SESSION_SECRET=replace-with-long-random-session-secret
TOKEN_ENCRYPTION_KEY=replace-with-64-char-hex-or-long-random-secret
DENMARK_BRIDGE_SECRET=replace-with-shared-secret-for-android-bridge
```

Important integration values you will likely need later:
- `BOUNCIE_*`
- `DIMO_*`
- `GOOGLE_*`
- `IMAP_*`
- `EZTAG_*`
- `TELLER_*`

For DIMO, map known vehicles deliberately:

```dotenv
DIMO_FLEET_JSON=[{"tokenId":191373,"nickname":"Geneva","vin":"KMHTC6AD3GU260321","active":true}]
```

### 4. Install dependencies

Frontend:

```bash
npm install
```

Backend:

```bash
cd server
npm install
cd ..
```

### 5. Start the app

Backend:

```bash
cd server
npm start
```

Frontend:

```bash
npm run dev
```

Default local URLs:
- frontend: `http://localhost:5173`
- backend: `http://localhost:5000`

### 6. Verify basic health

Backend check:

```bash
curl http://localhost:5000/api/vehicles/live-status
```

Frontend build:

```bash
npm run build
```

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
