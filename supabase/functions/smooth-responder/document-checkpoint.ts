export function pendingDocumentIds(queued: string[], complete: string[]): string[] {
  const done = new Set(complete)
  return [...new Set(queued)].filter(id => !done.has(id))
}
