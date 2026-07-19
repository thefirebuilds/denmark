# Initial Configuration

This is the first-run tenant checklist for a less technical operator. The goal is to get the tenant from "installed" to "useful" without editing code.

## 1. Sign In And Set Public URL

Open Denmark at the tenant URL.

In Settings > Authentication:

1. Set the public app base URL, for example `https://denmark.example.com`.
2. Copy the computed login redirect URI into the Google Cloud OAuth client.
3. If Google Calendar sync will use the same Google client, copy the computed Calendar redirect URI too.
4. Sign out and back in once to verify the redirect lands on the tenant URL.

Expected Google redirect URIs:

```text
https://tenant.example.com/api/auth/callback
https://tenant.example.com/api/integrations/google-calendar/callback
```

## 2. Add Users

Today, the practical beta path is owner-gated:

- `AUTH_OWNER_EMAILS` in `.env` grants initial owner access.
- Authenticated users are stored in `app_users` after sign-in.

Current gap: there is no polished invite/user management panel. For beta, the managed-pod operator should create the tenant, sign in as owner, then manually promote or allow users until the user admin UI exists.

Recommended beta improvement:

- Settings > Users
- Invite by email
- Role choices: owner, operator, read-only
- Disable/remove user
- Last login and audit log

## 3. Fleet Setup

In Settings > Fleet:

1. Add every active vehicle.
2. Set nickname, VIN, plate, Turo vehicle ID, and active/in-service flags.
3. Add DIMO token ID where available.
4. Add Bouncie identifier where available.
5. Add current odometer if telemetry is absent or unreliable.
6. Add lockbox/PIN and inspection details if used in daily workflow.

Good first validation:

- Fleet Snapshot shows all cars.
- Fleet Map shows cars with sensible last-seen status.
- Vehicles without telemetry still appear as manually managed vehicles.

## 4. Locations

In Settings > Locations:

1. Add home base, parking lots, garages, and airport zones.
2. Use a friendly name.
3. Set radius.
4. Enable map display and alerting only where useful.

These names replace generic parked/location labels in fleet panels when a vehicle is inside the configured circle.

## 5. Trip And Message Intake

For Turo email ingestion, configure IMAP in Settings > Messages & Inbox.
Denmark stores the IMAP password encrypted in `app_settings` using
`TOKEN_ENCRYPTION_KEY`, so set that key before saving tenant credentials.

`.env` can still provide bootstrap/default values:

```dotenv
IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_USER=turo_msg@example.com
IMAP_PASS=app-password
IMAP_TARGET_MAILBOXES=INBOX
```

Then verify:

- Messages panel loads.
- Recent Turo messages appear.
- Open Trips panel shows reservations discovered from email.
- Message-only stub trips are reviewed and corrected where needed.

After saving in Settings, the database row should contain `passEncrypted`, not
plain `pass`.

## 6. Android Notification Bridge

In Settings > Maintenance > Alerts:

1. Enable or disable Android notification bridge.
2. Set heartbeat stale timing.
3. Set Turo notification stale timing.

The phone/bridge sends to:

```text
https://tenant.example.com/api/notifications/turo
```

With header:

```text
X-Denmark-Bridge-Secret: <DENMARK_BRIDGE_SECRET>
```

If a tenant does not use the bridge, turn it off so stale-heartbeat notices and raw bridge feeds stay quiet.

## 7. Text Alerts

In Settings > Maintenance > Alerts:

1. Enable or disable SMS alerts.
2. Enter Twilio account SID, auth token/client secret, sender number, and receiver number.
3. Click Send Test.

Legacy `TWILIO_*` env vars are still used as fallback until tenant settings are saved.
After saving in Settings, the database row should contain `authTokenEncrypted`,
not plain `authToken`, `auth_token`, `clientSecret`, or `client_secret`.

## 8. Google Calendar

In Settings > Integrations:

1. Confirm Google is configured.
2. Reconnect Google Calendar.
3. Enable or disable calendar sync for this tenant.
4. Run trip reconcile.
5. Use the duplicate cleanup tool if this tenant and another tenant have both written events.

Beta default recommendation:

- enable Google Calendar only on the production tenant
- disable it on local/test tenants

## 9. Telemetry

DIMO credentials still come from `.env`:

```dotenv
DIMO_CLIENT_ID=
DIMO_REDIRECT_URL=
DIMO_API_KEY=
DIMO_SHARE_TARGET=
```

In Settings > Fleet, assign DIMO token IDs to vehicles. In Settings > Maintenance > Telemetry, verify the DIMO fleet intersection.

Bouncie credentials still come from `.env`:

```dotenv
BOUNCIE_CLIENT_ID=
BOUNCIE_CLIENT_SECRET=
BOUNCIE_AUTH_CODE=
BOUNCIE_REDIRECT_URI=
```

Current gap: DIMO and Bouncie credential setup should move into guided integration panels, with provider status and reconnect flows.

## 10. Expenses, Tolls, and Banking

In Settings > Expenses:

- Review categories.
- Add tenant-specific expense categories.

Plaid credentials are saved through the encrypted integration settings panel. Mercury continues to use its direct API credential and does not route through Plaid.

## 11. Backup

In Settings > Maintenance > Database:

1. Create a backup.
2. Confirm the backup summary counts vehicles, trips, messages, and telemetry.
3. Download the file.
4. Keep a copy outside the VM.

Before beta onboarding, each tenant should have a known-good backup and restore path.

## Minimum Useful Tenant

For a first beta user, the smallest useful configuration is:

- login works
- vehicles added
- Turo email intake works
- trips/messages populate
- maintenance queue works
- backup works

Telemetry, SMS, Android bridge, banking, marketplace, public website export, and calendar sync can be optional add-ons.
