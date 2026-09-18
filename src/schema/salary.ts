import type { Salary, SalaryPeriod } from './job.ts';

/** The same annual estimates used in the JobPosting structured data. */
export const PER_YEAR: Record<SalaryPeriod, number> = {
  hour: 2080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
};

/** Compare stated ranges; a remote listing may omit salary metadata entirely. */
export function annualisedTopSalary(salary: Salary | null | undefined): number {
  if (salary == null || salary.unpaid) return 0;
  return (salary.max ?? salary.min ?? 0) * (PER_YEAR[salary.period] ?? 1);
}
