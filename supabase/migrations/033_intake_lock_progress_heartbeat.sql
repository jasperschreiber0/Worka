-- ============================================================
-- WorkA — job_intake_locks progress heartbeat
-- ============================================================
-- Context: a production incident showed smooth-responder's per-invocation
-- CPU budget (Supabase caps this at 2000ms/request) getting exhausted
-- during PDF text extraction, killing the isolate outright before its
-- try/finally could release job_intake_locks. That kill is external and
-- uncatchable, so it can happen almost immediately (well under a minute of
-- wall-clock time) — but the only staleness check available
-- (app/api/intake/[fileId]/route.ts's tryAcquireJobLock) only compared
-- against a fixed 16-minute age-since-acquired window, so a dead run's
-- lock sat unusable for up to 16 minutes regardless of how quickly it
-- actually died, then retried the identical crash forever.
--
-- last_progress_at is touched by the engine at every real stage/batch
-- boundary (see touchLockProgress in index.ts). This lets the Next.js
-- staleness check reclaim a lock based on "no progress observed for N
-- minutes" — much shorter and adaptive to what actually happened, rather
-- than always waiting the full fixed window regardless of whether the run
-- holding the lock is alive, genuinely slow, or already dead.
-- ============================================================

ALTER TABLE job_intake_locks
  ADD COLUMN IF NOT EXISTS last_progress_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN job_intake_locks.last_progress_at IS
  'Touched at each real stage/batch boundary inside the reasoning engine. Lets the Next.js lock-staleness check reclaim a lock quickly once a run has genuinely stopped making progress, instead of only ever waiting a fixed age-since-acquired window regardless of whether the run that holds it is still alive.';
