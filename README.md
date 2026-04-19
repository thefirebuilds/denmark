# Denmark2.0

Denmark2.0 is an operations and intelligence platform for running a small vehicle fleet business with a strong focus on **Turo hosting, vehicle tracking, reservation awareness, telemetry, profitability, and acquisition workflow**.

The project pulls together data that normally lives in too many separate places — booking platforms, telematics providers, financial systems, marketplace listings, and internal notes — and turns it into something operationally useful.

This is not just a dashboard.  
It is meant to become the **single working surface for managing a real-world fleet**: where the cars are, whether they are booked, what they are earning, what they cost, what condition they are in, and whether a prospective vehicle is worth buying.

---

## Mission

The mission of Denmark2.0 is to help a small fleet operator make better decisions, faster, with less manual digging.

That includes:

- understanding fleet health at a glance
- reconciling bookings with real vehicles
- tracking telemetry and odometer movement
- identifying utilization and downtime
- monitoring revenue and expenses
- evaluating marketplace vehicles for expansion
- reducing the amount of “spreadsheet plus gut feeling” required to run the business

The long-term goal is a unified platform for **fleet visibility, decision support, and operational control**.

---

## Current Capabilities

### Fleet and vehicle management
- Stores and displays a working fleet of vehicles
- Associates internal vehicle records with external platform identifiers
- Supports vehicle nicknames and internal labeling for operational use
- Tracks fields like VIN, odometer, and linked provider IDs

### Booking and trip awareness
- Ingests and works with trip / reservation data
- Matches bookings to vehicles where possible
- Supports booking status visibility and reconciliation
- Handles edge cases where trip metadata may be incomplete or inconsistent

### Telematics integration
- Integrates with telematics providers including:
  - **Bouncie**
  - **DIMO** (in progress / expanding)
- Pulls available vehicle telemetry such as:
  - location
  - ignition state
  - temperature
  - heading
  - voltage
  - odometer-related data where available
- Designed to be resilient when some signals are unavailable or unauthorized rather than failing hard

### Snapshotting and historical tracking
- Captures operational snapshots over time
- Supports telemetry snapshot ingestion
- Enables comparison of historical vehicle state and movement
- Intended to support trend analysis rather than only “latest known value”

### Metrics and analytics
- Surfaces vehicle-level metrics over date ranges
- Supports analysis around:
  - mileage movement
  - utilization
  - trip deltas
  - inferred downtime / blackout periods
  - revenue-oriented comparisons
- Includes work toward payoff pace / performance comparison views

### Marketplace sourcing workflow
- Scrapes and ingests external vehicle listings from:
  - **Facebook Marketplace**
  - **Cars.com**
- Stores listings in a database for review
- Supports review and filtering of candidate cars
- Includes ignore / suppression workflow for junk listings and unwanted keywords
- Built to support “is this a good buy for the fleet?” rather than passive browsing

### Financial visibility
- Pulls financial transaction data from connected providers such as:
  - **Teller**
- Intended to connect real expenses and cash movement back to fleet operations
- Supports categorization and review of business-related transactions

### Ops-oriented UI
- React-based frontend for working views and panels
- Detail panel workflow for reviewing specific cars and listings
- Sorting and filtering for operational triage
- Built for dense, real-world usage rather than pretty demo screenshots

---

## What Problem This Project Solves

Running a Turo or small rental fleet usually means living in five different systems at once:

- booking platform
- telematics app
- bank account
- maintenance notes
- marketplace tabs
- and usually at least one cursed spreadsheet

Denmark2.0 exists to reduce that chaos.

Instead of checking each system separately and trying to mentally reconcile everything, the platform aims to answer questions like:

- Which vehicles are actually active right now?
- Which car is booked, idle, missing, or underperforming?
- What has each vehicle done lately?
- What is each car costing vs. earning?
- Is this marketplace listing worth chasing?
- Are my data sources agreeing with each other?
- Where do I need to pay attention today?

---

## Architecture

While the implementation is still evolving, the current stack is centered around:

- **Frontend:** React / Vite
- **Backend:** Node.js / Express-style API services
- **Database:** PostgreSQL
- **Data ingestion:** provider APIs, polling jobs, and scraper pipelines
- **Deployment / infra work:** local development with ongoing CI/CD and containerized patterns in related parts of the project

The system is designed around a practical separation of concerns:

- provider clients and ingestion jobs
- API routes for normalized data access
- database-backed persistence
- frontend panels for operational decision-making

---

## First Install / Repave Path

This repo includes a schema-only PostgreSQL bootstrap file for rebuilding the app from an empty machine or after total local data loss.

### 1. Create the database schema

The bootstrap file lives at:

```text
server/db/schema.sql
```

It creates the default `denmark` database if it does not exist, connects to it, drops/recreates the public app schema, and inserts safe default UI settings. It does **not** include private data, vehicle history, bank data, tokens, guest data, or marketplace rows.

Run it from the repo root with a PostgreSQL admin user:

```bash
psql -U postgres -d postgres -f server/db/schema.sql
```

If your local database should use a name other than `denmark`, edit the `\set dbname denmark` line at the top of `server/db/schema.sql`, then make the same change in `.env`.

