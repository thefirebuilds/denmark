# Business questions

The Open Trips panel includes “Ask about your business”. It uses the existing server `OPENAI_API_KEY` and the OpenAI Responses API. Set `OPENAI_BUSINESS_QUESTIONS_MODEL` to override the model; otherwise it uses `OPENAI_DAILY_BRIEF_MODEL`, then `gpt-4.1-mini`. No new npm dependencies or database migration are required.

Questions run only when submitted. Relevant records are sent to OpenAI with `store: false`. The app keeps the conversation in component memory, not the database, and allows downloading an answer with the exact records supplied to the model. Navigation or a reload clears the conversation. API usage uses the server's API account.

Supported evidence:

- Fleet names, aliases and IDs, including inactive vehicles for historical questions.
- Recorded expense searches with inclusive date ranges, vehicle filters, keyword matching and pagination. Totals are calculated over all matches by PostgreSQL as price plus tax; refunds remain negative. An invoice matching a tire vendor may include other services, so this is not necessarily an itemized tire-only total. Bank transactions that have not become expenses are not included.
- Current maintenance rule statuses and open tasks. The existing maintenance calculations run in read-only mode with stored odometer readings; no rule creation, task reconciliation or provider refresh is triggered.
- Trip counts and booked amounts by vehicle/status for trips starting in the selected period. These are not cash receipts or prorated revenue.

The endpoint requires expenses, maintenance, vehicles and trips read permissions using the existing authentication middleware. Lookups are allowlisted, parameterized, and run inside read-only transactions with statement timeouts. The model cannot submit SQL or update records. Guests' contact details, device credentials, and vehicle lockbox PINs are not part of the tools. Free-text expense notes are treated as data, not instructions.

Answers cite source IDs visible under “Records used”. Each source includes its filters and retrieval timestamp. Each lookup is a fresh read; the conversation is not a single database snapshot. Unknown history, empty results, lookup errors and unsupported questions should be described as limitations rather than invented facts.

Validation: `node --test server/test/businessQuestions.test.js`, `npm.cmd test` in `server`, and `npm.cmd run build` at the repository root. Test requests mock OpenAI and do not incur API charges.

API flow follows the [OpenAI function calling documentation](https://developers.openai.com/api/docs/guides/function-calling).
