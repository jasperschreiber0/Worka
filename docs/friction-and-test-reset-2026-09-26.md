# Usability pass and test reset — 26 September 2026

## Account reset (production)

The two explicitly requested accounts were resolved by email and fixed account ID. A transactional dry run verified dependent-record deletion before applying the reset. Both Auth users and builder profiles were preserved.

Removed five jobs, 15 files and their stored originals, related estimates/answers/processing records, four clients, two workers, 66 supplier rates and one business financial profile. Other job-linked records were removed through verified foreign-key cascades. Storage deletion used the Storage API with the 15 exact paths; no storage metadata was deleted with SQL.

Verification returned zero jobs, quotes, files, clients, workers, supplier rates, project memory and stored files for each account. Sign-in records remain present. Existing subscription/identity settings and AI spend limits were not reset. Shared trade categories and benchmark prices were untouched.

The user subsequently explicitly approved estimating access for both named email addresses. Both accounts are now verified enabled. Existing/default limits were preserved at 40 attempts and 1,000 cost cents; no paid estimation was triggered.

## Usability findings and implemented changes (local only)

- New job required a client name even though the API already supports an address-only estimate. It now requires only the address, with client/project information under an optional disclosure.
- The optional start-date input was never included in the create request. Removed the misleading, unsaved field.
- Job overview displayed profitability, operational records and estimate-version links simultaneously on every tab. The overview now has a stage-appropriate starting action; financial review is placed under Money and drawing management under Files.
- Operational forms required choosing an internal record type and presented all fields at once. Added four named actions and a More job actions disclosure; optional title/trade/supporting fields are collapsed. The saved title can be derived from the builder's entered supplier or room. No financial value or GST basis is inferred.
- An unmatched bill now starts with supplier, invoice reference, signed amount, explicit GST basis and evidence. Order settlement controls appear when a matching purchase order is selected. Subcontractor claims, hours and other supporting information remain available under More details.
- Record filters are under Find saved job records instead of preceding every action.
- An empty job no longer claims Nothing missing before an estimate exists.

The underlying review and financial confirmation steps remain separate. This is a focused reduction in friction, not proof that a non-technical builder can complete every workflow unaided. Scope packs and tile decisions still require evidence that cannot safely be guessed.

## Verification

Browser checks use the isolated local fixture, not customer data or live estimating. Address-only creation reached the upload panel; the old fixture initially produced a false duplicate because it ignored address filtering, and its filter support was corrected. The simpler action menu and five-field unmatched bill form were inspected. After correcting the fixture to accept newly created owned jobs, a signed, GST-inclusive credit saved without a separate title. The browser showed the derived supplier title, -$110 source value, -$100 excluding GST and draft status with a separate confirmation action. The clean address-only retest reached upload without a duplicate warning.

Final production build passed, including its TypeScript validation. Remote Google Fonts optimisation and webpack cache warnings were non-blocking. The saved credit stayed a draft with a separate confirmation action. No live estimate or message was sent during these checks. These interface changes are local and are not deployed.
