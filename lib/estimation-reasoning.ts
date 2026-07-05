// ─── Estimation reasoning engine (Stage 1) ────────────────────────────────────
// The inspectable "reason first, price later" stage. Given a bundle of project
// documents it runs TWO separate, auditable passes (never one mega-prompt):
//
//   1. classifyDocuments()  — per-document: category, issue status, date and
//      extraction status. Explicitly flags a document whose readable content
//      does not match its apparent purpose (the structural set that only yields
//      letterhead) as `failed`/unreadable rather than silently proceeding.
//   2. reasonAboutScope()   — the scope object: site data, room-by-room scope,
//      specialty inclusions, complexity rating WITH evidence, a recommended
//      estimate type WITH justification, per-trade justification and the
//      essential open questions.
//
// All output is typed and persisted (migration 018) so the assessment is
// visible/auditable in the UI, never consumed silently on the way to a number.
// Pricing happens in later stages, against the existing quote/rate engine.

// ─── Enums ────────────────────────────────────────────────────────────────────

export type DocumentCategory =
  | 'architectural'   // architectural / DA set
  | 'structural'      // structural / engineering
  | 'electrical'
  | 'hydraulic'       // hydraulic / plumbing
  | 'mechanical'      // mechanical / HVAC
  | 'joinery'         // joinery / interior schedule
  | 'finishes'        // finishes / fixtures / materials schedule
  | 'survey'
  | 'geotech'
  | 'specification'   // written spec / scope of works
  | 'other'

export const DOCUMENT_CATEGORIES: DocumentCategory[] = [
  'architectural', 'structural', 'electrical', 'hydraulic', 'mechanical',
  'joinery', 'finishes', 'survey', 'geotech', 'specification', 'other',
]

export const DOCUMENT_CATEGORY_LABEL: Record<DocumentCategory, string> = {
  architectural: 'Architectural / DA',
  structural: 'Structural / Engineering',
  electrical: 'Electrical',
  hydraulic: 'Hydraulic / Plumbing',
  mechanical: 'Mechanical / HVAC',
  joinery: 'Joinery / Interior schedule',
  finishes: 'Finishes / Fixtures schedule',
  survey: 'Survey',
  geotech: 'Geotechnical',
  specification: 'Specification / SOW',
  other: 'Other',
}

/** ok = readable content matches purpose; partial = some content missing or
 *  low quality; failed = unreadable / content does not match apparent purpose */
export type ExtractionStatus = 'ok' | 'partial' | 'failed'

export type IssueStatus =
  | 'concept' | 'da' | 'da_modification' | 'cc' | 'cdc' | 'ifc' | 'draft' | 'unknown'

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  concept: 'Concept',
  da: 'DA',
  da_modification: 'DA Modification',
  cc: 'Construction Certificate',
  cdc: 'CDC',
  ifc: 'Issued for Construction',
  draft: 'Draft',
  unknown: 'Unknown',
}

export type ComplexityRating = 'Low' | 'Medium' | 'High' | 'Luxury'

export type EstimateType = 'Budget/Preliminary' | 'Tender' | 'Internal Costing'

export type StatedPurpose = 'internal_feasibility' | 'tender' | 'external_pricing' | null

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClassifiedDocument {
  /** null in demo mode / when the document is a hint rather than an uploaded file */
  file_id: string | null
  filename: string
  category: DocumentCategory
  /** 0–100 confidence in the classification */
  category_confidence: number
  issue_status: IssueStatus
  /** date as shown on the document, verbatim (e.g. "25/05/26", "10/10/22") — null if none */
  document_date: string | null
  /** author/practice from the document's own title block ONLY — provenance, never
   *  used to brand the estimate (see the branding guard in later stages) */
  author: string | null
  extraction_status: ExtractionStatus
  /** one line describing what was actually readable */
  content_summary: string
  /** set whenever extraction_status !== 'ok' — why the content is missing/unusable */
  unreadable_reason: string | null
}