This file is intentionally useful for repaving, so treat it as destructive when pointed at an existing database.

### 2. Create `.env`

Copy the checked-in example:

```bash
cp .env.example .env
```

Then replace the placeholder values. A safe example looks like this:

```dotenv
PGHOST=localhost
PGPORT=5432
PGDATABASE=denmark
PGUSER=postgres
PGPASSWORD=replace-with-local-postgres-password
DATABASE_URL=postgres://postgres:replace-with-local-postgres-password@localhost:5432/denmark

VITE_API_BASE_URL=http://localhost:5000

IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_USER=alerts@example.com
IMAP_PASS=replace-with-imap-app-password
IMAP_TARGET_MAILBOXES=INBOX
IMAP_LOOKBACK_HOURS=72
IMAP_INGEST_LIMIT=100

BOUNCIE_CLIENT_ID=replace-with-bouncie-client-id
BOUNCIE_CLIENT_SECRET=replace-with-bouncie-client-secret
BOUNCIE_AUTH_CODE=replace-with-one-time-auth-code
BOUNCIE_REDIRECT_URI=http://localhost:5000/api/bouncie/callback

DIMO_CLIENT_ID=replace-with-dimo-client-id
DIMO_DOMAIN=replace-with-dimo-domain
DIMO_PRIVATE_KEY=replace-with-dimo-private-key
DIMO_FLEET_JSON=[]

TELLER_CERT_BASE64=replace-with-base64-client-cert
TELLER_KEY_BASE64=replace-with-base64-client-key

EZTAG_USERNAME=replace-with-eztag-username
EZTAG_PASSWORD=replace-with-eztag-password
EZTAG_USER_AGENT=Mozilla/5.0 Denmark2.0 local dev

PUBLIC_AVAILABILITY_INGEST_URL=https://example.com/api/availability
PUBLIC_AVAILABILITY_BEARER_TOKEN=replace-with-public-availability-token
PUBLIC_AVAILABILITY_HMAC_SECRET=replace-with-public-availability-hmac-secret
```

Never commit a real `.env`; it contains credentials and provider tokens.

### 3. Install dependencies

Install frontend dependencies from the repo root:

```bash
npm install
```

Install backend dependencies:

```bash
cd server
npm install
```

### 4. Start the app

Start the backend:

```bash
cd server
npm start
```

Start the frontend from the repo root:

```bash
npm run dev
```

The frontend defaults to `http://localhost:5173`, and the backend defaults to `http://localhost:5000`.

### 5. Restoring real data later

The Settings screen includes a database backup/restore workflow for JSON snapshots created by this app. The SQL schema is the blank foundation; the backup/restore flow is for bringing back actual operational data when you have a saved snapshot.

---

## Integrations

### Platform / operations
- Turo-related reservation and vehicle context
- Internal fleet mapping and nickname management

### Telematics
- Bouncie
- DIMO

### Financial
- Teller

### Vehicle sourcing
- Facebook Marketplace
- Cars.com

---

## Design Philosophy

This project is opinionated.

It is being built for actual daily use, which means:

- resilience matters more than elegance
- partial data is better than broken pages
- ugly truth is better than pretty lies
- workflows should favor speed and triage
- every screen should answer an operational question

In other words: if a provider returns incomplete junk, the app should note it and move on — not fall on its face.

---

## Current State

Denmark2.0 is an active working project, not a polished SaaS product.

Some areas are already useful in day-to-day operations. Others are still being hardened, expanded, or cleaned up. The project currently includes a mix of:

- production-useful workflows
- in-progress integrations
- UI improvements
- schema / matching logic refinement
- operational debugging and data-quality fixes

That is normal for the stage it is in.

---

## Planned / Emerging Direction

The current trajectory suggests Denmark2.0 will continue toward:

- stronger reservation-to-vehicle matching
- deeper telemetry coverage across providers
- better historical analytics and trend views
- maintenance and condition tracking
- richer financial attribution by vehicle
- smarter marketplace scoring and buy recommendations
- improved filtering, notes, and decision-support tools
- a more complete “fleet command center” experience

---

## Who This Is For

This project is primarily built for a small, hands-on fleet operator who needs:

- operational clarity
- acquisition support
- telemetry visibility
- booking awareness
- financial context
- less manual nonsense

It is especially suited to someone running a Turo-style fleet and making frequent decisions about utilization, maintenance, sourcing, and expansion.

---

## Why the Name?

Because every serious project deserves a codename, and this one grew into something much bigger than a few scripts.

---

## Status

**Actively developed**

This repository reflects an evolving real-world operations platform. Expect active changes, shifting priorities, and occasional rough edges while the system is being shaped around actual fleet needs.

---

## Notes

If you are looking at this repo from the outside, the most important thing to understand is that Denmark2.0 is not trying to be generic fleet software.

It is trying to be **useful**.

That means the codebase is shaped by real operational pain:
- missing provider data
- flaky identifiers
- weird booking edge cases
- bad marketplace noise
- financial ambiguity
- and the constant need to answer “what matters right now?”

That is the heart of the project.
