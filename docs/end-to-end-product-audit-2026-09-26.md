# WorkA product audit — 26 September 2026

## Verdict

WorkA has useful estimating and job-control capabilities, but the live product is not yet a low-friction, self-service experience for a non-technical builder. Its consistent dark/orange styling is a good foundation. Information hierarchy, contradictory financial labels, repeated content and the amount of review work are the main problems.

Ready for a supervised usability test: yes. Proven ready for an unassisted production journey: no.

## Scope and evidence

Read-only walkthrough of https://worka-production.up.railway.app/: landing page, Today, new-job dialog (cancelled), existing test job Overview/Money/Site/Files, draft estimate review, job profitability and Business. Inspected screenshots at the default panel width, 390×844 and 1440×1000. Restored viewport and left the user tab on Today. No customer records changed, messages sent, files uploaded or paid AI estimates run.

The inspected job was explicitly labelled “TEST ONLY — Kaspr Worka readiness 08 Sep 2026”, with an existing draft estimate and seven uploaded documents. Its results illustrate product behavior, not the accuracy or profitability of a real completed project.

Railway reports the latest successful release as 21 September 2026, deployment 0d12e9fc-35bd-48f1-acd9-aa58a3ab1972, commit efe8070b0ada2f21348c4ba06626e3eb5591702c. The newer connected-workflow and simplified forms in this checkout are not deployed. Previous local tests do not establish production acceptance.

## Prioritised findings

### P1 — Financial headlines can imply profit that is not established

The draft/quoting test job shows a contract value of approximately $1,474,984 and only $100 recorded actual cost. Money displays “Contract less logged costs” of $1,474,884, rounded to 100%. Profitability goes further: “Gross profit to date” $1,474,884 and “Margin to date” 100.0%. The same profitability page says forecast unavailable and contract value missing. A provisional warning exists but does not resolve the conflicting headline meanings.

Source corroboration: app/api/jobs/[jobId]/snapshot/route.ts derives contractValue from current quote line items without checking acceptance, then subtracts logged costs. components/profitability/JobIntelligence.tsx labels incomplete results “Gross profit to date”.

Required outcome: separate draft quoted price, agreed contract revenue, recorded costs and confirmed forecast profit. Missing/unfinished inputs must not produce an apparently earned 100% margin. All job surfaces must agree about what is established.

### P1 — Complete processing is presented as complete project documentation

The quote displays a green “Estimate generated from complete project documentation” banner and 7/7 documents analysed, alongside 157 review items and 30% confidence. A saved scope question refers to structural drawings issued for comment/not for construction. All uploaded documents being processed does not establish completeness or construction readiness.

Source: components/quote/QuoteView.tsx COVERAGE_BANNER_STYLE.ready.

Required outcome: say “All 7 uploaded files processed”; present document status, missing scope and price readiness separately. Do not imply validated estimate accuracy from a processing count.

### P1 — The review journey is an overwhelming queue

The test quote has 157 unresolved items. Needs-input rows, expanded trade items and long questions make a large repeated workload. “Review/edit” reveals a further Edit step rather than taking the builder directly to the input. Quote review contains nested scrolling. Overview has about 20 long question/answer forms; the questions also appear under Money. Multiple confidence figures add interpretation work.

Required outcome: group by trade and decision type, prioritise items that materially affect price, show one short batch of questions, allow explicit waiting-for-supplier states, and preserve progress. Never reduce friction by silently accepting assumptions or inventing prices.

### P1 — The suggested next step contradicts the quote gate

Overview says “157 assumptions unresolved — quote cannot advance to pending review”, while its next action says “Send quote”. Quote review correctly disables sending.

Source: components/job/JobSnapshotPanel.tsx nextAction returns Send quote when a quoting job has a quote, without checking readiness.

Required outcome: derive one stage-aware next action from the same readiness rules as sending. Here it should lead to outstanding price/scope review.

### P2 — Today puts financial setup before the builder’s immediate task

The first major card asks for overheads, a confirmed job forecast and a 13-week cash plan. These prompts recur in Needs attention. Both existing jobs are quoting, yet the dashboard asks for contract value, reconciliation and cost-to-finish inputs. New job is available, but setup dominates the page.