export interface SiteData {
  address: string | null
  lot_details: string | null
  council: string | null
  zoning: string | null
  site_area_m2: number | null
  existing_gfa_m2: number | null
  proposed_gfa_m2: number | null
  existing_site_coverage: string | null
  proposed_site_coverage: string | null
  fsr_existing: string | null
  fsr_proposed: string | null
  fsr_allowable: string | null
  storeys: string | null
  building_height: string | null
  /** heritage / BAL / flood / acid-sulfate-soil notations, free text */
  soil_notations: string | null
}

export type RoomDisposition = 'demolition' | 'retained' | 'new' | 'altered'

export interface RoomScopeItem {
  /** "Ground floor" | "First floor" | "Secondary dwelling" | "External" */
  level: string
  space: string
  disposition: RoomDisposition
  notes: string | null
}

export interface SpecialtyInclusion {
  item: string
  /** why it needs its own trade or provisional sum */
  rationale: string
  source_ref: string | null
}

export interface TradeJustification {
  /** cost-section name — may be finer than the 13 locked trade categories
   *  (this is a reasoning/presentation grouping, not a rate key) */
  trade: string
  reason: string
  source_ref: string | null
}

export type OpenQuestionGroup =
  | 'missing_documents'
  | 'drawing_annotations'
  | 'unselected_finishes'
  | 'commercial'
  | 'output'

export const OPEN_QUESTION_GROUP_LABEL: Record<OpenQuestionGroup, string> = {
  missing_documents: 'Missing or unreadable documents',
  drawing_annotations: 'Unresolved annotations on the drawings',
  unselected_finishes: 'Unselected items in the finishes schedules',
  commercial: 'Commercial parameters',
  output: 'Output preference',
}

export interface OpenQuestion {
  group: OpenQuestionGroup
  question: string
  /** drawing/schedule reference the question comes from — quote it, don't paraphrase */
  source_reference: string | null
}

export interface ScopeReasoning {
  project_type: string
  scope_summary: string[]
  site_data: SiteData
  room_scope: RoomScopeItem[]
  specialty_inclusions: SpecialtyInclusion[]
  /** date/version mismatches between related document sets — reconciliation risks */
  date_mismatches: string[]
  complexity_rating: ComplexityRating
  /** the specific evidence behind the rating — never a bare assertion */
  complexity_justification: string[]
  recommended_estimate_type: EstimateType
  estimate_type_justification: string
  trade_list: TradeJustification[]
  assumptions: string[]
  risks: string[]
  exclusions: string[]
}

export interface ProjectAssessment {
  job_id: string | null
  documents: ClassifiedDocument[]
  scope: ScopeReasoning
  open_questions: OpenQuestion[]
  generated_at: string
  demo: boolean
}

// ─── Model ────────────────────────────────────────────────────────────────────

export const REASONING_MODEL = 'claude-sonnet-4-6'

// ─── Estimate-type decision logic (Step 5) ────────────────────────────────────
// Deterministic so the recommendation is reproducible and testable, and never
// silently defaults to "Tender".

export function recommendEstimateType(input: {
  structuralReadable: boolean
  writtenSpecPresent: boolean
  finishesLocked: boolean
  ifcSetPresent: boolean
  statedPurpose?: StatedPurpose
}): { type: EstimateType; justification: string } {
  if (input.statedPurpose === 'internal_feasibility') {
    return {
      type: 'Internal Costing',
      justification:
        'Stated purpose is internal feasibility / go-no-go, so an internal costing is the right output regardless of documentation maturity.',
    }
  }

  const gaps: string[] = []
  if (!input.structuralReadable) gaps.push('structural/engineering detail is missing or unreadable')
  if (!input.writtenSpecPresent) gaps.push('no written specification / scope of works was provided')
  if (!input.finishesLocked) gaps.push('fixtures/finishes are still shown as unselected options')

  if (gaps.length > 0) {
    return {
      type: 'Budget/Preliminary',
      justification: `Not tender-ready because ${joinList(gaps)}. A budget/preliminary estimate is the only responsible output until these are resolved — pricing them firm would embed false precision.`,
    }
  }

  if (input.ifcSetPresent) {
    return {
      type: 'Tender',
      justification:
        'A full issued-for-construction set, engineer’s detail and locked selections are present, so a tender estimate is appropriate.',
    }
  }

  return {
    type: 'Budget/Preliminary',
    justification:
      'No issued-for-construction set is present, so a budget/preliminary estimate is the appropriate output.',
  }
}

