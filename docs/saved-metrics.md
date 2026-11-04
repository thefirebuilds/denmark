# Saved metrics reports

Opening Metrics reads persisted reports instead of running aggregate queries.
Summary, vehicle and business reports refresh hourly. Trends, parking, home
transfers, off-trip audits, vehicle financial details and quarterly analysis
refresh every four hours. These intervals start after a successful calculation;
busy periods can delay them. Only reports requested in the last seven days are
eligible for scheduled refresh. Existing saved results remain available afterward.

The scheduler checks once per minute and processes at most one due report per
check. A shared analytical-work budget defers refresh when another metrics job
is running or the database pool is under pressure. A PostgreSQL advisory lock
also prevents overlapping saved-report calculations across application processes.
The lock uses a coordinator connection; calculators use their own connections.
This limits concurrency, but does not reduce the cost of an individual calculation
or preempt it if live traffic increases afterward.

Reports persist in `public.metric_report_cache`, created by the existing database
bootstrap and startup initialization. Deployments must complete that initialization
before serving reports. Report requests never create tables or indexes. No local
or production database migration is performed just by changing these files.

On a first request the API returns HTTP 202, without fabricated financial values.
The panel checks saved reports every 30 seconds while open. First calculations
can take several scheduler cycles. Responses include `_report` calculation and
refresh times. Failed refreshes retain the previous successful payload and retry
after 15 minutes. A crashed worker's attempt also becomes eligible after 15 minutes.

Live messages, trip actions and toll closeout eligibility retain their operational
paths. Toll audit details and explicit financial snapshot creation remain live,
subject to the analytical-work budget. The existing daily business snapshot
schedule now queues its calculation through the same worker.

Validate production behavior by comparing report refresh duration logs, pool
waiting, database wait events and host memory during a refresh. Tests and builds
verify behavior, but do not establish that production contention is resolved.
