# Builder usability and end-to-end audit — 21 September 2026

## Verdict

Suitable for a guided Tuesday acceptance test. Not yet verified as a fully independent, end-to-end production experience for a new builder. The dark theme, orange actions, spacing and primary Today / Jobs / Business navigation are consistent. Financial review is information-heavy and requires a guided first use; it is not a short wizard.

Production was verified on commit 17a8f3c before this audit. Browser inspection used the same source against isolated synthetic services. Production was accessible but not signed in. No customer records or outbound messages were changed.

## Fixes from this audit

- Unconfirmed forecast profit now has neutral text rather than green success styling.
- Job and Business sections record the selected view in the URL and restore it on refresh.
- Phone layouts show all section buttons in a two-column grid, with 44px minimum targets, instead of hiding later sections in a horizontal strip.
- Incomplete closeout review has a direct link to original-estimate/GST setup. Builders with a baseline no longer see an instruction to capture it again.
- Section buttons expose their selected state using valid pressed-button semantics.

## Evidence

- 784 unit tests passed; TypeScript passed.
- 34 isolated PostgreSQL-compatible checks passed: 15 profitability, 10 control-plan, 9 correction/completion checks.
- 41 local API scenarios passed: 8 profit control, 5 Today, 8 cash planning, 6 financial audit, 14 profitability. These use real Next.js routes with synthetic HTTP storage; database atomicity and tenant restrictions are checked separately above.
- Browser login, Today next-step navigation, job financial gate, actual-cost and completion review sections inspected.
- Browser cash entry: added a synthetic $100 payment, observed the forecast decrease by $100 and confirmation reset, saved, reloaded, and verified persistence.
- Cash and job Actual costs sections preserved on refresh after the navigation fix.
- Desktop and 390px phone screenshots inspected; phone job section controls are all visible without horizontal navigation. Cash forms stack vertically. The job page had no document-width overflow at 390px.

## Remaining test boundaries

- A new real-plan upload, quantity/scope accuracy, missing-rate entry and bulk rate reuse were not revalidated end-to-end against production in this audit. The prior McCann recovery is historical evidence, not a fresh benchmark.
- AI correspondence and post-mortem success require the live provider. This audit verifies honest unavailable-provider handling; earlier live tests do not substitute for Tuesday's run.
- Actual email delivery requires a configured provider and a specified test recipient. The local test verifies missing-provider failure leaves the quote unsent. No email was sent.
- Xero reconciliation and worker task/photo/issue writes are not part of the proven MVP path.
- Prior security/dependency and historical-import approval findings remain open; this UI audit does not certify them resolved.
- The financial pages remain dense. A short first-session guide is appropriate; do not claim frictionless onboarding based on passing software tests.

## Tuesday acceptance script

Use a clearly named test job and keep the builder's trusted estimate/workbook alongside WorkA. Record expected and actual amounts at each checkpoint.

1. Sign in with an estimating-enabled builder; save overheads and profit targets. Check Today explains incomplete inputs.
2. Upload the intended plan set. Check every file completes or identifies its failure explicitly. Independently review scope, quantities, duplicate work and units.
3. Price the missing items. Verify quantity × unit rate and allowance totals, margin and GST. Review selected reusable unit rates and confirm once; allowances must be absent. Reopen to confirm persistence.
4. Confirm source GST, original contract, project context and original baseline. Check Financial gate uses the expected margin/markup and flags below-overhead pricing.
5. Paste a known client change. Check source evidence, unknown cost and lack of approval. Price it and create a draft variation. Do not treat a draft as approved revenue.
6. Import a small cost file with known totals. Confirm source GST and mappings. Check Unclassified totals, explicit credit/formula handling, duplicate rejection and corrected-cost history.
7. Enter outstanding commitments and remaining work. Confirm the forecast only after reconciliation. Change a cost and verify the confirmation becomes stale.
8. Enter dated expected receipts/payments, save the cash plan and reload. Check a late-payment scenario and the lowest projected cash against the workbook.
9. Reconcile final costs, labour and approved revenue. Confirm completion, inspect trade variance and generate the evidence-backed post-mortem.
10. Open a comparable next estimate. Check approved learning's sample count, review/apply once, and verify no duplicate adjustment. Verify the confirmed unit rates on matching scope and units.

Pass means the builder can explain each figure, navigate without coaching after the first example, and complete all required saves without assistance. Log any confusion or missing step; do not turn a successful extraction into a claim of construction-estimate accuracy.