function joinList(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// ─── Letterhead / unreadable backstop ─────────────────────────────────────────
// A structural document that only extracts as letterhead/boilerplate must be
// flagged, not treated as reviewed. The classification call sees the document
// (incl. via vision) and sets extraction_status, but where we DO have an
// extracted text layer this deterministic check is a backstop so a "looks fine"
// misclassification can't slip an unreviewed engineering set through.

const STRUCTURAL_TECHNICAL_TOKENS = [
  'footing', 'beam', 'slab', 'lintel', 'bearer', 'joist', 'bracing', 'reinforcement',
  'n12', 'n16', 'n20', 'sl72', 'sl82', 'waffle', 'pier', 'pad footing', 'stirrup',
  'ub ', 'uc ', 'pfc', 'lvl', 'starter bar', 'cog', 'rebar', 'mesh', 'r.l', 'rl ',
]

const LETTERHEAD_TOKENS = [
  'pty ltd', 'consulting engineers', 'structural engineers', 'abn', 'a.b.n',
  'phone', 'email', 'www.', 'street', 'road', 'director',
]

/** True when a document classified as structural yields text that reads like a
 *  letterhead/cover page with no engineering content. Only meaningful when a
 *  usable text layer exists; image-only PDFs read via vision are judged by the
 *  classification call itself and should pass rawText='' here (returns false). */
export function looksLikeLetterheadOnly(rawText: string, category: DocumentCategory): boolean {
  if (category !== 'structural') return false
  const compact = (rawText || '').toLowerCase().replace(/\s+/g, ' ').trim()
  // No usable text layer at all → let the vision classification stand.
  if (compact.length === 0) return false
  // Plenty of readable content → trust it, don't second-guess.
  if (compact.length > 4000) return false
  const technicalHits = STRUCTURAL_TECHNICAL_TOKENS.filter((t) => compact.includes(t)).length
  const letterheadHits = LETTERHEAD_TOKENS.filter((t) => compact.includes(t)).length
  // Short content, boilerplate present, essentially no engineering vocabulary.
  return technicalHits < 2 && letterheadHits >= 1
}

// ─── Tool schemas (real mode — Claude tool use guarantees schema-valid output) ──

export const CLASSIFY_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    documents: {
      type: 'array',
      description: 'One entry per supplied document, in the same order they were provided.',
      items: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          category: { type: 'string', enum: DOCUMENT_CATEGORIES },
          category_confidence: { type: 'integer', minimum: 0, maximum: 100 },
          issue_status: {
            type: 'string',
            enum: ['concept', 'da', 'da_modification', 'cc', 'cdc', 'ifc', 'draft', 'unknown'],
          },
          document_date: { type: ['string', 'null'], description: 'Date shown on the document, verbatim. null if none.' },
          author: { type: ['string', 'null'], description: 'Practice/author from the title block only. Never a made-up company name.' },
          extraction_status: {
            type: 'string',
            enum: ['ok', 'partial', 'failed'],
            description: 'failed when readable content does NOT match the apparent purpose (e.g. a structural set that only shows letterhead).',
          },
          content_summary: { type: 'string', description: 'One line describing what is actually readable in this document.' },
          unreadable_reason: { type: ['string', 'null'], description: 'Required whenever extraction_status is partial or failed.' },
        },
        required: ['filename', 'category', 'category_confidence', 'issue_status', 'extraction_status', 'content_summary'],
      },
    },
  },
  required: ['documents'],
}

