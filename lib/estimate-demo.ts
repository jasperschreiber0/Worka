// ─── Demo estimate fixture — 16 Alfred Street, Woonona ────────────────────────
// A representative reasoned estimate for the reference project, so Stage 3 is
// fully demonstrable without Supabase or an API key. It exercises the shape the
// real generator produces: sectioned line items, provisional sums for the
// unreadable structural scope, per-opening window take-off (NOT flat-rated),
// PC allowances for the majority-unselected finishes schedules, secondary
// dwelling tagged as its own build, and the schedule-subtotal guard firing on
// the two draft LJD schedules. It is a representative subset — the live
// generator targets 150–250 lines; this fixture demonstrates every section and
// every guard rather than every opening.

import {
  assembleEstimate,
  runGuards,
  contingencyForMaturity,
  type EstimateLineItem,
  type EstimateBasis,
  type LocationScope,
  type GeneratedEstimate,
} from './estimate-generation'

function li(
  section: string,
  description: string,
  location: LocationScope,
  source_ref: string | null,
  quantity: number | null,
  unit: string | null,
  rate: number | null,
  basis: EstimateBasis,
  confidence: number,
  notes: string | null = null
): EstimateLineItem {
  const total = quantity !== null && rate !== null ? Math.round(quantity * rate * 100) / 100 : null
  return {
    section,
    trade_category_id: 0, // set by assemble via section; not read from the fixture
    description,
    location_scope: location,
    source_ref,
    quantity,
    unit,
    rate,
    total,
    basis,
    confidence,
    notes,
  }
}

