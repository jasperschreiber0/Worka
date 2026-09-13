# Tuesday profitability intelligence — release candidate

Status: deployed to production on 14 September 2026 (Australia/Sydney), initial release commit `546ba4c`. Additive migration applied successfully. Synthetic live financial checks passed; existing customer records were not modified. AI correspondence/post-mortems remain restricted by the existing single-job AI processing scope.

## What is included

- Business control centre and editable financial profile: simple/detailed overheads, net profit percentage/dollars, capacity, deterministic margin and break-even planning assumptions.
- Financial gate in estimate review and a job-level scenario editor, with correct margin/markup, overhead allocation, contingency and minimum/target prices.
- Original estimate/contract capture, actual-cost review, trade invoice/labour drill-down, reconciled profit waterfall and explicit completed-review confirmation.
- CSV/TSV/XLSX upload, worksheet/header selection, flexible mapping, preview, explicit GST/labour basis, date/amount validation, editable classifications, raw provenance and atomic duplicate-protected saving into the existing cost ledger.
- Correspondence paste and PDF/TXT/EML text extraction; metered AI structured extraction, source-excerpt validation and draft-only variation candidates. Sender and correspondence date must match source text; the ledger retains a readable trade label, unknown cost impact, approval at capture and a review action. Manual risk recording also works without AI.
- Existing variations can be linked to cost/recovery tracking. The existing variation approval workflow remains authoritative. No client messages are sent by this release.
- Project intelligence ledger combines existing proof events, correspondence, quotes, variations and actual costs. Builder notes, evidence, corrections and approvals remain attributable.
- AI profitability post-mortem selects and orders deterministic, evidence-backed findings, including shares of net overrun, incurred changes without an approved variation and explicit insufficient-history guidance. Free-form invented numerical or causal claims are not accepted.
- Completed review snapshots support weighted historical cost recommendations segmented by project type, region, construction type, complexity and size. Explicit Apply/Edit/Ignore; applying creates an audited separate draft allowance and preserves the trade's markup. Repeated application is blocked.
- 13-week cash-flow inputs and balances, lowest-cash point, deficit weeks and incomplete-input labelling.

## Verification

- Baseline: 740 existing tests passed before edits.
- Final unit suite: 753 passed, including 13 new financial/import cases.
- Isolated PGlite/PostgreSQL-compatible migration tests: 15 passed. Coverage includes RLS, forbidden browser writes/RPCs, cross-builder rejection, atomic rollback, duplicate imports, draft-only/idempotent variation creation, audited/idempotent learning and invalidation of stale reviews.
- Real Next.js route/XLSX integration with **local synthetic HTTP fixtures**: 14 passed. The actual XLSX reader parsed an uploaded workbook; explicit project GST declaration, mapping confirmation, GST conversion, cost refresh, completion, auth/ownership rejection and unavailable-AI handling were exercised. This is not a live Supabase/PostgREST test.
- Type-check and production build passed. Browser verified profile save/recalculation, job review, mobile-width layout and target-price/Healthy transition.
- Existing estimating worker, recovery, pricing and QA execution code was not rewritten. No estimate extraction, outbound messages, Xero exchange or paid AI validation calls were run.

## Production validation

- User approved deployment and synthetic validation. Production service-secret export was rejected by automatic approval review; no production service credential was exported. Tests used an isolated synthetic account and a public API key with server credentials kept on the server.
- Applied only the new profitability migration to Supabase `nfyuhsqvmmcdgbedhsxd`. Verified RLS on all six new tables, no anonymous reads/browser writes, and no browser execution of privileged financial RPCs. Advisors reported existing legacy warnings; none named the new profitability objects.
- Railway production: project `37df23dc-967b-41d9-8f29-72bf8419cb2e`, service `554b1557-ee25-4b3d-891d-abb200f8facd`, environment `c569dfba-ef1a-434a-97cb-f5bd3387a400`, domain `worka-production.up.railway.app`.
- Live authenticated checks passed: profile save, original baseline/GST reconciliation, XLSX import (68,310 including GST → 62,100 excluding GST), 13,900 framing variance, mapping-confirmed completion, comparable-job recommendation, explicit 130-dollar allowance application, and repeat-application rejection. Sessions were signed out and synthetic account/jobs removed.
- Both real AI requests were rejected before provider execution by `ai_processing_scope`, which still restricts processing to the previously authorised friend-test job. Global recovery controls were preserved. New AI calls now carry their actual job scope. Provider output validation remains pending a separately authorised change to that restriction.

## Known boundaries

- Updated against the replacement brief through section 25. Cash flow remains a supporting prototype; the estimate-to-actual-to-next-estimate loop is the release priority.
- All profitability calculations use AUD excluding GST. Each import starts with no GST basis selected and requires an explicit declaration. Projects require a source GST declaration and builder confirmation that estimate, contract, variations and costs have been reconciled to AUD excluding GST. Unclear or mixed historical records must be reconciled first. The project declaration never converts legacy values. Original import values and source rows are retained alongside the approved conversion.
- The 13 locked estimating trades remain unchanged. Specialist cost categories without a canonical match are explicitly unclassified until the builder chooses a trade. Financial totals retain those costs.
- The existing cost ledger only supports nonnegative amounts. Credit rows are rejected visibly, not silently removed or converted; reconcile credits before confirming final job costs. XLSX formulas must be replaced with verified values. Scanned correspondence without readable text must be pasted.
- Historical learning requires builder-confirmed review snapshots with explicit GST reconciliation and trade-mapping approval. Older snapshots missing these confirmations are excluded until reviewed again. It does not reinterpret old closeout records, change historical estimates or apply adjustments without approval. Labour hours are explicitly supplied, never inferred from cost. Material, labour and subcontract breakdowns remain unknown when the source lacks them.
- Cash flow is a scenario-based prototype of builder-entered expected bank movements; incomplete inputs are low confidence. It is not an accounting ledger, bank reconciliation engine or automatic payment forecast.
- Existing dependency audit debt remains in the older Next.js/tooling stack. The added ExcelJS UUID dependency was pinned to its patched 11.1.1 version; broad framework upgrades are outside this release.

## Local review

`node scripts/preview-profitability.cjs` starts an isolated sample at http://127.0.0.1:3221 with no external services or real credentials. Sample login: `builder@example.invalid` / `preview-password`. Its financial records reset when restarted. The preview intentionally does not simulate paid AI analysis.

`node scripts/test-profitability-api.cjs` tests that local fixture. `scripts/test-profitability-db.cjs` uses the `PGLITE_MODULE` environment variable for the existing locally installed PGlite runtime. Evidence: `tuesday-tests.log`, `tuesday-db-tests.json`, `tuesday-api-tests.json`, `tuesday-build.log`.

Rollback: restore the previous application commit through Railway while retaining the additive tables and all security restrictions. Do not drop financial data or restore broader privileges. The migration does not enroll or restart any estimating workflow.
