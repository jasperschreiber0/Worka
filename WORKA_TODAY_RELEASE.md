# Today: profit picture and next actions

Implements the supplied Today visual direction using real, tenant-scoped WorkA records.

- Forecast gross profit covers confirmed open-job forecasts for their full duration, before business overhead and tax. Coverage includes quoting jobs and is explicitly labelled. No financial-year earned-profit or overhead-recovery date is inferred.
- A three-step readiness panel reflects saved business assumptions, confirmed job forecasts and a dated cash plan. Manual cost entry/import remains available; Xero is not required or represented as connected.
- Pricing education uses the existing deterministic financial profile. Required markup is margin / (100 - margin) × 100, rather than a rounded-down target or an unweighted quote average.
- One exception list combines profit, cash, compliance/capacity, overdue issued invoices and pending variations. Overlapping leakage/below-margin alerts combine. Sorting is urgency, oldest due date, then known impact; pending variation charges are not labelled as losses.
- Invoice reads are paginated, scoped to the authenticated builder and matched to owned jobs. Read failures produce an error rather than zero totals. No schema or RLS changes.
- Job Money, profitability Review/Scope and business profile/cash-plan actions open their intended views.
- Ask WorkA carries an unsent draft through browser session storage. Its entry path suppresses the existing automatic morning brief, which otherwise cleared the draft. No question or client message is sent by navigation.
- Existing shell/navigation and themes remain shared. The supplied hardcoded business identity, sample values, photos, projected chart and fake navigation are not shipped.

Validation: 767 unit tests, type-check and production build passed; eight existing profit-control API checks and five new Today API checks passed against an isolated local fixture. Browser verification covered initial incomplete setup, confirmed totals, invoice aggregation, desktop and 390px layouts, the financial-profile deep link and intact unsent chat draft. Temporary viewport was reset. Local fixture data never enters production.

Existing due-today invoices, latest sent quotes and unlinked scheduled claims also remain in the unified attention list. A scheduled claim is a prompt to check completion/entitlement, not a statement that payment is due.

Production verification is limited to deployment identity, public route/authentication behaviour, assets and runtime logs unless an existing authenticated browser session is available. This release does not create or modify a customer's account or job to obtain one.

Remaining: connected accounting, actual period-based overhead recovery, site photo feed and automatic business-context financial answers in chat. Existing chat capabilities are reused; Today does not promise accounting-grounded answers for unsupported questions.
