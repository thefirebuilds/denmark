# Maintenance labor suggestions

Closing a standard maintenance task or saving a board inspection prefills editable labor hours using the mean of the **20 most recent positive actual-hour records for the same maintenance rule across the fleet**. The helper text or close-task prompt shows how many completions were used.

Only completed events and resolved non-custom tasks are eligible. Future-dated events, scheduled/void/review events, not-applicable results, and zero/missing hours do not train the average. Estimates are not treated as recorded actuals. A resolved task linked to a completed maintenance event is counted once, preferring the event. Existing maintenance task-to-rule aliases are shared by resolution and suggestions.

If there is no usable history, the task's existing positive estimate or the existing rule/title-based preset is used. If neither exists, the input stays blank rather than inventing zero hours. Existing positive actuals are preserved. Manual custom to-dos retain their own values and do not use this averaging workflow.

The suggestion is requested only when opening the inspection drawer or closing a task, not on a polling interval. A five-second frontend deadline prevents an unavailable suggestion from blocking the workflow indefinitely. A delayed response does not overwrite hours the user has already edited. Values are saved only after normal user confirmation; the suggestion endpoint itself is read-only and requires the existing maintenance read permission. No schema or infrastructure change is required.
