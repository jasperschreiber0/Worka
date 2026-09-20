# Profit Control + Builder Intelligence release

## Inspection and build plan

Inspected GitHub main, Supabase nfyuhsqvmmcdgbedhsxd, active Edge Functions, RLS policies, migration history and Railway configuration on 20 September 2026. The existing profitability release already provided financial profiles, margin/markup education, a margin warning beside estimates, CSV/XLSX actual-cost imports, draft scope candidates, client-approved variations, an evidence ledger, completed review confirmation and explicit comparable-history allowances on future draft estimates. This release extends those paths.

1. Publish builder-confirmed forecasts over existing cost, labour and variation ledgers.
2. Surface margin leakage, incomplete forecasts, unbilled change costs and cash shortfalls in Today and Business.
3. Expose approved outcomes as the Builder Operating Profile, keeping learning approval explicit.
4. Add only supervisor date overlaps and subcontractor evidence expiry foundations.
5. Verify tenant boundaries and arithmetic, apply the additive migration, test/build the combined current main and deploy it through Railway.

## Behaviour

- Job profitability opens on Forecast & cash. An original priced baseline, explicit GST reconciliation, costed labour and builder confirmation are required before forecast margin is published.
- Forecast cost = incurred costs + outstanding commitments + remaining uncommitted work. The builder must ensure these are mutually exclusive. Cost to complete = commitments + remaining work.
- Forecast revenue = captured original contract + approved variations. Draft/pending variation charges are excluded. Tracked scope-risk costs are never subtracted a second time.
- Margin leakage = positive reduction in forecast gross profit against original estimated gross profit. It is an absolute profit bridge, not a revenue-normalised margin-rate variance.
- Forecast confirmation records the financial revision. Existing source-change triggers invalidate it when costs, hours, variations or profitability settings change. Optimistic revision checking rejects stale saves; rollup reads reject concurrent source revisions.
- Business totals state their coverage: confirmed active jobs across their full duration, before business overhead/tax. They are not annual recognised profit. Job cash is a separately dated manual record of receipts less payments including GST, never inferred from incurred costs.
- The existing manual 13-week cash plan now requires a start date and labels weekly dates. Shortfalls and missing/stale inputs surface in exceptions. It does not automatically import bank transactions or double-add job cash snapshots.
- Builder Operating Profile shows only completed reviews with builder-confirmed GST and trade mappings. Existing learning uses comparable job type, region, construction type, complexity and size; the builder applies or ignores a separate estimate allowance. Sparse history is not benchmark evidence.
- Supervisor date overlaps are prompts, not an automatic construction program. Evidence records cover licence, insurance, SWMS and worker-classification review references. No legal compliance determination is made. Review changes have a separate append-only history available to the owner via RLS.
- Existing quote/proposal exports and project evidence/decision ledgers are reused. Structural/anomaly suggestions remain drafts for qualified review. No new image rendering or autonomous client communication was introduced.

## Database and migration safety

Applied `20260920044222_profit_control_centre.sql` through the connected Supabase migration tool before application release. The filename was aligned to the actual recorded production version after the CLI generated the initial file.

- New `job_control_plans`, `worker_compliance_records`, `worker_compliance_events` tables, with RLS, authenticated owner-only SELECT, revoked browser writes, explicit service grants, and composite tenant foreign keys.
- New service-only, security-invoker RPCs `save_job_control_plan` and `record_worker_compliance`, each with a fixed search path and ownership checks.
- Restrictive policies on costs, labour, variations and invoices additionally verify referenced job ownership. Preflight found zero existing mismatches.
- The existing profitability migration was already recorded as `20260913193612`, while its repository file remains `20260913105546`. Several earlier numeric migration files likewise have timestamped production entries. These are historical ledger differences, not unapplied schema. Do not blindly replay them or auto-repair on an arbitrary duplicate-object error.
- All public tables already had RLS enabled. Existing internal tables with no browser policies remain inaccessible. No estimating migrations, worker deployment, locked trade categories, recovery controls or accounting credentials were changed.

## Verification

Run `npm test`, `npm run type-check`, `npm run build`.

`scripts/test-profit-control-db.cjs` runs ten isolated PostgreSQL-compatible checks using PGlite, including cross-tenant job references, supervisor references, RLS reads/writes, anonymous denial, stale confirmations, incomplete data and audit history. `scripts/test-profitability-db.cjs` preserves the fifteen existing financial import/learning/approval tests.

Start `node scripts/preview-profitability.cjs` and run `node scripts/test-profit-control-api.cjs` against a fresh fixture for eight HTTP checks. Restart the fixture before running the existing `scripts/test-profitability-api.cjs`; both tests intentionally capture an immutable original baseline and are not repeatable against the same populated fixture.

The final deployment commit and production verification evidence are recorded in the delivery report. Test fixtures are explicitly synthetic and must never be used as business facts.

## Manual connection steps and limits

Railway source is `jasperschreiber0/Worka`, branch main, service `554b1557-ee25-4b3d-891d-abb200f8facd`. Verified domains: `worka-production.up.railway.app`, `getworka.com`, `www.getworka.com`. Vercel is not the live target.

No Xero credentials or organisations were present. Existing integration remains disabled until `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_TOKEN_ENCRYPTION_KEY` (and optional `XERO_OAUTH_STATE_SECRET`) are configured on Railway, the actual app callback URL in the existing Xero route is registered, and an OAuth/test-organisation exchange is verified before setting `XERO_ENABLED=true`. Retain the existing import review/mapping approval boundary; do not assume synchronisation has occurred.

Builders must enter overheads, dated cash assumptions, original baselines and reconciled costs before complete forecasts can appear. Historical outcomes require explicit completion approval. Existing dependency-audit and database-advisor warnings remain outside this additive feature release; new database objects must not introduce advisor findings.

Next phase: reconciled accounting receipts/payments and committed-cost settlement, then estimate-derived trade scheduling with dependencies and versioned client selections. Prioritise real financial completeness over additional dashboards.

Rollback: deploy the previous application commit while retaining additive tables and stronger RLS. Do not drop captured financial data or relax tenant protections.
