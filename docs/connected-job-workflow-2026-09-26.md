# Connected residential job workflow — 26 September 2026

## Release status

Implementation is in the working checkout. This document does **not** certify a production deployment or a paid end-to-end estimate run. No customer communications, bank transactions or paid AI acceptance runs were performed.

## Audit and implementation order

1. Reuse existing job creation, estimating, clarification facts, commercial quote approval, variations, cost imports and profitability reviews.
2. Repair drawing reconciliation and estimate refresh isolation before connecting operational records.
3. Add reviewed job records that write into the existing financial ledgers, with explicit approvals and retry protection.
4. Connect trade pricing, scope packs, programme, client decisions, site evidence and daily actions.
5. Test arithmetic and SQL state transitions; inspect local screens separately from live external integrations.

| Capability before this change | Audit finding | Result of this implementation |
|---|---|---|
| Job creation, quote review and commercial approval | Existing | Reused, with approved-current quote protection in the manual estimate entry point |
| Re-upload and refresh | Existing incremental pipeline reused a draft; matching descriptions were ignored on conflict, so revised quantities were not reliably replaced | Explicit selected source set and a separate draft per refresh; old approved quote stays current |
| Upload retries | Successful early files could be lost from component state when a later upload failed | Preserve each successful upload and reuse an upload reservation on retry |
| Duplicate detection | Existing content hashes in the worker, but no builder drawing-reconciliation flow | Verify stored bytes, atomically identify duplicates, select addition/replacement/evidence, retain originals |
| Confirmed answers | Existing `project_facts` were durable but no revision review screen | Retained answers, supersession history, explicit review after replacement, exposed to job conversation |
| Trade quotes and issued scopes | Disconnected | Accepted quotes can replace explicitly selected draft items; linked scope packs expose qualifications and issued sources |
| Programme and site | Basic existing panels | Separate draft/confirmed programme with dependencies, revisions, daily/weekly/two-week views; photo evidence and reviewable site issues |
| Variations | Existing approval path could approve while opening notification UI, without client evidence | Opening notification UI now leads to review; builder approval for issue, recorded issue, dated client evidence, existing idempotent contract application |
| Actual costs | Import parser and database constraint rejected credits | Signed actuals and evidenced material transfers; commitments and remaining costs stay non-negative |
| Purchase orders and bills | Missing connected workflow | Approval creates commitment; invoice explicitly replaces outstanding commitment in the same transaction |
| Subcontractor claims | Missing register linkage | Supplier bills can reference an accepted trade quote, supplied hours and completion percentage; claims-to-date displayed against that quote |
| Financial review / learning | Existing, builder-confirmed | Reused; no silent business defaults or historical reinterpretation |
| Morning actions | Existing financial overview lacked new operational records | Job actions, blockers, unsigned variations, recorded client invoices, bills and quote follow-ups link to their records |
| Gmail, calendar, Xero | Integration routes/configuration are not proof of a working connection | No new account connection or fabricated credentials; manual evidence capture remains available |
| Weekly sales update | Not connected to this flow | On-demand seven-day report from recorded job/quote dates; no automatic sending |

## Builder journey

Open a job. **Plans and estimate versions** handles uploads, drawing relationships, confirmed answers, refresh and draft clearing. Upload completion is distinct from estimate completion. Exact duplicate uploads do not enter the selected drawing set. A replaced multi-sheet PDF replaces the whole document: review all its sheets first.

**Run this job** contains records for trade quotes, purchase orders, supplier bills/credits, material transfers, selections, programme, scope packs, site updates, questions and deadlines. Prepare a draft, review it, then use the specific confirmation action. Drafts do not commit money or approve variations. A failed save preserves form input.

An accepted trade quote can replace selected items of the same canonical trade in an editable estimate. Choose exactly which items it covers. WorkA keeps their former values in history and excludes replaced duplicate allowances. It cannot overwrite an approved baseline. Review exclusions and the quote’s commercial pricing before issue.

