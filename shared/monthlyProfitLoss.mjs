export function buildMonthlyProfitLoss(report, excludeOnboarding = false) {
  const adjust = point => {
    const revenue = Number(point.revenue || 0);
    const onboarding = Number(point.onboarding_expenses || 0);
    const expenses = Number(point.expenses || 0) - (excludeOnboarding ? onboarding : 0);
    return { ...point, revenue, expenses, onboarding_expenses: onboarding, profit: revenue - expenses };
  };
  const history = new Map((report?.comparison_points || report?.points || []).map(point => [point.label.slice(0, 7), adjust(point)]));
  const points = (report?.points || []).map(raw => {
    const point = adjust(raw);
    const [year, month] = point.label.split('-').map(Number);
    const previousKey = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
    const previous = history.get(previousKey);
    const priorYear = history.get(`${year - 1}-${String(month).padStart(2, '0')}`);
    return { ...point,
      month_change: previous ? point.profit - previous.profit : null,
      year_change: priorYear ? point.profit - priorYear.profit : null,
    };
  });
  const summary = points.reduce((sum, point) => ({
    revenue: sum.revenue + point.revenue, expenses: sum.expenses + point.expenses,
    profit: sum.profit + point.profit, onboarding_expenses: sum.onboarding_expenses + point.onboarding_expenses,
  }), { revenue: 0, expenses: 0, profit: 0, onboarding_expenses: 0 });
  return { points, summary };
}
