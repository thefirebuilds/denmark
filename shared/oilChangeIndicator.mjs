export function getOilChangeIndicator(summary) {
  const rules = (summary?.ruleStatuses || []).filter(rule =>
    rule.ruleCode === 'oil_change' && ['due_soon', 'overdue'].includes(rule.status));
  if (!rules.length) return null;
  const current = summary?.currentOdometerMiles;
  const indicators = rules.map(rule => {
    const milesOver = current != null && current !== '' && rule.nextDueMiles != null && rule.nextDueMiles !== '' &&
      Number.isFinite(Number(current)) && Number.isFinite(Number(rule.nextDueMiles))
      ? Number(current) - Number(rule.nextDueMiles) : null;
    const label = rule.status === 'overdue' ? 'Oil change due' : 'Oil change due soon';
    return { tone: milesOver > 1000 ? 'red' : 'yellow',
      label: milesOver == null ? label : milesOver > 0
        ? `Oil change ${Math.round(milesOver).toLocaleString('en-US')} mi overdue`
        : milesOver === 0 ? 'Oil change due now'
        : `Oil change due in ${Math.round(-milesOver).toLocaleString('en-US')} mi` };
  });
  return indicators.find(indicator => indicator.tone === 'red') || indicators[0];
}