For tiles, enter measured area, both source prices and GST treatments, purchase-cost basis, installation treatment, wastage, evidenced extras and markup. Unknown extras prevent variation preparation. A client-facing allowance is not treated as a purchase cost: establish the purchase costs before calculation. A saved proposal and its client-message draft use the same calculated values. With 20 m², $80 to $300 ex GST, no wastage/extras and 20% markup: additional cost $4,400; proposed charge $5,280; GST $528; total $5,808. Forecast profit remains unknown unless its underlying cost and contract basis is established.

Preparing a variation creates a draft and a linked profitability exposure. **Review variation** separates builder approval for issue, evidence of issue and evidence of the client’s decision. Preparing a client link does not send it. Client approval applies through the existing contract mechanism, which guards repeated application. A failed contract application is surfaced and can be retried.

PO approval records a commitment. A bill records the exact signed source value and GST basis, then replaces the explicitly reviewed amount of outstanding commitment. Supplier/amount mismatches require review. Credits reduce actual costs; they do not automatically release a commitment. Bank payments remain separate. A material transfer creates a credit in the source job and an equal cost in another job owned by the same builder, atomically.

Programme dates are proposals, not trade bookings. Linked decisions and unfinished dependencies remain blockers. A revised confirmed programme record is superseded only when its replacement is approved. No automatic cascading rescheduling occurs. Use site photo upload to retain originals and prepare a site update; interpretation, issue ownership and next action require review.

## Verification record

- TypeScript check and production build passed. Build warnings: remote Inter font optimisation was skipped when Google Fonts was unavailable, and webpack could not persist its dependency cache. The estimating edge function passed a TypeScript syntax transpilation check; this is not Deno runtime verification.
- Main automated suite: 790 tests passed, zero failures, including signed-rounding coverage.
- Isolated PostgreSQL-compatible migration/state tests: 17 connected-workflow checks. They exercise real SQL transactions, credits, duplicate invoices/imports, stale proposals, cross-tenant denials, drawing reconciliation, preserved facts, refresh idempotency, approved baseline protection, material transfers, accepted-quote replacement, programme revision and evidenced approval states.
- Existing isolated profitability, financial correction and profit-control suites: 15, 9 and 10 checks passed. Together with the new 17 checks, 51 isolated database checks passed.
- Local HTTP/UI fixture: six API checks exercised draft forms, printable pack, unauthenticated rejection and foreign-job rejection. The fixture deliberately disables financial approvals; it is **not** proof of real database approval behaviour.
- Browser: entered and saved the tile example, reopened it, inspected the $4,400/$5,280/$528 figures, matching $5,808 client-message total and unresolved forecast labels; inspected the printable demonstration plasterer pack; followed a Today action to its saved selection record.
- `npm run lint` prompts to configure ESLint: the repository has no configured lint run. No framework/dependency upgrade was attempted to mask that limitation.

### Acceptance coverage A–S

| Steps | Evidence | Remaining verification |
|---|---|---|
| A, B, C, R: upload, duplicate, revision, processing retry | Source-set and hash SQL checks; existing extraction/retry unit suite; inspected engine changes | Live Storage + extraction + paid estimate execution not run |
| D, E: durable answer and revision conflict review | Real SQL persistence and replacement-review tests | Live browser-to-hosted-database run |
| F: trade scope | Printable demonstration inspected; missing-spec and foreign-file guards tested | Real issued specifications and accepted supplier quote must be supplied |
| G: programme/look-ahead | Dependency and revision SQL tests; local programme draft | Friday toolbox/use-on-phone acceptance with builder |
| H–L: selection, arithmetic, draft and baseline protection | Arithmetic tests, browser scenario, real SQL draft variation / preserved baseline | Paid natural-language extraction not exercised |
| M: approval exactly once | Dated approval-state SQL checks; existing contract-application tests | Real client portal and commercial baseline journey |
| N, O: credit imports and commitments | Signed import, duplicate, partial settlement, material-transfer SQL tests | Representative builder source files |
| P: photos and proposed issue | Implemented upload/evidence path | Actual mobile upload and stored-original retrieval not exercised in the local fixture |
| Q: daily actions | Browser followed the Today selection link to the correct saved record; coverage warnings displayed | Hosted dashboard data coverage |
| S: roles and tenants | SQL privilege/RLS and local API denials | Delegated administrator/team access is not added by this owner-scoped MVP |

