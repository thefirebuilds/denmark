export function parseMetricReportResponse(response, text, label = "Metrics") {
  if (!response.ok) throw new Error(`${label} request failed: ${response.status} ${text}`);
  const data = text ? JSON.parse(text) : null;
  if (response.status === 202 && data?.pending) {
    const error = new Error(data.message || 'Preparing saved metrics in the background.');
    error.reportPending = true;
    throw error;
  }
  return data;
}
