-- 073_allowance_pct.sql
-- Groundwork for allowance quality signals (not builder learning yet — that
-- is a separate, later phase). Answers a question price_coverage_pct and
-- pricing_match_rate_pct both leave open: not "does the quote have prices"
-- or "are those prices reliable rate matches," but "how much of the DOLLAR
-- VALUE of this quote rests on an AI judgment call rather than any kind of
-- rate or document evidence." A quote can have 100% coverage and a 90%
-- match rate on ITEM COUNT while still being dominated, in dollars, by a
-- handful of large allowances (a pool, a lift, a structural engineer fee) —
-- confirmed on the real project this session worked from, where Preliminaries
-- (the single largest trade by $) is almost entirely large ai_allowance
-- figures. Dollar-weighted, not item-count-weighted, on purpose.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS allowance_pct numeric(5,2);

COMMENT ON COLUMN quotes.allowance_pct IS
  'Percentage of total_cost contributed by line items with pricing_source = ai_allowance — dollar-weighted, computed by computeQuoteTotals alongside price_coverage_pct/pricing_match_rate_pct. Distinct from both: a quote can be fully covered, mostly rate-matched by item count, and still allowance-dominated by value.';
