# Audit remediation — 20 September 2026

This release addresses trust and financial workflow defects. It does not claim the entire product wishlist is finished.

## Delivered

- Canonical open-job states exclude `complete` and `archived` from business rollups and quote follow-ups. Completed jobs without a current approved review surface for reconciliation.
- Legacy close-out now points to the reconciled profitability review; its write API returns 410. Completing that review atomically sets the job to `complete`. Unknown costs, outstanding commitments, missing labour rates, missing GST/mapping confirmation and a foreign baseline block completion.
- Cost and labour corrections require a reason, enforce owner/job/revision, preserve before/after evidence and invalidate stale forecasts/learning. Partial billing replaces the relevant portion of a commitment. Voiding retains the source row at zero.
- Money, business profit control and post-mortems share the same cost/labour basis. All labour is read, rather than the latest 100 entries.
- Quote dispatch rechecks the overhead margin. Below-overhead or unknown-overhead pricing needs a recorded reason. Pricing/profile changes require reopening the draft. No connected email provider means no sent status; rejected provider responses roll back the claim. Retries use Resend's 24-hour idempotency facility.
- Live quote drafts read the actual builder name column and do not fall back to sample business/client details.
- Worker task/photo/issue buttons no longer simulate successful saves. They show their current limitations.
- Legacy learned unit rates no longer override the server pricing context. Explicitly confirmed rates and approved historical allowances remain available.
- Standing CI now runs type checks, unit tests, isolated financial database tests and production compilation. Branch protection/deployment waiting for CI is not configured by this workflow itself.

## Migration

`20260920085157_audit_trust_and_financial_corrections.sql` replaces the completion RPC, adds the audited correction RPC, restricts direct browser writes on financial/legacy memory tables, enables RLS where required and pins previously-unconfigured non-extension application function search paths. No historical customer rows are rewritten. The hosted migration tool may record a different applied timestamp; match by migration name/content rather than replaying it.

## Validation

- 784 unit tests; TypeScript; production build.
- 34 isolated PostgreSQL-compatible checks across the profitability, profit-control and correction suites.
- Six local API scenarios: owned read, denied anonymous/foreign read, reason/staleness guard, retired close-out, real-profile draft with margin review, missing email configuration without sent status.
- Browser correction/save/reload and refreshed margin in an isolated signed-in fixture. No real email sent or customer account/job edited.

## Still open

- Targeted framework security upgrade requires the approval requested after automatic approval review rejected the combined upgrade command. Application dependencies are unchanged in this release; outstanding dependency advisories remain.
- Enable Supabase leaked-password protection using available plan/settings access. Three public-schema extension advisories require a separately tested compatibility migration. Nineteen RLS-with-no-policy notices are server-only tables; do not create broad client policies just to clear them.
- Historical PDF import into the older parametric estimator still needs an explicit draft/approval model and a review of existing unverified samples. This is separate from the approved profitability outcome workflow; do not describe every historical input as approved.
- Worker photo/issue/task writes, accounting reconciliation and real Xero connection remain unfinished. No integration was fabricated.
- An authenticated, customer-approved production journey and plan accuracy benchmark remain necessary before claiming independent pilot readiness.

Next: finish security upgrade and legacy historical-import approval, then observe one builder's real estimate → actual costs → variation → cash plan → completed review → next estimate. Compare the results with their workbook and record usability failures before expanding features.
