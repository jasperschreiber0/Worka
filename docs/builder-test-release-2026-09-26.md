# Builder test release — 26 September 2026

## Included

This release combines the connected-job implementation and simplified forms documented in `connected-job-workflow-2026-09-26.md` and `friction-and-test-reset-2026-09-26.md` with the product-audit fixes:

- Today leads with new jobs, existing jobs and ongoing estimates. Business setup and forecast cards are collapsed. Quoting jobs no longer get cost-to-finish setup warnings in Today.
- Address-only job creation continues directly to plans. Optional client/project details have associated accessible labels.
- Job actions are contextual. Labour and correction panels are confined to Money and collapsed. Questions are not repeated in Money.
- The estimate review queue filters by trade and reveals five items at a time, with no nested queue scrolling. Review/edit opens the editor directly. Full trade breakdowns start collapsed. All existing send/review guards remain.
- Overview's next action opens estimate review instead of instructing a blocked draft to be sent.
- Confidence details are disclosed on demand and explicitly described as evidence scores, not price-accuracy guarantees. File processing is no longer described as complete project documentation.
- Draft quote amounts are labelled draft priced portions rather than agreed contracts. Unconfirmed profitability reviews show no headline profit or margin, and no completed-profit waterfall. Trade differences are labelled partial records until confirmed.
- Earlier updates include drawing/source revisions, protected approved estimates, durable answers, trade quotes, job operations, explicit variation decisions, signed credits, purchase-order settlement and reviewed material transfers.

## Verification

- 790 automated tests passed; 51 isolated SQL/state checks passed (17 connected workflow, 9 financial corrections, 10 profit control, 15 profitability).
- Production build and TypeScript checks passed during release preparation. Non-blocking local warnings concern remote font optimisation and build cache persistence.
- Local browser walkthrough verified job-first Today, Money's collapsed tools and draft-price label, and the revised quote controls. Local fixture data is not evidence of estimate accuracy.
- The connected-job migration was applied to hosted project `nfyuhsqvmmcdgbedhsxd`; RLS and denied direct browser mutations were verified for its three new tables. Sensitive workflow functions were verified as invoker functions without anon/authenticated execution grants.
- The matching smooth-responder service was deployed with JWT verification retained.
- Both requested test accounts retain estimating access with their existing attempt/spend limits. No account data was reset again.

Hosted application deployment and browser verification are recorded in the release conversation. A fresh paid AI estimate and external client communications are not part of the smoke test.

## Builder's first test

1. Refresh WorkA and sign in with either enabled account.
2. Choose New job, enter the address, then upload the plans.
3. Check each file's outcome; retry only a failed file if needed.
4. Open the estimate, choose a trade and work through missing prices/assumptions in small groups. Refresh and confirm saved inputs remain.
5. Review the priced portion, GST and outstanding checks before preparing the client quote.
6. Open job operations and try a clearly labelled test bill/credit, supplier quote or site update. Review each draft before confirmation.

Do not treat a successful upload or evidence score as certification of quantities, scope or prices. The builder's real-plan run is the remaining acceptance test.

## Existing boundaries

No automatic mailbox connection, bank payments, appointment booking or scheduled sales emails are introduced. Cash remains a scenario using entered movements; historical learning remains approval-based. All prior AUD/GST, signed-source-value, unknown breakdown and explicit-hours rules remain applicable.

The hosted security advisor reports existing extension placement and leaked-password-protection warnings, with no new workflow-table findings. Follow-up references: [extension placement](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public) and [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). These predate this release; no broad legacy upgrade was attempted.
