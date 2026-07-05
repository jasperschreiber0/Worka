-- ─── 020 Estimate sections (Stage 3) ─────────────────────────────────────────
-- The reasoned estimate groups line items by a builder-facing cost SECTION
-- (Prelims, Demolition, Pool, Landscaping, …) that is finer than the 13 locked
-- trade categories. The 13 trades stay the rate-resolution bucket
-- (trade_category_id); these columns carry the presentation grouping, the
-- build a line belongs to, and the estimating basis. All nullable — existing
-- intake line items are unaffected.

alter table public.quote_line_items
  add column if not exists estimate_section text,
  -- section key: preliminaries | demolition | earthworks | concrete | structural |
  -- roofing | cladding | windows_doors | insulation | linings | waterproof_tile |
  -- flooring | joinery_stone | painting | electrical_solar | plumbing_hydr | hvac |
  -- pool | fixtures | external_works | specialist | completion
  add column if not exists location_scope text,
  -- primary | secondary_dwelling | pool | external | general
  add column if not exists basis text;
  -- measured | allowance | pc_sum | provisional

create index if not exists quote_line_items_section_idx on public.quote_line_items(estimate_section);