export const REASON_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    project_type: { type: 'string' },
    scope_summary: { type: 'array', items: { type: 'string' } },
    site_data: {
      type: 'object',
      properties: {
        address: { type: ['string', 'null'] },
        lot_details: { type: ['string', 'null'] },
        council: { type: ['string', 'null'] },
        zoning: { type: ['string', 'null'] },
        site_area_m2: { type: ['number', 'null'] },
        existing_gfa_m2: { type: ['number', 'null'] },
        proposed_gfa_m2: { type: ['number', 'null'] },
        existing_site_coverage: { type: ['string', 'null'] },
        proposed_site_coverage: { type: ['string', 'null'] },
        fsr_existing: { type: ['string', 'null'] },
        fsr_proposed: { type: ['string', 'null'] },
        fsr_allowable: { type: ['string', 'null'] },
        storeys: { type: ['string', 'null'] },
        building_height: { type: ['string', 'null'] },
        soil_notations: { type: ['string', 'null'] },
      },
    },
    room_scope: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level: { type: 'string' },
          space: { type: 'string' },
          disposition: { type: 'string', enum: ['demolition', 'retained', 'new', 'altered'] },
          notes: { type: ['string', 'null'] },
        },
        required: ['level', 'space', 'disposition'],
      },
    },
    specialty_inclusions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          rationale: { type: 'string' },
          source_ref: { type: ['string', 'null'] },
        },
        required: ['item', 'rationale'],
      },
    },
    date_mismatches: { type: 'array', items: { type: 'string' } },
    complexity_rating: { type: 'string', enum: ['Low', 'Medium', 'High', 'Luxury'] },
    complexity_justification: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific evidence from the documents behind the rating. Never a bare assertion.',
    },
    // The estimate-type recommendation is computed deterministically from the
    // signals below (recommendEstimateType); the model reports the signals, code
    // decides — so the recommendation can never silently default to Tender.
    structural_readable: { type: 'boolean', description: 'Is readable structural/engineering detail present?' },
    written_spec_present: { type: 'boolean', description: 'Is a written specification / scope of works present?' },
    finishes_locked: { type: 'boolean', description: 'Are fixtures/finishes selections locked (not majority-unselected options)?' },
    ifc_set_present: { type: 'boolean', description: 'Is a full issued-for-construction set present?' },
    trade_list: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          trade: { type: 'string' },
          reason: { type: 'string' },
          source_ref: { type: ['string', 'null'] },
        },
        required: ['trade', 'reason'],
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    exclusions: { type: 'array', items: { type: 'string' } },
    open_questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: {
            type: 'string',
            enum: ['missing_documents', 'drawing_annotations', 'unselected_finishes', 'commercial', 'output'],
          },
          question: { type: 'string' },
          source_reference: { type: ['string', 'null'] },
        },
        required: ['group', 'question'],
      },
    },
  },
  required: [
    'project_type', 'scope_summary', 'site_data', 'room_scope', 'specialty_inclusions',
    'complexity_rating', 'complexity_justification', 'structural_readable',
    'written_spec_present', 'finishes_locked', 'ifc_set_present', 'trade_list', 'open_questions',
  ],
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

export const CLASSIFY_SYSTEM_PROMPT = `You are a senior Australian residential construction estimator doing document intake on a project bundle. You are NOT pricing anything yet — you are classifying and quality-checking each supplied document.

For every document, in the order supplied:
- Classify it into one category.
- Record its issue status (concept, DA, DA Modification, CC, CDC, issued for construction, draft) and the date shown on it, verbatim.
- Read what is ACTUALLY legible in it and summarise that in one line.
- Set extraction_status honestly:
  • ok      — the readable content matches the document's apparent purpose.
  • partial — some expected content is missing, low quality, or unclear.
  • failed  — the readable content does NOT match its apparent purpose. The
              canonical case: a document that is nominally structural
              engineering but only shows a letterhead / cover page / boilerplate
              with no footing schedule, beam sizes, slab detail or bracing plan.
              Flag this as failed and say so in unreadable_reason. NEVER treat an
              unreadable engineering set as though it was reviewed.
- author is the practice named in the document's own title block, or null. Never invent a company name.

Return via the classify_documents tool.`

