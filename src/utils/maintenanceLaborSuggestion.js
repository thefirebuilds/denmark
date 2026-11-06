export function laborSuggestionLabel(suggestion) {
  if (suggestion?.source === 'historical_mean') return `Average of ${suggestion.sampleCount} past completions of this maintenance type across the fleet. Adjust as needed.`;
  if (suggestion?.source === 'existing_actual') return 'Previously entered labor hours. Adjust as needed.';
  if (suggestion?.hours != null) return 'Task estimate; no matching labor history yet. Adjust as needed.';
  return 'No labor estimate available yet. Enter the time spent.';
}

export async function fetchLaborSuggestion(url, signal) {
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load labor estimate');
  return data;
}