export const DEMO_ESTIMATE_ITEMS: EstimateLineItem[] = [
  // ── Preliminaries ──
  li('preliminaries', 'Site establishment, temporary fencing & signage', 'general', null, 1, 'lot', 6500, 'allowance', 70),
  li('preliminaries', 'Site supervision & project management', 'general', null, 32, 'wk', 1850, 'allowance', 65, 'Assumes ~32-week program — confirm against agreed staging'),
  li('preliminaries', 'Temporary power, water & site amenities', 'general', null, 32, 'wk', 220, 'allowance', 70),
  li('preliminaries', 'Public liability & contract works insurance', 'general', null, 1, 'lot', 9800, 'allowance', 70),
  li('preliminaries', 'Skip bins & waste management (site waste plan)', 'general', 'DA waste plan', 12, 'ea', 650, 'allowance', 75),
  li('preliminaries', 'Scaffolding — two-storey addition', 'primary', null, 1, 'lot', 18500, 'allowance', 65),

  // ── Demolition ──
  li('demolition', 'Demolish existing garage', 'primary', 'DA.A104', 36, 'm2', 95, 'measured', 80),
  li('demolition', 'Demolish freestanding laundry', 'primary', 'DA.A104', 12, 'm2', 110, 'measured', 78),
  li('demolition', 'Remove timber deck & pergola', 'external', 'DA.A104', 1, 'lot', 4200, 'allowance', 75),
  li('demolition', 'Remove existing staircase', 'primary', 'DA.A104', 1, 'lot', 2800, 'allowance', 75),
  li('demolition', 'Remove existing chimney', 'primary', 'DA.A104', 1, 'lot', 3600, 'allowance', 70),
  li('demolition', 'Break out & cart existing driveway/paths', 'external', 'DA.A104', 1, 'lot', 6800, 'allowance', 70),
  li('demolition', 'Hazmat (asbestos) survey & allowance', 'primary', null, 1, 'lot', 4500, 'provisional', 40, 'Existing dwelling age unstated — hazmat survey required before demolition; provisional'),

  // ── Earthworks ──
  li('earthworks', 'Bulk excavation for first-floor addition footings', 'primary', null, 85, 'm3', 95, 'allowance', 55, 'Depth pending geotech'),
  li('earthworks', 'Acid sulfate soil handling & treatment (Class 5)', 'general', 'DA site plan', 1, 'lot', 12000, 'provisional', 40, 'Class 5 ASS noted — treatment scope pending geotech report'),
  li('earthworks', 'Cut/fill to sloping site levels', 'external', 'DA site plan', 1, 'lot', 9500, 'provisional', 45, 'Sloping RLs 36.35–39.92; confirm with survey'),

  // ── Concrete (structural detail unreadable → provisional) ──
  li('concrete', 'Footings to first-floor addition', 'primary', 'Structural REV2 (unreadable)', 1, 'lot', 38000, 'provisional', 35, 'Footing type/size unconfirmed — engineer detail unreadable. Provisional pending engineering.'),
  li('concrete', 'Ground slab / slab thickening as required', 'primary', 'Structural REV2 (unreadable)', 1, 'lot', 22000, 'provisional', 35, 'Slab design unreadable — provisional'),
  li('concrete', 'Secondary dwelling slab & footings', 'secondary_dwelling', 'DA.A secondary dwelling', 1, 'lot', 24000, 'provisional', 40, 'Engineer detail pending'),
  li('concrete', 'Pool shell — concrete & reinforcement', 'pool', 'DA pool plan', 1, 'lot', 42000, 'provisional', 45, 'Pool engineering pending; provisional'),

  // ── Structural & framing (unreadable → provisional) ──
  li('structural', 'Structural steel — beams/lintels to addition', 'primary', 'Structural REV2 (unreadable)', 1, 'lot', 34000, 'provisional', 30, 'Steel sizing unreadable — NO member sizes invented. Provisional pending engineering confirmation.'),
  li('structural', 'First-floor timber wall framing', 'primary', 'DA first floor plan', 108, 'm2', 165, 'allowance', 55, 'Rate on GFA; confirm against engineer frame detail'),
  li('structural', 'Roof framing / trusses to addition', 'primary', 'DA roof plan', 1, 'lot', 28000, 'allowance', 50),
  li('structural', 'Secondary dwelling framing (walls + roof)', 'secondary_dwelling', 'DA.A secondary dwelling', 42.5, 'm2', 320, 'allowance', 50),

  // ── Roofing ──
  li('roofing', 'Colorbond metal roof — addition (Windspray)', 'primary', 'Finishes schedule', 165, 'm2', 135, 'allowance', 65, 'Colour per finishes schedule'),
  li('roofing', 'Gutters, downpipes & fascia', 'primary', 'DA roof plan', 78, 'lm', 85, 'allowance', 70),
  li('roofing', 'Gable rake extensions (200mm) ×2', 'primary', 'DA first floor plan', 2, 'ea', 1200, 'measured', 70),
  li('roofing', 'Secondary dwelling roof', 'secondary_dwelling', 'DA.A secondary dwelling', 48, 'm2', 145, 'allowance', 60),

  // ── External cladding ──
  li('cladding', 'External cladding to first-floor addition', 'primary', 'DA elevations', 96, 'm2', 190, 'allowance', 55, 'Cladding type per finishes — confirm selection'),

  // ── Windows & doors — INDIVIDUAL take-off (distinct rates, not flat-rated) ──
  li('windows_doors', 'W01 — Aluminium awning 1200×900, low-e', 'primary', 'DA.A500', 4, 'ea', 780, 'measured', 75),
  li('windows_doors', 'W07 — Aluminium sliding 1800×1200, low-e', 'primary', 'DA.A500', 3, 'ea', 1450, 'measured', 75),
  li('windows_doors', 'W12 — Timber double-glazed fixed 2400×1500 (Canterbury)', 'primary', 'DA.A501', 2, 'ea', 3900, 'measured', 70, 'Timber double-glazed — premium frame type'),
  li('windows_doors', 'W18 — Timber double-glazed awning 900×1200 (Canterbury)', 'primary', 'DA.A501', 5, 'ea', 2350, 'measured', 70),
  li('windows_doors', 'W22 — Highlight fixed 1500×600, low-e', 'primary', 'DA.A500', 6, 'ea', 640, 'measured', 72),
  li('windows_doors', 'D01 — Entry pivot door, timber', 'primary', 'DA.A501', 1, 'ea', 6800, 'measured', 68),
  li('windows_doors', 'D04 — Aluminium stacker 3600×2100, low-e', 'primary', 'DA.A501', 2, 'ea', 5600, 'measured', 70),
  li('windows_doors', 'D09 — External hinged 820×2040', 'primary', 'DA.A501', 4, 'ea', 1350, 'measured', 72),
  li('windows_doors', 'Secondary dwelling windows & sliding door', 'secondary_dwelling', 'DA.A secondary dwelling', 1, 'lot', 9800, 'allowance', 60),

  // ── Insulation ──
  li('insulation', 'Wall batts R2.5 — addition', 'primary', 'BASIX', 210, 'm2', 14, 'allowance', 70),
  li('insulation', 'Ceiling batts R6.0', 'primary', 'BASIX', 165, 'm2', 18, 'allowance', 70),

  // ── Internal linings ──
  li('linings', 'Plasterboard walls & ceilings — addition', 'primary', 'DA plans', 540, 'm2', 62, 'allowance', 65),
  li('linings', 'Cornices, skirting & architraves (Intrim)', 'primary', 'Finishes schedule', 1, 'lot', 14500, 'allowance', 55, 'Profiles per finishes schedule'),
  li('linings', 'Home theatre acoustic wall lining', 'primary', 'Ground floor plan', 1, 'lot', 8500, 'provisional', 45, 'Acoustic spec pending'),

  // ── Waterproofing & tiling (finishes unselected → PC allowances) ──
  li('waterproof_tile', 'Waterproofing to wet areas', 'primary', 'DA plans', 8, 'ea', 950, 'measured', 65),
  li('waterproof_tile', 'Wall & floor tiling — PC allowance (tiles unselected)', 'primary', 'Materials schedule (unpriced)', 1, 'lot', 28000, 'pc_sum', 45, 'Materials + Finishes schedule shows $0 — every tile is an unselected option. PC allowance for full wet-area scope, NOT a schedule subtotal.'),

  // ── Flooring & paving ──
  li('flooring', 'Engineered timber flooring — PC allowance', 'primary', 'Materials schedule (unpriced)', 180, 'm2', 145, 'pc_sum', 45, 'Selection open (carpet vs timber upstairs)'),
  li('flooring', 'Sandstone / limestone paving (herringbone)', 'external', 'Materials schedule', 85, 'm2', 220, 'pc_sum', 50),

  // ── Joinery & stone (2022-dated drawings — reconcile) ──
  li('joinery_stone', 'Kitchen joinery — custom (LJD 4201)', 'primary', 'LJD 4201', 1, 'lot', 62000, 'allowance', 55, '2022-dated drawing — reconcile against current GF plan before pricing firm'),
  li('joinery_stone', "Butler's pantry joinery — custom (LJD 4211)", 'primary', 'LJD 4211', 1, 'lot', 34000, 'allowance', 55, '2022-dated drawing — reconcile'),
  li('joinery_stone', 'Stone benchtops — PC allowance (material unselected)', 'primary', 'Materials schedule (unpriced)', 1, 'lot', 24000, 'pc_sum', 45, 'Corian/quartzite/porcelain still options'),
  li('joinery_stone', 'Robes, laundry & vanity joinery', 'primary', 'DA plans', 1, 'lot', 28000, 'allowance', 55),

  // ── Painting ──
  li('painting', 'Internal painting — walls, ceilings, trim', 'primary', 'Finishes schedule', 540, 'm2', 38, 'allowance', 60, 'Colours per room unselected — allowance'),
  li('painting', 'External painting', 'primary', 'DA elevations', 1, 'lot', 12000, 'allowance', 60),

  // ── Electrical & solar ──
  li('electrical_solar', 'Electrical rough-in & fit-off (CELED layout)', 'primary', 'CELED set', 1, 'lot', 42000, 'allowance', 55, 'Six RFIs open on CELED drawings — see open questions'),
  li('electrical_solar', 'Home theatre & festoon/feature lighting', 'primary', 'CELED ground floor', 1, 'lot', 9500, 'allowance', 50, 'Festoon GPO layout RFI open'),
  li('electrical_solar', 'Solar PV system', 'primary', 'Roof plan BASIX', 1, 'lot', 8500, 'provisional', 35, 'Roof plan "SOLAR 10KW ×6" inconsistent with BASIX 2.6kW min — capacity to verify; provisional'),
  li('electrical_solar', 'Secondary dwelling electrical', 'secondary_dwelling', 'CELED secondary dwelling', 1, 'lot', 12000, 'allowance', 55, 'Sub-board location RFI open'),

  // ── Plumbing, gas & hydraulics ──
  li('plumbing_hydr', 'Plumbing rough-in & drainage', 'primary', 'DA plans', 1, 'lot', 38000, 'allowance', 55),
  li('plumbing_hydr', 'Rainwater harvesting tanks (2000L + 3000L)', 'external', 'DA hydraulic notes', 1, 'lot', 7800, 'allowance', 65),
  li('plumbing_hydr', 'Whole-home water filtration system', 'primary', 'DA hydraulic notes', 1, 'lot', 6500, 'provisional', 45, 'System spec pending'),
  li('plumbing_hydr', 'Gas rough-in — BBQ, cooktop, fireplace', 'primary', 'Fittings schedule', 1, 'lot', 5400, 'allowance', 55, 'Fireplace flued vs flueless unselected'),
  li('plumbing_hydr', 'Secondary dwelling plumbing & kitchenette', 'secondary_dwelling', 'DA.A secondary dwelling', 1, 'lot', 14000, 'allowance', 55),

  // ── HVAC ──
  li('hvac', 'Ducted air conditioning — primary dwelling', 'primary', null, 1, 'lot', 22000, 'allowance', 55, 'System size pending mechanical design'),

  // ── Pool & safety ──
  li('pool', 'Pool fit-out — pump, filtration, plant room', 'pool', 'DA pool plan', 1, 'lot', 26000, 'allowance', 55),
  li('pool', 'Child-safety glass fencing (AS1926.1)', 'pool', 'DA pool plan', 42, 'lm', 480, 'measured', 65),
  li('pool', 'Retractable shade-sail pergola over pool', 'pool', 'DA pool plan', 1, 'lot', 18500, 'provisional', 45, 'Automatic retractable system — spec pending'),

  // ── Fixtures & fittings (schedule majority unselected → PC allowance) ──
  li('fixtures', 'Tapware & sanitaryware — PC allowance', 'primary', 'Fittings schedule (mostly $0)', 1, 'lot', 45000, 'pc_sum', 40, 'Fittings schedule total $35,199 is NOT a budget — most rows are $0/unselected. PC allowance sized for full luxury scope (Brodware polished nickel, Toto smart toilets).'),
  li('fixtures', 'Appliances — PC allowance (ILVE, Falmec, F&P)', 'primary', 'Fittings schedule', 1, 'lot', 32000, 'pc_sum', 45),

  // ── External works & landscaping ──
  li('external_works', 'Boundary & pool fencing', 'external', 'Materials schedule', 1, 'lot', 14000, 'allowance', 55),
  li('external_works', 'Retaining walls', 'external', null, 1, 'lot', 16000, 'provisional', 45, 'Extent pending survey/geotech'),
  li('external_works', 'Landscaping, planting & irrigation', 'external', 'DA concept only', 1, 'lot', 22000, 'provisional', 40, 'No landscape package supplied — concept only; provisional'),

  // ── Specialist ──
  li('specialist', 'Sauna — supply & install', 'primary', 'Ground floor plan', 1, 'lot', 18000, 'provisional', 45, 'Wellness studio — spec pending'),
  li('specialist', 'Ice bath & treadmill provision', 'primary', 'Ground floor plan', 1, 'lot', 6500, 'provisional', 40),
  li('specialist', 'Home theatre acoustic star-ceiling', 'primary', 'Ground floor plan', 1, 'lot', 14500, 'provisional', 45),

  // ── Completion ──
  li('completion', 'Final clean & builders clean', 'general', null, 1, 'lot', 4500, 'allowance', 75),
  li('completion', 'Handover, defects & practical completion', 'general', null, 1, 'lot', 6000, 'allowance', 70),
]

