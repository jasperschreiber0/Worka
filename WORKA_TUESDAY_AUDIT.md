# Tuesday profitability MVP — audit and implementation plan

13 September 2026. Updated against the replacement brief through section 25. The core Tuesday journey takes priority; cash flow is supporting functionality.

## Current architecture

Next.js 14 App Router, React 18, Tailwind and CSS variables; existing AppShell, Today, Business, Jobs and quote review surfaces. Auth uses verified Supabase user sessions; server routes use service credentials with explicit builder/job ownership checks. Builders map one-to-one to auth users. Production is Railway; GitHub scheduled recovery plus request-scoped estimate continuation already exist. Preserve these paths and existing working-tree evidence.

Supabase schema verified read-only against Worka project nfyuhsqvmmcdgbedhsxd. jobs → quotes → quote_line_items is the estimate source. Intake runs document-worker / smooth-responder, persisted project facts/scope/questions, deterministic pricing and QA, bounded attempts and explicit builder review. Do not rerun or modify customer estimates during this work.

Existing financial primitives: job_cost_entries (incurred/committed/remaining), job_labour_hours, variations, invoices, communication_history, proof_events, project_memory and cost_reconciliation. Xero OAuth scaffolding exists but remains feature-gated. CSV/XLSX must remain independent of Xero.

Pricing caveat: line-item margin_pct is historically a markup fraction. Reuse calculateClientPrice; never interpret that field as gross margin. Existing variation labels inconsistently mention GST; new intelligence uses an explicit ex-GST basis and never converts legacy values silently. Exclude variation representation rows from baseline estimate cost to avoid counting client charges as costs.

## Reuse and changes

Reuse AppShell/navigation, canonical trade taxonomy, jobs/quotes, cost ledger, proof_events as the chronological intelligence ledger, existing variation approval and estimate editing. Preserve the 13 locked estimate trades; detailed cost categories map to these trades or remain explicitly unclassified.

Add business financial profile and cash-flow inputs; job review baseline/settings with captured estimate and original contract; correspondence source metadata and draft candidates; import provenance/corrections on actual costs. New tables use ownership RLS and scoped server writes. Capture immutable financial review snapshots for comparable-job learning; recommendations require explicit approval and quote status checks. No OAuth work, no client messages, no hidden quote mutations.

## Implementation order

1. Deterministic financial/profile/gate/review/risk/cash/segmented-learning functions and financial regression tests.
2. Additive migration, local PostgreSQL-compatible validation including cross-builder access checks.
3. Authenticated APIs composing existing data, atomic imports and audited review actions.
4. Business control centre and job profitability workspace: margin gate, correspondence, costs, post-mortem, learning, cash flow.
5. CSV/XLSX mapping preview, explicit tax/amount/labour basis, rejected-row feedback, duplicate protection.
6. Existing regression suite, type-check, production build and browser checks; document exact deployment readiness and remaining limitations.

## Financial conventions

All profitability amounts AUD excluding GST. Overhead allocation = sell price × annual overhead / planning revenue; this is a stated revenue-share planning assumption. Break-even revenue requires a contribution margin assumption: use the selected target gross margin and label it. Minimum margin recovers overhead at planning revenue; target adds desired net profit. Unknown costs are never zero for completeness/learning. Cash-flow amounts are bank movements (GST-inclusive where applicable), entered separately from profit figures. Actual imports must declare whether their amount already includes labour; no double counting.
