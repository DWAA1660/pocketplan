// All arithmetic stays in cents. Transfers move money without counting as spending.
export function carryoverBalance(firstMonth: string, targetMonth: string, defaultAllowance: number, allowances: Map<string, number>, spending: Map<string, number>, transfers: Map<string, number>) {
  const index = (month: string) => { const [year, number] = month.split('-').map(Number); return year * 12 + number - 1; };
  let balance = 0;
  let allowance = defaultAllowance;
  for (let cursor = index(firstMonth); cursor < index(targetMonth); cursor++) {
    const month = `${Math.floor(cursor / 12)}-${String(cursor % 12 + 1).padStart(2, '0')}`;
    allowance = allowances.get(month) ?? allowance;
    balance += allowance + (transfers.get(month) ?? 0) - (spending.get(month) ?? 0);
  }
  return balance;
}