## Demonstration plasterer package

Use a job explicitly named **DEMONSTRATION — alterations and additions**. Prepare a request-for-quote pack for new extension wall/ceiling linings and nominated alteration patches. Include supply/access/protection responsibilities, daily offcut removal, final clean-up, builder release before closing services, junction-detail review, finish inspection before decoration and a return visit if agreed. Keep hazardous materials, painting and hidden existing damage explicitly excluded or unresolved.

No real architect finish specification or trade agreement was supplied. The demonstration must remain a **draft** with the missing finish specification and junction detail as open questions. Never invent a finish level or finalise it as an appointed pack. Add the actual issued drawings/specifications, resolve questions, link the confirmed accepted quote, then approve the pack. Record trade acknowledgement and builder completion evidence at sign-off.

## Short builder acceptance script

1. Create the labelled demonstration job and upload issued plans/specifications. Verify each original opens. Re-upload renamed identical bytes: verify a duplicate, not extra quantities.
2. Add a confirmed supply-only tile answer. Upload a true revision, choose its predecessor, review the flagged answer, and refresh. Compare the source list and trade changes. Check the previous approved quote is unchanged.
3. Record and confirm a plasterer quote. Apply it to selected draft items, review exclusions, then use the normal commercial quote approval flow.
4. Prepare the plasterer pack and programme. Leave missing specifications unresolved to verify finalisation is blocked. Supply actual evidence, then confirm. Record a dated client decision linked to an activity and check the blocker appears.
5. Run the tile example above. Save/reopen it, compare the message and variation, approve for issue, and record real test-client approval evidence. Retry contract application: no second revenue increase.
6. Approve a $1,100 inc-GST PO. Record a $440 inc-GST bill replacing $400 ex-GST commitment. Verify $600 commitment + $400 actual = $1,000 ex GST. Add a $110 inc-GST credit: actual becomes $300. Retry the bill: no duplicate.
7. Upload two test site photos, add “this needs fixing”, choose an owner and next action, review and confirm. Verify originals and dashboard links.
8. Reconcile actuals/remaining costs, supply explicit labour hours and rates where applicable, and complete the existing builder-confirmed profitability review. Missing GST or cost coverage must prevent confident forecasts/learning.

## Material limits and release order

This is a manual-evidence operational MVP, not a bank ledger, automatic mailbox coder or guaranteed scheduling engine. No Gmail/calendar connection, automatic booking/confirmation emails, payment execution or scheduled weekly email was added. Scanned correspondence remains subject to the existing readable-text/manual-input restriction. Photo metadata is not compliance evidence. Source PDFs are reconciled at document level, not sheet-level revision matching. Replacement currently flags all active builder answers for conservative review rather than claiming an AI-proven contradiction. Client allowances need actual purchase-cost evidence for cost-impact calculations.

Apply the connected-job migration first, then deploy the matching estimating function and application together. Do not deploy the UI against an unmigrated database. Run hosted schema/privilege checks and an authorised live demonstration before calling the Tuesday end-to-end test ready. Paid AI execution and real communications were explicitly excluded from this implementation session.

Existing Supabase advisory findings were inspected read-only: server-only tables with RLS/no browser policy, extensions in `public`, and leaked-password protection disabled. No new advisory scan can certify this migration until it is applied. Relevant guidance: [database lint findings](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public), [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

Final review also removed the old optimistic chat rejection confirmation. Both approval and rejection open the dated evidence review; drafts can be withdrawn with a recorded reason.
