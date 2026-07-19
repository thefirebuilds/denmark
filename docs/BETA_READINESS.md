# Beta Readiness Review

This review assumes Denmark is offered as a fully managed tenant pod, not as a self-hosted open-source project that customers debug themselves.

## Executive Read

Denmark is close to useful beta, but not yet low-touch beta.

The app has real operator value today: dispatch, messages, fleet status, maintenance, telemetry, trip ledger, toll/expense review, and backup/restore. The biggest beta risk is not core usefulness. The biggest risk is setup complexity and unclear configuration ownership.

For a less technical tenant, the product needs:

1. A guided first-run path.
2. Better distinction between required setup and optional integrations.
3. Fewer credentials hidden in `.env`.
4. Tenant/user management.
5. Clear integration health and disable switches.
6. Backup/restore confidence checks.

## 1. Deployment And Standup

### What Is In Good Shape

- Docker Compose can run app + Postgres.
- `setup/install.sh` starts Postgres, waits for readiness, bootstraps, verifies, and only starts the app after success.
- `setup/bootstrap-db.js` and `setup/verify-db-bootstrap.js` support fresh database standup.
- GHCR image publishing exists.
- `.env.example` is fairly comprehensive.
- Backup/restore can move tenant data through Postgres custom dumps.

### Gaps

- `.env` still carries too many tenant-facing integration settings.
- First install does not create a browser-based setup wizard.
- `DEPLOY.md`, README, and settings UI have overlapping instructions.
- Some deployment settings are truly runtime secrets, while others are business preferences and should be editable in Settings.
- Reverse proxy and Google OAuth redirect setup still require operator knowledge.
- There is no "tenant readiness" screen that says what is missing.

### Highest-Leverage Fixes

- Add a `/setup` or Settings landing checklist with:
  - Public URL configured
  - Owner user present
  - Fleet has at least one active vehicle
  - IMAP configured or intentionally skipped
  - Backup tested
  - Calendar enabled/disabled
  - SMS enabled/disabled
  - Android bridge enabled/disabled
  - DIMO/Bouncie configured/skipped
- Move these from `.env` to tenant settings where practical:
  - IMAP connection
  - Bouncie credentials/reconnect
  - DIMO credentials/share target
  - Google Calendar sync enablement and reconnect status already partly exists; continue polishing
  - public availability push target/secrets
  - parking economics defaults
  - OpenAI FMV model/market label if used
- Keep these in `.env`:
  - database connection
  - session secret
  - token encryption key
  - initial owner emails
  - provider client secrets until a secure secret store is added

## 2. New User Setup

### Current Path

1. Managed operator deploys tenant.
2. `.env` contains `AUTH_OWNER_EMAILS`.
3. User signs in through Google/OIDC.
4. App records the authenticated user.
5. The owner configures fleet/settings.

### Gaps

- No user invite/admin panel.
- No role management UI.
- No clear first-run wizard.
- No clear "safe local/test tenant" mode from inside the app.
- Owner must understand Google Cloud redirect URIs.

### Recommended Beta User Model

For the first beta:

- Managed operator provisions tenant and first owner.
- Owner signs in with Google.
- Owner configures fleet and integrations with guided checklist.
- Additional users are added by managed support or a simple Settings > Users panel.

Minimal roles:

- Owner: settings, users, backup/restore, integrations
- Operator: trips, messages, maintenance, fleet edits
- Viewer: read-only dashboards and trip ledger

## 3. Integrations And Immediate Value

### Best Beta Value

These likely provide the greatest "wow, this saves time" value:

- Turo email ingestion into messages/trips
- Open trip dispatch queue
- Maintenance queue by vehicle availability
- Fleet Snapshot and Fleet Map
- Trip Ledger with odometer/toll/reimbursement context
- Backup/restore
- Google Calendar sync if dedupe/removal is reliable
- Android bridge only for users willing to set up the phone component

### Should Be Optional At First

- Plaid and Mercury banking
- HCTRA/EZ TAG sync
- Marketplace utility
- OpenAI FMV enrichment
- Public availability export
- Bouncie/DIMO telemetry, unless the user already has those devices/accounts

### Usability Gaps

- Integrations need status cards: Not configured, Connected, Needs attention, Disabled.
- Every scheduler-driven integration needs an obvious enabled/disabled switch.
- Calendar cleanup/removal needs more confidence before beta because duplicate events damage trust quickly.
- Messages "mark all as read" and recurring alert reappearance should be hardened before beta.
- Maintenance todos should consistently expand to show notes/blockers/status/reassign.
- DIMO/Bouncie telemetry should be framed as advisory when signals are missing or stale.

## 4. Settings Organization

### Current Sections

- Dispatch
- Authentication
- Fleet
- Locations
- Expenses
- Marketplace
- Website
- Maintenance
- Logs
- Integrations

### Suggested Beta Organization

- Setup Checklist
- Users & Access
- Fleet
- Trips & Dispatch
- Messages & Inbox
- Maintenance
- Locations
- Alerts
- Integrations
- Backup & Restore
- Advanced / Logs

Rationale: a less technical user does not think "Maintenance contains database backup, telemetry debug, Android alerts, and SMS settings." Those should be easier to find.

## 5. Data And Trust

### Positive

- Empty database bootstrap now exists.
- Restore validation exists.
- Backup summaries expose row counts.
- Trip ledger is gaining audit context.
- Manual odometer edits remain authoritative.

### Gaps

- Backup/restore should compare source summary to restored summary after completion.
- Restore should produce a simple success report:
  - vehicles
  - trips
  - messages
  - telemetry snapshots
  - maintenance tasks
  - settings
- Calendar dedupe should identify tenant-created events by stable metadata and avoid deleting user-created events.
- Integration failures should degrade panels instead of causing startup/loading flapping.

## 6. Beta Acceptance Checklist

Before onboarding a nontechnical beta tenant:

- Fresh pod install succeeds from docs.
- Login works with the tenant domain.
- First-run checklist exists or support has a runbook.
- User can add vehicles without SQL.
- User can configure or skip every major integration from UI.
- App works with no DIMO/Bouncie.
- App works with no Android bridge.
- App works with no Google Calendar.
- Messages/trips can be useful from IMAP alone.
- Backup creates a file and restore verifies row counts.
- Calendar sync can be disabled per tenant.
- SMS alerts can be disabled per tenant.
- Android stale alerts are fully gated by the bridge enabled setting.
- Logs/settings expose enough diagnostics for support.

## Recommended Next Implementation Order

1. Setup Checklist panel.
2. Users & Access panel.
3. IMAP settings panel with test connection.
4. Integration status cards and global per-integration enable switches.
5. Backup restore post-restore count verification.
6. Calendar dedupe/removal hardening.
7. Settings reorganization.
8. Marketplace utility tenant URL packaging.
9. Bouncie/DIMO guided setup.
10. Operator handbook for common support cases.

## Beta Positioning

Pitch Denmark first as an operator console, not an all-in-one autopilot.

The cleanest beta promise:

```text
Denmark helps a Turo host see trips, messages, fleet readiness, maintenance, and mileage/audit context in one place.
```

Avoid making telemetry, banking, marketplace, or public website export required for first success.
