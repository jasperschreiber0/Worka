export function approvedAttemptCeiling(scope: unknown, jobId: string, batchId: string): number {
 const s=scope as {job_id?:unknown;approved_batch_id?:unknown;approved_total_attempts?:unknown}|null
 return s?.job_id===jobId && s.approved_batch_id===batchId && s.approved_total_attempts===30 ? 30 : 20
}
