# Cash planning release

Business → 13-week cash flow now offers a dated manual cash plan. Opening cash is explicitly tied to named business accounts and a start-of-day date. The view shows lowest projected cash, buffer headroom, weekly closing chart, week drill-down, and first-fortnight daily balances. Payments retain contractual and expected dates, notes, and optional weekly/fortnightly/monthly recurrence with an end date. Month-end recurrence clamps to the last day without drifting. Cash is GST-inclusive bank movement, separate from profit calculations.

Late-receipt scenarios shift the whole selected receipt/series and never mutate the base plan. Receipts outside the horizon are excluded explicitly. Saved-plan comparisons show changes in projected low and ending balance, not actual-versus-forecast performance. Weekly CSV export opens in Excel.

The North East workbook importer reads cached Cashflow Summary values only, requires 13 consecutive week-ending columns, checks each closing balance and roll-forward, and previews totals and caveats before replacing the unsaved draft. It excludes other-account and credit totals, flags card/transfer and timing review, and never evaluates workbook formulas or uploads the original to storage. Main-account weekly totals are placed on week end with uncertain daily timing. Existing WorkA weekly forecasts convert to draft allowances without being silently saved. A detailed bill should replace its allowance, not be added alongside it.

## Persistence and security

No migration: use the existing owner-isolated business_financial_profiles.cash_flow JSONB column. The versioned plan lives alongside server-derived opening/start/completeness/13-week totals consumed by existing Today and business views. Anonymous access denied; builder identity comes from auth. Server validation normalizes the submitted shape. Updates compare updated_at and reject concurrent edits; inserts use the existing builder primary key. Legacy cash writes cannot overwrite a detailed plan. Existing RLS verified enabled, owner SELECT policy, no anonymous read or browser UPDATE privilege. File upload limits: 5 MB compressed, 30 MB advertised expanded ZIP size, 2,000 archive members. No new dependencies, accounting credentials, messages, AI calls, or customer fixtures.

## Validation

- Unit coverage: daily shortfall hidden by weekly closing; opening low; cent arithmetic; delayed receipt outside horizon; monthly/weekly/fortnightly repeats; invalid inputs; legacy totals; cached Excel zero and absent cached values; missing weeks and reconciliation errors.
- Local authenticated API fixture: save/reload, derived totals, tenant separation, stale write rejection, input rejection, legacy overwrite prevention, Today buffer exception; anonymous read denied.
- Real supplied workbook read and import-preview endpoint checked locally for the 13-week window ending 27 September through 20 December 2026. No customer values committed or saved to production.
- Browser fixture: sign in, choose scenario, add supplier payment, save and reload; mobile layout inspected.
- Release checks and live commit recorded in the final implementation summary.

## Intentional limits / next phase

This is a manual cash planner, not a bank ledger. No payment execution, actual settlement matching, automatic invoice import, scheduled forecast roll-forward, permanent forecast history, job funding allocation, or natural-language cash mutations. Account inclusion is a builder-entered label, not linked bank accounts. File import currently supports the supplied layout, not arbitrary spreadsheets. All recurring instances share one amount; separate an exception into a separate entry after adjusting the series. Daily ordering within one day is not modelled. Reloading the page discards unsaved draft edits; switching Business tabs retains them. Xero still requires credentials and explicit organisation connection. Next priority: reconcile invoice/payment actuals to allowances and retain approved forecast snapshots, then derive job cash requirements without duplicate counting.
