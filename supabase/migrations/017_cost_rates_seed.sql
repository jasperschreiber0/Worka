-- ============================================================
-- WorkA — Cost Rates Seed Migration 017
-- Tier 4 platform default rates for the 5-tier rate hierarchy.
-- 70 national default line items across the 13 locked trade
-- categories, plus one state-adjusted row per line item for each
-- of the 8 states — 630 rows total.
-- Idempotent: national rows guarded by NOT EXISTS, state rows by
-- ON CONFLICT (line_item_key, state) DO NOTHING.
-- Rates are indicative AUD supply+install for residential work.
-- ============================================================

-- ─── National defaults (state IS NULL) ───────────────────────

INSERT INTO cost_rates (trade_category_id, line_item_key, description, unit, rate, state, is_default)
SELECT v.trade_category_id, v.line_item_key, v.description, v.unit, v.rate, NULL, true
FROM (
  VALUES
    -- 1. Site Works & Concrete
    (1,  'site_excavation',          'Excavation & earthworks',              'm3',    85.00),
    (1,  'site_footings',            'Concrete footings',                    'm3',   330.00),
    (1,  'site_slab',                'Concrete slab on ground',              'm2',   145.00),
    (1,  'site_paths',               'Concrete paths & driveways',           'm2',    95.00),
    (1,  'site_drainage',            'Stormwater drainage',                  'lm',    75.00),
    (1,  'site_retaining_wall',      'Retaining walls',                      'm2',   380.00),

    -- 2. Framing
    (2,  'framing_floor',            'Floor framing',                        'm2',    88.00),
    (2,  'framing_wall',             'Wall framing',                         'lm',    38.00),
    (2,  'framing_roof',             'Roof framing',                         'm2',    95.00),
    (2,  'framing_steel_beams',      'Structural steel beams',               'lm',   190.00),
    (2,  'framing_lvl_beams',        'LVL beams',                            'lm',    85.00),

    -- 3. Roofing
    (3,  'roofing_colorbond',        'Colorbond roof sheeting',              'm2',    85.00),
    (3,  'roofing_tiles',            'Roof tiles',                           'm2',    78.00),
    (3,  'roofing_flashings',        'Flashings & cappings',                 'lm',    32.00),
    (3,  'roofing_gutters',          'Gutters',                              'lm',    45.00),
    (3,  'roofing_downpipes',        'Downpipes',                            'each', 120.00),
    (3,  'roofing_fascia',           'Fascia',                               'lm',    38.00),

    -- 4. External Cladding
    (4,  'cladding_brick_veneer',    'Brick veneer',                         'm2',    95.00),
    (4,  'cladding_render',          'Cement render',                        'm2',    65.00),
    (4,  'cladding_weatherboard',    'Weatherboard cladding',                'm2',   110.00),
    (4,  'cladding_fibre_cement',    'Fibre cement sheet cladding',          'm2',    90.00),
    (4,  'cladding_timber',          'Timber cladding',                      'm2',   145.00),
    (4,  'cladding_stone',           'Stone cladding',                       'm2',   320.00),

    -- 5. Insulation
    (5,  'insulation_wall_batts',    'Wall batts R2.5',                      'm2',    12.00),
    (5,  'insulation_ceiling_batts', 'Ceiling batts R4.0',                   'm2',    18.00),
    (5,  'insulation_foil',          'Foil underlay',                        'm2',     8.00),
    (5,  'insulation_sarking',       'Sarking',                              'm2',     9.00),

    -- 6. Internal Linings
    (6,  'linings_plasterboard_walls',    'Plasterboard walls',              'm2',    28.00),
    (6,  'linings_plasterboard_ceilings', 'Plasterboard ceilings',           'm2',    34.00),
    (6,  'linings_feature_wall',     'Plasterboard feature wall',            'm2',    45.00),
    (6,  'linings_cornice',          'Cornice',                              'lm',    14.00),
    (6,  'linings_wet_area',         'Wet area lining villaboard',           'm2',    42.00),

    -- 7. Fit-out Carpentry
    (7,  'fitout_doors',             'Doors & hardware',                     'each', 420.00),
    (7,  'fitout_door_hardware',     'Door hardware',                        'each',  85.00),
    (7,  'fitout_skirtings',         'Skirtings & architraves',              'lm',    22.00),
    (7,  'fitout_shelving',          'Shelving',                             'lm',    95.00),
    (7,  'fitout_stairs',            'Staircase',                            'each', 4800.00),

    -- 8. Cabinetry
    (8,  'cabinetry_kitchen',        'Kitchen cabinetry',                    'lot',  14500.00),
    (8,  'cabinetry_laundry',        'Laundry cabinetry',                    'lot',  3800.00),
    (8,  'cabinetry_vanities',       'Bathroom vanities',                    'each', 1400.00),
    (8,  'cabinetry_wardrobes',      'Built-in wardrobes',                   'each', 2200.00),
    (8,  'cabinetry_linen',          'Linen cupboard',                       'each', 1100.00),

    -- 9. Paint
    (9,  'paint_internal',           'Internal paint walls & ceilings',      'm2',    18.00),
    (9,  'paint_external',           'External paint',                       'm2',    24.00),
    (9,  'paint_feature',            'Feature walls',                        'm2',    28.00),
    (9,  'paint_doors_trim',         'Doors & trim enamel',                  'each',  90.00),

    -- 10. Flooring
    (10, 'flooring_tiles_wet',       'Tiles wet areas',                      'm2',    95.00),
    (10, 'flooring_tiles',           'Floor tiles',                          'm2',    75.00),
    (10, 'flooring_carpet',          'Carpet',                               'm2',    55.00),
    (10, 'flooring_timber',          'Timber flooring',                      'm2',   110.00),
    (10, 'flooring_vinyl',           'Vinyl plank flooring',                 'm2',    48.00),
    (10, 'flooring_polished_concrete', 'Polished concrete',                  'm2',    90.00),

    -- 11. Fixtures & Tapware
    (11, 'fixtures_toilets',         'Toilets',                              'each', 650.00),
    (11, 'fixtures_basins',          'Basins',                               'each', 480.00),
    (11, 'fixtures_showers',         'Shower screens & fittings',            'each', 1250.00),
    (11, 'fixtures_baths',           'Baths',                                'each', 1600.00),
    (11, 'fixtures_taps',            'Taps & mixers',                        'each', 220.00),
    (11, 'fixtures_bathroom_lot',    'Bathroom fixtures complete',           'lot',  4200.00),

    -- 12. Electrical
    (12, 'electrical_gpo',           'GPO power points',                     'each',  95.00),
    (12, 'electrical_switches',      'Light switches',                       'each',  85.00),
    (12, 'electrical_lights',        'Light points & downlights',            'each', 120.00),
    (12, 'electrical_data',          'Data points',                          'each', 110.00),
    (12, 'electrical_switchboard',   'Switchboard upgrade',                  'each', 1800.00),
    (12, 'electrical_general',       'General electrical',                   'lot',  8500.00),

    -- 13. Preliminaries
    (13, 'prelim_permits',           'Permits & council fees',               'lot',  3200.00),
    (13, 'prelim_site_costs',        'Site costs & facilities',              'lot',  2500.00),
    (13, 'prelim_insurance',         'Site insurance',                       'lot',  1800.00),
    (13, 'prelim_scaffolding',       'Scaffolding',                          'weeks', 1200.00),
    (13, 'prelim_waste',             'Waste & skip bins',                    'each', 480.00),
    (13, 'prelim_supervision',       'Site supervision',                     'weeks', 1900.00)
) AS v(trade_category_id, line_item_key, description, unit, rate)
WHERE NOT EXISTS (
  SELECT 1 FROM cost_rates c
  WHERE c.line_item_key = v.line_item_key AND c.state IS NULL
);

-- ─── State-adjusted overrides ─────────────────────────────────
-- Generated from national defaults with a per-state cost index.

INSERT INTO cost_rates (trade_category_id, line_item_key, description, unit, rate, state, is_default)
SELECT
  c.trade_category_id,
  c.line_item_key,
  c.description,
  c.unit,
  ROUND(c.rate * m.mult, 2),
  m.state,
  false
FROM cost_rates c
CROSS JOIN (
  VALUES
    ('NSW', 1.10::numeric),
    ('VIC', 1.00::numeric),
    ('QLD', 0.97::numeric),
    ('WA',  1.02::numeric),
    ('SA',  0.95::numeric),
    ('TAS', 0.98::numeric),
    ('ACT', 1.09::numeric),
    ('NT',  1.12::numeric)
) AS m(state, mult)
WHERE c.state IS NULL
ON CONFLICT (line_item_key, state) DO NOTHING;
