function describeLookupFailure(error) {
  const codes = [error?.code, ...(Array.isArray(error?.errors) ? error.errors.slice(0, 5).map(e => e?.code) : [])];
  let code = 'lookup_failed', message = 'Data lookup failed. This is not an empty result; the records have not been verified.';
  if (codes.includes('AI_INVALID_TOOL_ARGUMENTS') || error instanceof SyntaxError) {
    code = 'invalid_arguments'; message = 'Tool arguments were invalid. Correct the arguments and retry the read-only lookup; do not ask the user to reconfirm a known internal trip ID.';
  } else if (codes.includes('AI_RESULT_TOO_LARGE')) {
    code = 'result_too_large'; message = 'The lookup exceeded the AI evidence size limit. Request a smaller selection or category, or use SQL aggregates. No conclusion about missing records can be drawn.';
  } else if (codes.some(c => ['42703', '42P01', '42883'].includes(c))) {
    code = 'schema_error'; message = 'Query referenced an unknown table, column or function. Inspect database_schema before retrying. This does not mean the requested record is missing.';
  } else if (codes.includes('57014')) {
    code = 'query_timeout'; message = 'The database query timed out or was canceled. Try a narrower read-only lookup; this does not establish that telemetry is missing.';
  } else if (codes.includes('42501')) {
    code = 'database_permission_denied'; message = 'The database denied permission for this query. This is a database permission error, not evidence that the trip or telemetry is absent.';
  } else if (codes.some(c => ['ECONNREFUSED','ECONNRESET','ENOTFOUND','ETIMEDOUT','EPIPE','08000','08001','08003','08006','53300','57P01','57P02','57P03'].includes(c)) ||
      /timeout exceeded when trying to connect|connection terminated unexpectedly|connection terminated due to connection timeout/i.test(String(error?.message || ''))) {
    code = 'database_unavailable'; message = 'The database connection was unavailable. This is a connection failure, not missing telemetry access or a missing trip.';
  } else if (error?.statusCode === 404) {
    code = 'record_not_found'; message = 'The requested trip or snapshot was not found by this lookup. Verify the internal ID and lookup scope; do not generalize this to all telemetry.';
  }
  return { code, error: message };
}

function explicitTelemetryTripId(body, question) {
  if (body.telemetry_trip_id !== undefined) return body.telemetry_trip_id;
  if (!/telemetry|incident|collision|driving|braking|acceleration/i.test(question)) return undefined;
  const ids = [...question.matchAll(/\binternal\s+trip\s+ID\s*[:#]?\s*(\d+)\b/gi)].map(m => Number(m[1]));
  const unique = [...new Set(ids)];
  return unique.length === 1 && Number.isSafeInteger(unique[0]) && unique[0] > 0 ? unique[0] : undefined;
}
module.exports = { describeLookupFailure, explicitTelemetryTripId };
