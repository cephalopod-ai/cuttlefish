import { getEmployeeSpendSince } from '../sessions/registry.js';

export type BudgetStatus = 'ok' | 'warning' | 'exceeded' | 'paused';

export function checkBudget(employee: string, budgetConfig: Record<string, number>): BudgetStatus {
  const limit = budgetConfig[employee];
  if (!limit) return 'ok';

  const now = new Date();
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

  const spend = getEmployeeSpendSince(employee, monthStart);

  const percent = limit > 0 ? Math.round((spend / limit) * 100) : 0;

  if (percent >= 100) return 'paused';
  if (percent >= 80) return 'warning';
  return 'ok';
}
