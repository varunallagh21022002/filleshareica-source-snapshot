import type { Plan, PlanId } from './types';
export const PLANS: Plan[] = [
  {id: 'month', name: 'One month', amountPaise: 3000, months: 1},
  {id: 'six_months', name: 'Six months', amountPaise: 9000, months: 6},
  {id: 'year', name: 'One year', amountPaise: 15000, months: 12},
];
export const AD_ACCESS_MS = 60 * 60_000;
export const GRACE_MS = 15 * 60_000;
export const OFFLINE_LEASE_MS = 24 * 60 * 60_000;
export const DEVICE_REPLACEMENT_MS = 24 * 60 * 60_000;
export const FREE_SPEED_RATIO = 0.65;
export function getPlan(id: unknown): Plan {
  const plan = PLANS.find(plan => plan.id === id);
  if (!plan) throw new Error('Choose a valid prepaid plan.');
  return plan;
}
export function addPlanMonths(start: number, id: PlanId): number {
  const date = new Date(start); const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + getPlan(id).months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last)); return date.getTime();
}
