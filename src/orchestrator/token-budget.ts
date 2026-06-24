// A persisted-counter budget check (NOT an in-process abortable budget): token totals are
// only known after each LLM call and the research cycle spans jobs. budget <= 0 = unlimited.
export function withinTokenBudget(cumulativeTokens: number, budgetTokens: number): boolean {
  return budgetTokens <= 0 || cumulativeTokens < budgetTokens;
}