export const REASON_SYSTEM_PROMPT = `You are a senior Australian residential construction estimator and quantity surveyor. You have already classified the supplied documents. Now reason about the PROJECT — still without pricing anything.

Work from the architectural/DA set as the primary scope document. Produce:
- Project type and a plain-English scope summary.
- Site data (lot size, zoning, existing vs proposed GFA/site coverage, FSR vs allowable, storeys, height, soil/BAL/flood/heritage notations) — only where the documents show it; null otherwise.
- Room-by-room scope per level, split into demolition / retained / new / altered.
- Every specialty inclusion that needs its own trade or a provisional sum (pool, sauna/wellness, home theatre, solar/battery, water treatment, secondary dwelling, etc).
- Any date/version mismatch between related document sets (e.g. joinery drawings dated years before the current architectural issue) as a reconciliation RISK — do not silently resolve it.
- A complexity rating (Low/Medium/High/Luxury) with the SPECIFIC evidence behind it. Never assert a rating without pointing to what drove it.
- The four estimate-readiness signals (structural_readable, written_spec_present, finishes_locked, ifc_set_present) honestly — the estimate type is decided from these downstream.
- A trade/cost-section list. Include a section ONLY where the documents give evidence for it, each with a one-line reason and its source document. Never include a trade "because jobs like this usually have it".
- Assumptions, risks and exclusions.
- The essential open questions, grouped (missing_documents, drawing_annotations, unselected_finishes, commercial, output). For annotations found on the drawings, quote them by drawing reference — do not paraphrase away the specifics.

Never fabricate a specific technical fact (a member size, an engineering figure, a quantity). Where structural detail is unreadable, say so — it becomes a provisional sum later, not an invented number.

Return via the assess_project tool.`

export function buildClassifyUserText(filenames: string[]): string {
  return `Classify each of the following ${filenames.length} document${filenames.length !== 1 ? 's' : ''}, in this order:
${filenames.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Use the classify_documents tool and return exactly one entry per document, in the same order.`
}

export function buildReasonUserText(documents: ClassifiedDocument[]): string {
  const lines = documents.map(
    (d) =>
      `• ${d.filename} — ${DOCUMENT_CATEGORY_LABEL[d.category]}, ${ISSUE_STATUS_LABEL[d.issue_status]}, ${d.extraction_status}${d.unreadable_reason ? ` (${d.unreadable_reason})` : ''}`
  )
  return `Here is the classified document inventory:
${lines.join('\n')}

Reason about the project and return via the assess_project tool. Treat any document marked 'failed' as a documented gap — do not assume its content.`
}

// ─── Parsers / normalisers (tolerate loose model output) ──────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []

function asCategory(v: unknown): DocumentCategory {
  return DOCUMENT_CATEGORIES.includes(v as DocumentCategory) ? (v as DocumentCategory) : 'other'
}
function asIssueStatus(v: unknown): IssueStatus {
  const all: IssueStatus[] = ['concept', 'da', 'da_modification', 'cc', 'cdc', 'ifc', 'draft', 'unknown']
  return all.includes(v as IssueStatus) ? (v as IssueStatus) : 'unknown'
}
function asExtractionStatus(v: unknown): ExtractionStatus {
  return v === 'ok' || v === 'partial' || v === 'failed' ? v : 'partial'
}
function asComplexity(v: unknown): ComplexityRating {
  return v === 'Low' || v === 'Medium' || v === 'High' || v === 'Luxury' ? v : 'Medium'
}
function asDisposition(v: unknown): RoomDisposition {
  return v === 'demolition' || v === 'retained' || v === 'new' || v === 'altered' ? v : 'new'
}
function asQuestionGroup(v: unknown): OpenQuestionGroup {
  const all: OpenQuestionGroup[] = ['missing_documents', 'drawing_annotations', 'unselected_finishes', 'commercial', 'output']
  return all.includes(v as OpenQuestionGroup) ? (v as OpenQuestionGroup) : 'missing_documents'
}

/** Normalise the classify tool output into ClassifiedDocument[], applying the
 *  deterministic letterhead backstop where a text layer is available. */
