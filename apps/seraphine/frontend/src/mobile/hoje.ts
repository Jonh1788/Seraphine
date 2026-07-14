export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

export function monthExpenses(
  entries: { amount: number; kind?: string; type?: string; date?: string; ts?: string }[],
  now: Date,
): number {
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return entries
    .filter((e) => (e.kind ?? e.type) === 'expense')
    .filter((e) => ((e.date ?? e.ts) || '').startsWith(ym))
    .reduce((s, e) => s + Math.abs(e.amount || 0), 0);
}
