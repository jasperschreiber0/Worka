/** Keep continuation tied to one explicit batch; never fall back to a sweep. */
export function requestedEstimateBatch(value: string | null): string | null {
 return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null
}
export function documentWorkerCount(documentCount: number): number {
 return Number.isInteger(documentCount) && documentCount > 0 ? Math.min(3, documentCount) : 0
}
