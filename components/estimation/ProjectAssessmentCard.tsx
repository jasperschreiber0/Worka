'use client'
import React from 'react'
import {
  DOCUMENT_CATEGORY_LABEL,
  ISSUE_STATUS_LABEL,
  OPEN_QUESTION_GROUP_LABEL,
  type ProjectAssessment,
  type ClassifiedDocument,
  type ExtractionStatus,
  type ComplexityRating,
  type OpenQuestionGroup,
} from '@/lib/estimation-reasoning'

// ─── ProjectAssessmentCard ────────────────────────────────────────────────────
// Surfaces the reason-first stage: document inventory + quality, the scope
// object, complexity WITH evidence, the estimate-type recommendation WITH
// justification, and the essential open questions. This is the auditable view —
// nothing here is priced.

interface Props {
  assessment: ProjectAssessment
  /** when false, the read-only open-questions section is omitted — the page
   *  renders the interactive ClarifyingQuestions panel instead (Stage 2) */
  showOpenQuestions?: boolean
}

// ── shared styles ────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--bg-border)',
  borderRadius: 16,
  padding: 20,
}
const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
  marginBottom: 12,
}

function extractionStyle(s: ExtractionStatus): React.CSSProperties {
  if (s === 'ok') return { background: 'rgba(76,175,80,0.15)', color: 'var(--status-green)' }
  if (s === 'partial') return { background: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' }
  return { background: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' }
}
const EXTRACTION_LABEL: Record<ExtractionStatus, string> = {
  ok: 'Readable',
  partial: 'Partial',
  failed: 'Unreadable',
}

function complexityStyle(c: ComplexityRating): React.CSSProperties {
  if (c === 'Luxury') return { background: 'var(--orange-subtle)', color: 'var(--orange-primary)' }
  if (c === 'High') return { background: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' }
  if (c === 'Medium') return { background: 'rgba(33,150,243,0.1)', color: 'var(--status-blue)' }
  return { background: 'rgba(76,175,80,0.15)', color: 'var(--status-green)' }
}

const dispositionStyle: Record<string, React.CSSProperties> = {
  demolition: { background: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' },
  new: { background: 'rgba(76,175,80,0.15)', color: 'var(--status-green)' },
  altered: { background: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' },
  retained: { background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)' },
}

function Bullets({ items, accent = 'var(--orange-primary)' }: { items: string[]; accent?: string }) {
  if (items.length === 0) return null
  return (
    <ul className="space-y-2">
      {items.map((t, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <span style={{ flexShrink: 0, width: 5, height: 5, borderRadius: 99, background: accent, marginTop: 8 }} />
          {t}
        </li>
      ))}
    </ul>
  )
}

// ── component ────────────────────────────────────────────────────────────────

export default function ProjectAssessmentCard({ assessment, showOpenQuestions = true }: Props) {
  const { scope, documents, open_questions } = assessment
  const failedDocs = documents.filter((d) => d.extraction_status === 'failed')

  return (
    <div className="grid gap-4">
      {/* ── Headline ─────────────────────────────────────────────────────── */}
      <section style={{ ...card, border: '1px solid var(--orange-subtle)' }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <p style={sectionLabel}>Project assessment</p>
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)', lineHeight: 1.35 }}>
              {scope.project_type}
            </p>
            {scope.site_data.address && (
              <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                {scope.site_data.address}
                {scope.site_data.lot_details ? ` — ${scope.site_data.lot_details}` : ''}
              </p>
            )}
          </div>
          <span
            className="flex-shrink-0 text-xs font-bold px-3 py-1 rounded-full"
            style={complexityStyle(scope.complexity_rating)}
          >
            {scope.complexity_rating} complexity
          </span>
        </div>

        {/* Estimate-type recommendation — the key gate */}
        <div
          className="mt-4 rounded-xl px-4 py-3"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--bg-border)' }}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
              Recommended estimate type
            </span>
            <span
              className="text-xs font-bold px-2 py-0.5 rounded-full"
              style={{ background: 'var(--orange-subtle)', color: 'var(--orange-primary)' }}
            >
              {scope.recommended_estimate_type}
            </span>
          </div>
          <p className="text-sm mt-1.5" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {scope.estimate_type_justification}
          </p>
        </div>
      </section>

      {/* ── Document inventory ───────────────────────────────────────────── */}
      <section style={card}>
        <p style={sectionLabel}>Document inventory & quality ({documents.length})</p>
        <div className="grid gap-2">
          {documents.map((d, i) => (
            <DocumentRow key={i} doc={d} />
          ))}
        </div>
        {failedDocs.length > 0 && (
          <div
            className="mt-3 rounded-xl px-4 py-3"
            style={{ background: 'rgba(244,67,54,0.1)', border: '1px solid rgba(244,67,54,0.25)' }}
          >
            <p className="text-sm font-semibold" style={{ color: 'var(--status-red)' }}>
              {failedDocs.length} document{failedDocs.length !== 1 ? 's' : ''} flagged unreadable — not treated as reviewed
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              Affected scope is priced as provisional until these are supplied. See open questions below.
            </p>
          </div>
        )}
      </section>

      {/* ── Site data ────────────────────────────────────────────────────── */}
      {hasSiteData(scope.site_data) && (
        <section style={card}>
          <p style={sectionLabel}>Site data</p>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
            <Metric label="Zoning" value={scope.site_data.zoning} />
            <Metric label="Council" value={scope.site_data.council} />
            <Metric label="Site area" value={scope.site_data.site_area_m2 ? `${scope.site_data.site_area_m2} m²` : null} />
            <Metric label="Existing GFA" value={scope.site_data.existing_gfa_m2 ? `${scope.site_data.existing_gfa_m2} m²` : null} />
            <Metric label="Proposed GFA" value={scope.site_data.proposed_gfa_m2 ? `${scope.site_data.proposed_gfa_m2} m²` : null} />
            <Metric label="FSR (proposed)" value={scope.site_data.fsr_proposed} sub={scope.site_data.fsr_allowable ? `${scope.site_data.fsr_allowable} allowable` : null} />
            <Metric label="Site coverage" value={scope.site_data.proposed_site_coverage} />
            <Metric label="Storeys" value={scope.site_data.storeys} />
            <Metric label="Building height" value={scope.site_data.building_height} />
            <Metric label="Soil / notations" value={scope.site_data.soil_notations} wide />
          </div>
        </section>
      )}

      {/* ── Scope summary ────────────────────────────────────────────────── */}
      {scope.scope_summary.length > 0 && (
        <section style={card}>
          <p style={sectionLabel}>Scope summary</p>
          <Bullets items={scope.scope_summary} />
        </section>
      )}

      {/* ── Room scope ───────────────────────────────────────────────────── */}
      {scope.room_scope.length > 0 && (
        <section style={card}>
          <p style={sectionLabel}>Room-by-room scope</p>
          <div className="grid gap-1.5">
            {scope.room_scope.map((r, i) => (
              <div key={i} className="flex items-start gap-3 rounded-lg px-3 py-2" style={{ background: 'var(--bg-elevated)' }}>
                <span
                  className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase flex-shrink-0 mt-0.5"
                  style={dispositionStyle[r.disposition] ?? dispositionStyle.new}
                >
                  {r.disposition}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                    <span style={{ color: 'var(--text-tertiary)' }}>{r.level} · </span>
                    {r.space}
                  </p>
                  {r.notes && <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{r.notes}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Specialty inclusions ─────────────────────────────────────────── */}
      {scope.specialty_inclusions.length > 0 && (
        <section style={card}>
          <p style={sectionLabel}>Specialty inclusions (own trade / provisional sum)</p>
          <div className="grid gap-2">
            {scope.specialty_inclusions.map((s, i) => (
              <div key={i} className="rounded-lg px-3.5 py-2.5" style={{ background: 'var(--bg-elevated)' }}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{s.item}</p>
                  {s.source_ref && <SourceRef value={s.source_ref} />}
                </div>
                <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{s.rationale}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Date mismatches ──────────────────────────────────────────────── */}
      {scope.date_mismatches.length > 0 && (
        <section style={{ ...card, background: 'rgba(255,152,0,0.06)', border: '1px solid rgba(255,152,0,0.25)' }}>
          <p style={{ ...sectionLabel, color: 'var(--status-amber)' }}>Reconciliation risks</p>
          <Bullets items={scope.date_mismatches} accent="var(--status-amber)" />
        </section>
      )}

      {/* ── Complexity evidence ──────────────────────────────────────────── */}
      {scope.complexity_justification.length > 0 && (
        <section style={card}>
          <div className="flex items-center gap-2 mb-3">
            <p style={{ ...sectionLabel, marginBottom: 0 }}>Why {scope.complexity_rating.toLowerCase()} complexity</p>
          </div>
          <Bullets items={scope.complexity_justification} />
        </section>
      )}

      {/* ── Trade list ───────────────────────────────────────────────────── */}
      {scope.trade_list.length > 0 && (
        <section style={card}>
          <p style={sectionLabel}>Trades & cost sections ({scope.trade_list.length})</p>
          <div className="grid gap-1.5">
            {scope.trade_list.map((t, i) => (
              <div key={i} className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-elevated)' }}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t.trade}</p>
                  {t.source_ref && <SourceRef value={t.source_ref} />}
                </div>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t.reason}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Assumptions / risks / exclusions ─────────────────────────────── */}
      {(scope.assumptions.length > 0 || scope.risks.length > 0 || scope.exclusions.length > 0) && (
        <section style={card}>
          {scope.risks.length > 0 && (
            <div className="mb-4">
              <p style={{ ...sectionLabel, color: 'var(--status-red)' }}>Risks / gaps</p>
              <Bullets items={scope.risks} accent="var(--status-red)" />
            </div>
          )}
          {scope.assumptions.length > 0 && (
            <div className="mb-4">
              <p style={sectionLabel}>Assumptions</p>
              <Bullets items={scope.assumptions} />
            </div>
          )}
          {scope.exclusions.length > 0 && (
            <div>
              <p style={sectionLabel}>Exclusions</p>
              <Bullets items={scope.exclusions} accent="var(--text-tertiary)" />
            </div>
          )}
        </section>
      )}

      {/* ── Open questions ───────────────────────────────────────────────── */}
      {showOpenQuestions && open_questions.length > 0 && <OpenQuestions questions={open_questions} />}
    </div>
  )
}

// ── sub-components ───────────────────────────────────────────────────────────

// key is accepted explicitly — @types/react isn't installed in the type-check
// env, so `key` isn't recognised as a reserved prop on custom components.
function DocumentRow({ doc }: { doc: ClassifiedDocument; key?: React.Key }) {
  const failed = doc.extraction_status === 'failed'
  return (
    <div
      className="rounded-lg px-3.5 py-3"
      style={{
        background: 'var(--bg-elevated)',
        border: failed ? '1px solid rgba(244,67,54,0.3)' : '1px solid transparent',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{doc.filename}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{DOCUMENT_CATEGORY_LABEL[doc.category]}</span>
            <span className="text-xs" style={{ color: 'var(--text-ghost)' }}>·</span>
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{ISSUE_STATUS_LABEL[doc.issue_status]}</span>
            {doc.author && (
              <>
                <span className="text-xs" style={{ color: 'var(--text-ghost)' }}>·</span>
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{doc.author}</span>
              </>
            )}
            {doc.document_date && (
              <>
                <span className="text-xs" style={{ color: 'var(--text-ghost)' }}>·</span>
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{doc.document_date}</span>
              </>
            )}
          </div>
        </div>
        <span className="flex-shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full" style={extractionStyle(doc.extraction_status)}>
          {EXTRACTION_LABEL[doc.extraction_status]}
        </span>
      </div>
      <p className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>{doc.content_summary}</p>
      {doc.unreadable_reason && (
        <p className="text-xs mt-1.5" style={{ color: failed ? 'var(--status-red)' : 'var(--status-amber)', lineHeight: 1.45 }}>
          {doc.unreadable_reason}
        </p>
      )}
    </div>
  )
}

function OpenQuestions({ questions }: { questions: ProjectAssessment['open_questions'] }) {
  const groups: OpenQuestionGroup[] = ['missing_documents', 'drawing_annotations', 'unselected_finishes', 'commercial', 'output']
  return (
    <section style={card}>
      <p style={sectionLabel}>Essential open questions before pricing ({questions.length})</p>
      <div className="grid gap-4">
        {groups.map((g) => {
          const inGroup = questions.filter((q) => q.group === g)
          if (inGroup.length === 0) return null
          return (
            <div key={g}>
              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                {OPEN_QUESTION_GROUP_LABEL[g]}
              </p>
              <div className="grid gap-1.5">
                {inGroup.map((q, i) => (
                  <div key={i} className="flex items-start gap-2.5 rounded-lg px-3 py-2" style={{ background: 'var(--bg-elevated)' }}>
                    <span style={{ flexShrink: 0, width: 5, height: 5, borderRadius: 99, background: 'var(--status-blue)', marginTop: 7 }} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm" style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>{q.question}</p>
                      {q.source_reference && <SourceRef value={q.source_reference} className="mt-1" />}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Metric({ label, value, sub, wide }: { label: string; value: string | null; sub?: string | null; wide?: boolean }) {
  if (!value) return null
  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--bg-elevated)', gridColumn: wide ? '1 / -1' : undefined }}>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{label}</p>
      <p className="text-sm font-semibold mt-0.5" style={{ color: 'var(--text-primary)' }}>{value}</p>
      {sub && <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{sub}</p>}
    </div>
  )
}

function SourceRef({ value, className }: { value: string; className?: string }) {
  return (
    <span
      className={`inline-block text-[10px] px-1.5 py-0.5 rounded ${className ?? ''}`}
      style={{ background: 'rgba(33,150,243,0.08)', color: 'var(--status-blue)', border: '0.5px solid rgba(33,150,243,0.2)' }}
    >
      {value}
    </span>
  )
}

function hasSiteData(s: ProjectAssessment['scope']['site_data']): boolean {
  return Object.values(s).some((v) => v !== null && v !== undefined && v !== '')
}