Required outcome: lead with resume estimate, upload plans and the most urgent job actions. Keep business setup discoverable and staged. Do not make a blank financial dashboard feel like a failed onboarding journey.

### P2 — Repetition and density weaken visual quality

Two identical Labour check cards were visibly present on Money, Site and Files in the inspected session. The financial-intelligence link precedes everyday work across job sections. Files is visually wrapped in a Job Snapshot interface, including a close control. Long explanations, many outlined cards, small muted text and repeated warnings compete for attention.

At phone width, the profitability headline card consumes most of the first screen before the eight review-view controls; Business similarly starts with unavailable metrics and setup. Responsive stacking works in the inspected views, but navigation and task priority remain burdensome. No formal contrast-compliance claim is made.

Required outcome: remove duplicate panels, show financial details only in context, strengthen the main action, shorten visible explanations and use a consistent job header. Preserve help text behind purposeful disclosure. The product needs editing more than a new colour scheme.

### P2 — Live new-job form asks for unnecessary or ineffective input

The live form requires client name and address and offers project name and start date. Source inspection shows the live start-date state is not sent when creating the job. Visible labels were not associated with the first two textboxes in the accessibility representation.

Local improvements already reduce this to an address-first entry and remove the ineffective date field, but remain undeployed. Verify accessible field names and the full create-to-upload handoff in the release candidate.

## What works and can add value

- Job-based storage, construction-specific scope questions and a trade-based estimate provide a useful foundation for consolidating scattered project information.
- The quote prevents sending while required review is outstanding and distinguishes an incomplete priced portion. Retain this safeguard while simplifying review.
- Source references and assumptions help a builder challenge an AI draft. Their presence is not proof that quantities or prices are correct.
- Site tasks, milestones and explicitly logged labour can support daily work. Their usefulness improves when placed before financial explanations.
- Business explains that cash is a manual scenario rather than a bank feed, and that learning requires builder-confirmed completed reviews. These are appropriate boundaries.

The likely value is less missed scope, quicker price collection, clearer changes and better estimate-versus-actual learning. This walkthrough does not establish time saved, financial ROI or estimation accuracy. Measure those with a builder using a known job.

## Recommended primary journey

1. New job: address, then upload plans.
2. Document review: show what processed, failed or needs a newer revision; retry only the failed file.
3. Scope review: a short ordered set of builder decisions with saved progress.
4. Pricing: complete trade prices or attach supplier quotes; show missing prices explicitly.
5. Review: one clear readiness summary, transparent AUD/GST basis, assumptions and client price.
6. Issue proposal only when the applicable reviews are complete; retain evidence of approval.
7. Run the job: today’s tasks, bills, changes, deliveries and site updates.
8. Close out: reconcile actuals, confirm mappings and approve what can become learning.

Profitability and cash planning should support this journey at the appropriate stage rather than lead every screen.

## End-to-end acceptance still required

This was a cross-screen product audit, not a completed transactional end-to-end test. Before calling the release ready, test a disposable, clearly labelled job through:

- Sign-in for each authorised testing account; address-only creation and return/resume.
- Multi-file upload, the previously failing stamped PDF, visible partial failure and retry without losing successfully processed documents.
- Saved answers, all required prices, refresh/re-entry and a new draft without overwriting historical estimates.
- AUD, explicit GST treatment, supplier quote application and consistent totals across review/export/job views.
- Readiness gate, proposal preview/export and approval lifecycle using test recipients or a stubbed send boundary.
- Bill/credit import, unsupported/formula input warnings, unclassified costs retained in totals and no fabricated hours or cost splits.
- Variations, commitments and actual costs without double counting; incomplete forecasts clearly unknown.
- Confirmed closeout and learning that proposes, but never silently applies, an adjustment.
- A first-time builder completing the core journey on a phone without coaching. Record where they hesitate, abandon, re-enter data or need explanation.

The new connected-workflow migration and release must be validated together before testing those newer features in production. A successful build or local mocked walkthrough alone is insufficient.
