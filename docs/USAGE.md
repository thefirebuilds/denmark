# Usage Guide

This guide describes Denmark from the operator's point of view.

## Daily Start

1. Open the Dispatch board.
2. Review urgent open trips first.
3. Check unread messages and invoice/reimbursement notices.
4. Review Fleet Snapshot for cars out, cars available soon, and cars needing attention.
5. Open Maintenance Queue for tasks grouped by availability.
6. Check Fleet Map if location or telemetry freshness matters.

## Dispatch

The Dispatch board is the live queue. It is most useful for:

- upcoming pickups
- in-progress trips
- overdue closeouts
- unconfirmed or message-only reservations
- trips with blockers
- trips needing stage transitions

When a trip is completed, Denmark should return the operator to the live queue.

## Messages

Messages collect Turo email and Android notification bridge events.

Use the message queue to:

- find unread customer messages
- acknowledge operational notices
- edit the linked trip
- convert notes/issues into maintenance todos
- resolve maintenance notices
- mark individual or grouped items read

If unread items reappear after being marked read, that is usually a matching/deduplication bug or an item being recreated by an interval job.

## Fleet Snapshot

Fleet Snapshot is the quickest view of every car:

- current status
- current or estimated odometer
- availability window
- geo-location label if inside a configured location
- maintenance pressure
- 7-day utilization
- expanded mini-map and recent path context

Use telemetry odometer as a suggestion only. Manual trip audit remains the source of truth when the operator has corrected values.

## Fleet Map

Fleet Map shows:

- vehicle location
- configured location circles
- location labels
- telemetry freshness
- cars inside named locations
- recent trip pathing when available

If labels overlap or a location appears wrong, check Settings > Locations first.

## Maintenance Queue

Maintenance Queue is organized by vehicle availability. It should help answer:

```text
What can I fix today, and what has to wait until the car returns?
```

Tasks may come from:

- recurring maintenance rules
- customer notes
- Android/Turo notifications
- diagnostics
- manual todos

Click a todo to expand details, blockers, status, close action, or reassignment.

## Trip Ledger

Trip Ledger is for historical review and reconciliation:

- trip income and expenses
- tolls
- reimbursements
- start/end odometer
- DIMO OBD odometer suggestion when available
- GPS/path mini-map
- trip audit notes

Manual odometer corrections are authoritative. DIMO OBD values are strong suggestions when the vehicle reliably reports them. GPS estimate is a fallback.

## Metrics

Metrics help with:

- utilization
- vehicle profitability
- trip length and income patterns
- toll matching
- off-trip/unallocated miles
- business settings and vehicle profiles

Unallocated miles should be understood as:

```text
total miles - trip miles - off-trip miles
```

When available, OBD suggestions can help explain gaps but should not override manual audit decisions.

## Settings

Current settings sections:

- Dispatch - queue ordering and visible buckets
- Authentication - public URL and OAuth redirects
- Fleet - vehicle identity and telemetry identifiers
- Locations - named geofence circles
- Expenses - categories
- Marketplace - listing defaults and screening
- Website - public availability export
- Maintenance - alerts, database backup/restore, telemetry debug
- Logs - server log tail
- Integrations - Google Calendar, Teller, Mercury, DIMO status

Beta usability gap: these sections work, but they need a first-run checklist and clearer "required / optional / not configured" status.

## Backup And Restore

Use Settings > Maintenance > Database.

Recommended habit:

- create a backup after initial setup
- create a backup before major imports/restores
- download a backup periodically
- validate staged restore files before restoring

Restore replaces tenant data.
