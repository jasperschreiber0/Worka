-- 086_builder_knowledge_defaults.sql
-- Builder Knowledge Defaults — the small, deterministic lookup capability
-- from the "Permanent Reasoning Architecture" design (and its subsequent
-- subtraction pass), now actually built. This is deliberately NOT an AI
-- engine: it is a curated, auditable table of statutory/compliance items
-- that exist independent of any project document — asbestos risk, termite
-- protection, HBC insurance, pool certification, and similar — matched by
-- jurisdiction + a small set of project characteristics, never inferred by
-- an LLM. The whole reason this exists as a table rather than a prompt
-- instruction: legal/compliance correctness must never drift from
-- probabilistic model output, and must be human-reviewable and versioned.
--
-- trigger_characteristic values are matched against the same
-- ProjectCharacteristic taxonomy lib/estimating/construction-sanity.ts
-- already detects (extension/second_storey/major_renovation/new_build/
-- demolition), plus two new ones evaluated at insertion time from the
-- quote's own line items: 'has_new_footings' (any Trade 1 item present)
-- and 'has_pool' (any line item/scope text mentioning a pool). 'always'
-- means the default applies to every job in that jurisdiction regardless
-- of characteristics (e.g. HBC insurance, waste management).
--
-- allowance_value is a representative PROVISIONAL allowance, not a
-- calibrated rate — these items don't have a quantity x rate structure
-- (insurance, certification, compliance fees are lump-sum by nature).
-- Explicitly out of scope for "do not tune rates yet": adding a new,
-- previously-absent line item closes a scope gap; it is not a rate
-- adjustment to anything that already existed.

CREATE TABLE IF NOT EXISTS builder_knowledge_defaults (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction            text        NOT NULL DEFAULT 'NSW',
  trigger_characteristic  text        NOT NULL, -- 'always' | a ProjectCharacteristic value | 'has_new_footings' | 'has_pool'
  trade_category_id       int         NOT NULL REFERENCES trade_categories(id),
  description             text        NOT NULL,
  citation                text        NOT NULL, -- the Act/Regulation/Standard this is sourced from — never omitted
  allowance_value         numeric(12,2) NOT NULL,
  pricing_basis           text        NOT NULL, -- shown to the builder verbatim as the assumption's justification
  active                  boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE builder_knowledge_defaults IS 'Deterministic, human-curated statutory/compliance defaults applied per jurisdiction + project characteristics — never LLM-generated. See lib/estimating/builder-knowledge.ts for the matching logic and its own header comment for why this is a table, not a prompt.';

-- Seed: NSW residential, the 8 high-confidence items identified in the
-- final scope completeness audit. Every citation is a real, checkable
-- source — this table must never grow by an unsourced row.
INSERT INTO builder_knowledge_defaults (jurisdiction, trigger_characteristic, trade_category_id, description, citation, allowance_value, pricing_basis) VALUES
  ('NSW', 'always', 13, 'Home Building Compensation (HBC) insurance', 'Home Building Act 1989 (NSW), Part 6 — mandatory for residential building work valued over $20,000', 8500.00, 'Provisional allowance — approximately 1% of a mid-range residential contract; confirm the actual premium with the insurer once contract value is finalised.'),
  ('NSW', 'has_new_footings', 1, 'Termite protection system', 'AS 3660.1-2014 — Termite management, new building work', 3500.00, 'Provisional allowance for a standard physical/chemical termite management system sized to this footprint — confirm system type with the builder.'),
  ('NSW', 'demolition', 1, 'Asbestos survey and removal allowance', 'SafeWork NSW / Work Health and Safety Regulation 2017 (NSW) — asbestos identification required before demolition of any structure that may contain it', 15000.00, 'Provisional allowance only — this project includes demolition of existing pre-existing structures whose age/construction date is not confirmed in the supplied documents. Get a licensed asbestos assessment before demolition proceeds; this figure is not a quote.'),
  ('NSW', 'always', 13, 'Waste management and disposal', 'Local council development consent condition — a Site Waste Management Plan is a standard requirement for development applications of this scale', 4500.00, 'Provisional allowance for skip bins, sorting, and disposal across the construction program.'),
  ('NSW', 'has_new_footings', 1, 'Sediment and erosion control', 'Protection of the Environment Operations Act 1997 (NSW) / standard council development consent condition for earthworks', 3000.00, 'Provisional allowance for sediment fencing and site erosion control for the duration of earthworks.'),
  ('NSW', 'demolition', 13, 'Temporary works — site fencing and protection of existing structure', 'Work Health and Safety Regulation 2017 (NSW) — general construction site safety requirements', 6000.00, 'Provisional allowance for temporary site fencing/hoarding and protecting the retained existing structure during demolition and construction.'),
  ('NSW', 'has_pool', 13, 'Pool safety certification', 'Swimming Pools Act 1992 (NSW) and Swimming Pools Regulation 2018 (NSW)', 1500.00, 'Statutory certification cost — the pool cannot be legally used/occupied without this.'),
  ('NSW', 'always', 13, 'BASIX certificate and NCC compliance sign-off', 'Building Sustainability Index (BASIX), NSW Government / National Construction Code 2022', 2500.00, 'Provisional allowance for the compliance certification already referenced in this project''s own DA documents.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
