export function pendingDocumentIds(queued: string[], complete: string[]): string[] {
  const done = new Set(complete)
  return [...new Set(queued)].filter(id => !done.has(id))
}

/** Only new work in this invocation reserves time; cached chunks consumed no provider budget. */
export function classificationBudgetRequired(documentTimeoutMs: number, scopeTimeoutMs: number, madeProgressThisRun: boolean): number {
  return documentTimeoutMs + (madeProgressThisRun ? scopeTimeoutMs : 0)
}