// The two draft LJD schedules — mostly unselected. The subtotal guard fires on
// both, matching the assessment's warning not to read either total as a budget.
const DEMO_SCHEDULES = [
  {
    name: 'DRAFT Fittings + Fixtures + Appliances',
    subtotal: 35199,
    rows: [
      { label: 'Selected item A', amount: 18500 },
      { label: 'Selected item B', amount: 16699 },
      ...Array.from({ length: 22 }, (_, i) => ({ label: `Unselected ${i + 1}`, amount: 0 })),
    ],
  },
  {
    name: 'DRAFT Materials + Finishes',
    subtotal: 0,
    rows: Array.from({ length: 30 }, (_, i) => ({ label: `Option ${i + 1}`, amount: 0 })),
  },
]

export function buildDemoEstimate(): GeneratedEstimate {
  const guardWarnings = runGuards({
    items: DEMO_ESTIMATE_ITEMS,
    schedules: DEMO_SCHEDULES,
    // No branding candidate is passed — nothing tries to brand from documents,
    // so the branding guard correctly stays silent here.
  })
  return assembleEstimate({
    items: DEMO_ESTIMATE_ITEMS,
    contingencyPct: contingencyForMaturity('da_modification'), // 12.5% — DA stage
    marginPct: 18,
    gstPct: 10,
    isIndicative: true, // structural/spec/selection gaps keep it budget-range
    pricingMode: 'market',
    guardWarnings,
    branding: { company_name: null, contact: null },
    confidenceSummary:
      'Budget/preliminary estimate at DA maturity. Structural, pool and specialist items carried as provisional sums; finishes and fittings as PC allowances pending selections. Not tender-ready.',
    demo: true,
  })
}
