# Denmark

Denmark is an operations console for a small Turo-centered vehicle fleet. It brings trips, messages, vehicle telemetry, maintenance, tolls, expenses, calendar sync, and sourcing work into one dispatch board.

The daily question it tries to answer is:

```text
What matters right now?
```

Denmark is actively used and actively evolving. It is not yet a polished self-service SaaS product, but it is close enough to start shaping around beta tenants when deployment, configuration, and onboarding are made more deliberate.

## What Denmark Does

- Dispatches open trips by urgency, status, pickup/return timing, and closeout needs.
- Ingests Turo-related email and Android notification bridge events.
- Tracks unread messages, operational notices, reimbursements, and customer-reported issues.
- Maintains fleet readiness, maintenance tasks, inspection exports, and availability windows.
- Integrates with Bouncie and DIMO for telemetry, location, odometer, and diagnostic signals where available.
- Shows live fleet map, trip ledger, trip path mini maps, mileage audit, and utilization metrics.
- Tracks expenses, tolls, reimbursements, trip financials, and business metrics.
- Syncs trip and maintenance events to Google Calendar when enabled.
- Supports marketplace listing intake and review workflow.
- Supports tenant backup/restore for migration and disaster recovery.

## Architecture

- Frontend: React + Vite
- Backend: Node.js + Express
- Database: PostgreSQL
- Deployment target: Docker Compose with a managed app container and local Postgres service
- Auth: local development bypass or OIDC-backed sessions, usually Google for beta tenants
- Settings storage: tenant-specific configuration in `app_settings`, plus deployment/runtime secrets in `.env`

Important directories:

- `src/` - React app and operator panels
- `server/routes/` - API routes
- `server/services/` - integrations, telemetry, scheduler, maintenance, metrics, and sync logic
- `setup/` - install, bootstrap, verify, restore tooling
- `FBMarketplaceUtil/` - browser extension utility for marketplace intake
- `docs/` - operator, deployment, and beta-readiness documentation

## Documentation

Use these documents by role:

- [Installation](docs/INSTALLATION.md) - deploy a managed tenant pod and keep it updated.
- [Initial Configuration](docs/INITIAL_CONFIGURATION.md) - first-run tenant setup, auth, vehicles, locations, integrations, alerts, and backup.
- [Usage Guide](docs/USAGE.md) - day-to-day operator workflow.
- [Beta Readiness Review](docs/BETA_READINESS.md) - current gaps before handing this to less technical users.
- [GHCR Deployment Notes](DEPLOY.md) - container publishing and image pull details.
- [Marketplace Utility](FBMarketplaceUtil/README.md) - browser extension setup.

## Quick Managed-Pod Install

On the tenant VM:

```bash
git clone https://github.com/thefirebuilds/denmark.git
cd denmark
cp .env.example .env
# edit .env with production secrets
bash setup/install.sh
```

Then open the tenant URL, sign in, and complete [Initial Configuration](docs/INITIAL_CONFIGURATION.md).

## Local Development

Local development uses the same backend and frontend, but usually runs with auth disabled:

```bash
cp .env.example .env
npm install
cd server && npm install && cd ..
psql -U postgres -d postgres -f server/db/schema.sql
cd server && npm run dev
```

In another terminal:

```bash
npm run dev
```

Default local URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:5000`

For a full local setup, see [Installation](docs/INSTALLATION.md).

## Current Product State

Solid enough for active host use:

- trip queue and trip workflow
- fleet snapshot and fleet map
- maintenance queue and readiness tracking
- Turo message ingestion
- Android bridge ingestion
- DIMO/Bouncie telemetry display
- mileage audit foundations
- toll and expense review
- Google Calendar sync foundations
- tenant backup/restore foundations

Needs attention before low-touch beta onboarding:

- first-run setup wizard/checklist
- clearer settings organization and integration status
- moving more optional integration config out of `.env`
- invite/user management UI
- safer defaults for schedulers and integrations in test tenants
- better empty-state and "not configured" guidance
- operator-facing recovery/debug docs

See [Beta Readiness Review](docs/BETA_READINESS.md) for the working list.

## Contact

The Denmark community loop is on Discord:

```text
https://discord.gg/qBnMQm3X
```

The most useful beta feedback is specific: what was confusing, what broke, what saved time, and what made the app feel trustworthy or not trustworthy.
