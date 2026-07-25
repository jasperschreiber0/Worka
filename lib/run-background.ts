// ─── Fire-and-forget background work ───────────────────────────────────────
// Railway runs WorkA as a persistent Node.js process (not serverless) — an
// un-awaited promise keeps running after the response is sent and will
// complete normally, no queue/worker system required. This helper exists so
// every "start this, don't wait for it" call site looks the same and can
// never accidentally regress into an `await` (which would put the work back
// on the request's critical path) or an unhandled rejection (which crashes
// the process). Not a task queue, not retried, not persisted — genuinely
// just "run this promise and log if it fails."

/**
 * Starts `work` without waiting for it. Any rejection is caught and logged
 * with `label` so a background failure is visible in logs but never surfaces
 * to the caller and never throws an unhandled rejection.
 */
export function runInBackground(label: string, work: () => Promise<unknown>): void {
  void work().catch((err) => {
    console.error(`[background:${label}] failed:`, err instanceof Error ? err.message : err)
  })
}