export function normaliseClassification(
  toolInput: unknown,
  files: Array<{ file_id: string | null; filename: string; textLayer?: string }>
): ClassifiedDocument[] {
  const input = (toolInput ?? {}) as { documents?: unknown[] }
  const rows = Array.isArray(input.documents) ? input.documents : []

  return files.map((file, i) => {
    const raw = (rows[i] ?? {}) as Record<string, unknown>
    const category = asCategory(raw.category)
    let extraction_status = asExtractionStatus(raw.extraction_status)
    let unreadable_reason = str(raw.unreadable_reason)

    // Backstop: a structural doc that reads as letterhead-only overrides an
    // optimistic 'ok' classification.
    if (
      extraction_status === 'ok' &&
      file.textLayer &&
      looksLikeLetterheadOnly(file.textLayer, category)
    ) {
      extraction_status = 'failed'
      unreadable_reason =
        unreadable_reason ??
        'Only letterhead/boilerplate is readable — no footing schedule, beam sizes, slab detail or bracing plan. Treated as present-but-unreadable, not reviewed.'
    }

    return {
      file_id: file.file_id,
      filename: str(raw.filename) ?? file.filename,
      category,
      category_confidence:
        num(raw.category_confidence) !== null
          ? Math.max(0, Math.min(100, Math.round(raw.category_confidence as number)))
          : 50,
      issue_status: asIssueStatus(raw.issue_status),
      document_date: str(raw.document_date),
      author: str(raw.author),
      extraction_status,
      content_summary: str(raw.content_summary) ?? 'No readable content summary.',
      unreadable_reason,
    }
  })
}

/** Normalise the reason tool output into ScopeReasoning + OpenQuestion[]. The
 *  estimate-type recommendation is (re)computed here from the reported signals
 *  so it always follows the deterministic decision logic. */
export function normaliseReasoning(
  toolInput: unknown,
  statedPurpose: StatedPurpose = null
): { scope: ScopeReasoning; openQuestions: OpenQuestion[] } {
  const input = (toolInput ?? {}) as Record<string, unknown>

  const site = (input.site_data ?? {}) as Record<string, unknown>
  const siteData: SiteData = {
    address: str(site.address),
    lot_details: str(site.lot_details),
    council: str(site.council),
    zoning: str(site.zoning),
    site_area_m2: num(site.site_area_m2),
    existing_gfa_m2: num(site.existing_gfa_m2),
    proposed_gfa_m2: num(site.proposed_gfa_m2),
    existing_site_coverage: str(site.existing_site_coverage),
    proposed_site_coverage: str(site.proposed_site_coverage),
    fsr_existing: str(site.fsr_existing),
    fsr_proposed: str(site.fsr_proposed),
    fsr_allowable: str(site.fsr_allowable),
    storeys: str(site.storeys),
    building_height: str(site.building_height),
    soil_notations: str(site.soil_notations),
  }

  const roomScope: RoomScopeItem[] = Array.isArray(input.room_scope)
    ? (input.room_scope as unknown[]).map((r) => {
        const row = (r ?? {}) as Record<string, unknown>
        return {
          level: str(row.level) ?? 'Unspecified',
          space: str(row.space) ?? 'Space',
          disposition: asDisposition(row.disposition),
          notes: str(row.notes),
        }
      })
    : []

  const specialty: SpecialtyInclusion[] = Array.isArray(input.specialty_inclusions)
    ? (input.specialty_inclusions as unknown[]).map((s) => {
        const row = (s ?? {}) as Record<string, unknown>
        return {
          item: str(row.item) ?? 'Specialty item',
          rationale: str(row.rationale) ?? '',
          source_ref: str(row.source_ref),
        }
      })
    : []

  const tradeList: TradeJustification[] = Array.isArray(input.trade_list)
    ? (input.trade_list as unknown[]).map((t) => {
        const row = (t ?? {}) as Record<string, unknown>
        return {
          trade: str(row.trade) ?? 'Trade',
          reason: str(row.reason) ?? '',
          source_ref: str(row.source_ref),
        }
      })
    : []

  const openQuestions: OpenQuestion[] = Array.isArray(input.open_questions)
    ? (input.open_questions as unknown[]).map((q) => {
        const row = (q ?? {}) as Record<string, unknown>
        return {
          group: asQuestionGroup(row.group),
          question: str(row.question) ?? '',
          source_reference: str(row.source_reference),
        }
      }).filter((q) => q.question.length > 0)
    : []

  const { type, justification } = recommendEstimateType({
    structuralReadable: Boolean(input.structural_readable),
    writtenSpecPresent: Boolean(input.written_spec_present),
    finishesLocked: Boolean(input.finishes_locked),
    ifcSetPresent: Boolean(input.ifc_set_present),
    statedPurpose,
  })

  const scope: ScopeReasoning = {
    project_type: str(input.project_type) ?? 'Residential construction',
    scope_summary: strArr(input.scope_summary),
    site_data: siteData,
    room_scope: roomScope,
    specialty_inclusions: specialty,
    date_mismatches: strArr(input.date_mismatches),
    complexity_rating: asComplexity(input.complexity_rating),
    complexity_justification: strArr(input.complexity_justification),
    recommended_estimate_type: type,
    estimate_type_justification: justification,
    trade_list: tradeList,
    assumptions: strArr(input.assumptions),
    risks: strArr(input.risks),
    exclusions: strArr(input.exclusions),
  }

  return { scope, openQuestions }
}

// ─── Claude calls (real mode) ─────────────────────────────────────────────────
// Two separate, inspectable passes. Each uses tool use for schema-valid output
// and an AbortController so a slow request actually closes rather than hanging
// the serverless function (same pattern as the intake worker).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runTool(apiKey: string, opts: {
  system: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks: any[]
  userText: string
  toolName: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any
  timeoutMs: number
}): Promise<unknown> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  // maxRetries: 0 — the SDK's retries reuse an aborted signal and surface as
  // "Retry failed: Request was aborted" when our timer fires.
  const client = new Anthropic({ apiKey, maxRetries: 0 })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await (client.messages.create as any)(
      {
        model: REASONING_MODEL,
        max_tokens: 8192,
        system: opts.system,
        tools: [{ name: opts.toolName, description: 'Return structured assessment output', input_schema: opts.schema }],
        tool_choice: { type: 'tool', name: opts.toolName },
        messages: [{ role: 'user', content: [...opts.blocks, { type: 'text', text: opts.userText }] }],
      },
      { signal: controller.signal }
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return response.content?.find((b: any) => b.type === 'tool_use' && b.name === opts.toolName)?.input ?? null
  } finally {
    clearTimeout(timer)
  }
}

/** Pass 1 — per-document classification + extraction status. */
export async function classifyDocuments(
  apiKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docBlocks: any[],
  files: Array<{ file_id: string | null; filename: string; textLayer?: string }>,
  timeoutMs = 120_000
): Promise<ClassifiedDocument[]> {
  const toolInput = await runTool(apiKey, {
    system: CLASSIFY_SYSTEM_PROMPT,
    blocks: docBlocks,
    userText: buildClassifyUserText(files.map((f) => f.filename)),
    toolName: 'classify_documents',
    schema: CLASSIFY_TOOL_SCHEMA,
    timeoutMs,
  })
  return normaliseClassification(toolInput, files)
}

/** Pass 2 — scope reasoning + open questions. Separate call, separate audit. */
export async function reasonAboutScope(
  apiKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docBlocks: any[],
  documents: ClassifiedDocument[],
  statedPurpose: StatedPurpose = null,
  timeoutMs = 150_000
): Promise<{ scope: ScopeReasoning; openQuestions: OpenQuestion[] }> {
  const toolInput = await runTool(apiKey, {
    system: REASON_SYSTEM_PROMPT,
    blocks: docBlocks,
    userText: buildReasonUserText(documents),
    toolName: 'assess_project',
    schema: REASON_TOOL_SCHEMA,
    timeoutMs,
  })
  return normaliseReasoning(toolInput, statedPurpose)
}
