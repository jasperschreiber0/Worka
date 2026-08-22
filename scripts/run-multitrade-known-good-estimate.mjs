#!/usr/bin/env node
// ============================================================
// WorkA — production-shaped MULTI-TRADE known-good estimate, driven
// through the ACTUAL app route
// ============================================================
// Purpose-built to exercise the Stage 6 per-trade chunking fix
// (migration 090, supabase/functions/smooth-responder/index.ts +
// pipeline-logic.ts's planStage6Chunks) end to end against the real,
// deployed pipeline — NOT the tiny single-bathroom brief
// scripts/run-known-good-estimate.mjs uses (that brief scopes too few
// trades to ever need more than one Stage 6 chunk). This brief is a
// full single-storey renovation/extension deliberately written to touch
// all 13 trade categories, so Stage 3 realistically scopes far more
// than STAGE6_MAX_TRADES_PER_CHUNK (3) trades and Stage 6 MUST chunk.
//
// Same harness as run-known-good-estimate.mjs (real /api/intake SSE
// route, real reconnect handling, real recovery-cron nudge on a clean
// stream end) with one addition: a background poller samples
// document_processing_batches.stage6_completed_trade_ids every few
// seconds for the whole run and records every value it sees (with a
// timestamp), giving direct DB evidence that the checkpoint grew
// incrementally across multiple Stage 6 chunks/invocations rather than
// jumping straight from empty to complete in one write.
//
// Cleanup is OFF by default (AUTO_CLEANUP=true to enable) — this run
// exists specifically to be inspected afterward.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
const CRON_SECRET = process.env.CRON_SECRET
const AUTO_CLEANUP = process.env.AUTO_CLEANUP === 'true'
const OVERALL_TIMEOUT_MS = 900_000 // 15 min — a 13-trade Stage 6 chunk plan needs more invocations/time than the bathroom brief

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must all be set' }))
  process.exit(1)
}

const BUILDER_ID = '00000000-0000-0000-0000-0000000000fd' // distinct from the other known-good/health-check scripts' reserved ids

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

// A realistic, large single-storey renovation + rear extension brief —
// deliberately written to require real scope across every one of the 13
// trade categories (Site Works & Concrete, Framing, Roofing, External
// Cladding, Insulation, Internal Linings, Fit-out Carpentry, Cabinetry,
// Paint, Flooring, Fixtures & Tapware, Electrical, Preliminaries), the
// shape of brief a real builder would actually upload for a full reno —
// not a synthetic stress test with no real content behind it.
const BRIEF_TEXT = [
  'RENOVATION + REAR EXTENSION SCOPE',
  '42 Kooyong Road, Armadale VIC 3143',
  '',
  'Existing single-storey brick veneer dwelling, built ~1962, 3 bedrooms.',
  'Full renovation of the existing house PLUS a new single-storey rear',
  'extension adding a open-plan kitchen/living/dining area and a new',
  'laundry. Total existing floor area 118m2, new extension 42m2 (total',
  '160m2 post-works). Standard residential footings/slab, no structural',
  'steel beyond a single 4.2m steel lintel over the new opening to the',
  'existing house. Ceiling height 2.55m throughout, new and existing.',
  '',
  'SCOPE OF WORKS BY TRADE:',
  '',
  '1. SITE WORKS & CONCRETE: demolish existing rear lean-to (18m2) and',
  '   remove from site. Excavate and pour new 42m2 waffle-pod slab for the',
  '   extension per engineer\'s design (allow standard residential class M',
  '   site classification). New 900mm wide concrete path along the new',
  '   extension\'s east side, 12 lineal metres.',
  '',
  '2. FRAMING: new pine frame to extension walls and roof — 90x45 studs at',
  '   450mm centres, 90x45 top/bottom plates. New roof trusses to extension',
  '   (engineer-designed, 6 degree pitch to match existing). One new 4.2m',
  '   steel lintel (150UB) over the new opening between existing house and',
  '   extension, supplied and installed.',
  '',
  '3. ROOFING: new Colorbond corrugated roof sheeting to extension roof',
  '   (42m2), matching existing profile and colour (Colorbond "Woodland',
  '   Grey"). New box gutters and downpipes to extension, tie into existing',
  '   stormwater. New roof insulation blanket (Anticon 55mm) under all new',
  '   roof sheeting.',
  '',
  '4. EXTERNAL CLADDING: new James Hardie Linea weatherboard cladding to',
  '   all new extension external walls (approx. 58m2 wall area), painted',
  '   finish, to match existing brick veneer as closely as practical at the',
  '   junction. New aluminium-framed sliding doors (2.4m x 2.1m) to the',
  '   new living area opening onto the rear yard, and 3 new aluminium',
  '   awning windows (1.2m x 1.0m each) to the new kitchen/laundry.',
  '',
  '5. INSULATION: R2.5 wall batts to all new extension external walls.',
  'R4.0 ceiling batts to extension ceiling. Existing house ceiling',
  '   insulation topped up to R4.0 equivalent where currently under R2.0',
  '   (approx. 60m2 of the existing 118m2 ceiling area).',
  '',
  '6. INTERNAL LININGS: 10mm plasterboard to all new extension walls and',
  '   ceilings, set and sanded ready for paint. 6mm villaboard to new',
  '   laundry wet wall. Make good all existing walls disturbed by the new',
  '   opening between house and extension (approx. 8 lineal metres).',
  '',
  '7. FIT-OUT CARPENTRY: new skirting boards and architraves throughout the',
  '   extension, matching existing profile (mid-range MDF, painted). New',
  '   internal door to the new laundry (820mm, hollow-core, painted). Built',
  '   -in linen cupboard in the extension hallway (1200mm wide, 3 shelves).',
  '',
  '8. CABINETRY: new kitchen — 4.2m of base cabinetry and 3.0m of overhead',
  '   cabinetry, laminate finish, with 40mm reconstituted stone benchtop',
  '   (island bench 2.4m x 1.0m plus 3.0m of run benchtop). New laundry',
  '   cabinetry — 1.8m base cabinetry with laminate benchtop and single',
  '   trough sink.',
  '',
  '9. PAINT: full internal paint to the entire extension (walls and',
  '   ceilings, 2 coats over sealer, low-sheen acrylic, neutral colour) —',
  '   approx. 42m2 floor area / 140m2 wall+ceiling area. External paint to',
  '   new weatherboard cladding (2 coats over primer). Repaint the existing',
  '   hallway and living areas disturbed by the new opening (approx. 25m2',
  '   wall area).',
  '',
  '10. FLOORING: engineered oak floating floorboards throughout the new',
  '    extension living/kitchen area (32m2), matching the existing house\'s',
  '    timber floors as closely as practical. Waterproof vinyl plank',
  '    flooring to the new laundry (6m2).',
  '',
  '11. FIXTURES & TAPWARE: new laundry trough and mixer tap. New kitchen',
  '    sink (undermount, double bowl) and matte black kitchen mixer with',
  '    pull-out spray. New rangehood (900mm, ducted to external wall).',
  '',
  '12. ELECTRICAL: full new electrical fitout to the extension — 14 LED',
  '    downlights, 8 double GPOs, 2 weatherproof external GPOs, new circuit',
  '    to a new 900mm electric cooktop and separate wall oven, new exhaust',
  '    fan (ducted) to the laundry, and 2 new external sensor lights. Tie',
  '    new circuits into the existing switchboard (no switchboard upgrade',
  '    required per the electrician\'s assessment — existing board has',
  '    spare capacity).',
  '',
  '13. PRELIMINARIES: site fencing and temporary site toilet for the',
  '    duration of works (estimate 14 weeks), skip bin hire (3 x 6m3 bins',
  '    across the job), and a temporary weatherproof enclosure over the new',
  '    opening between house and extension for the duration of structural',
  '    works.',
  '',
  'EXCLUSIONS: no upstairs/second storey, no swimming pool or landscaping',
  'beyond the new concrete path, no solar/battery system, no underpinning',
  'or unusual soil conditions assumed (standard class M).',
  '',
  'Finish level: mid-range, contemporary. Client wants the extension to',
  'feel like a natural continuation of the existing house, not a visibly',
  'bolted-on addition, but is not seeking a premium/architect-designed',
  'spec.',
].join('\n')

function buildSyntheticPdf(text) {
  // Same minimal single-column PDF builder as run-known-good-estimate.mjs
  // — wraps to a new page every ~52 lines (a 792pt-tall A4-ish page at
  // 11pt/14pt leading fits about that many lines before running off the
  // bottom margin), since this brief is much longer than the bathroom one.
  const LINES_PER_PAGE = 52
  const allLines = text.split('\n')
  const pages = []
  for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) pages.push(allLines.slice(i, i + LINES_PER_PAGE))

  const objects = []
  let nextObjNum = 1
  const catalogNum = nextObjNum++
  const pagesNum = nextObjNum++
  const fontNum = nextObjNum++
  const pageObjNums = []
  const contentObjNums = []
  for (const pageLines of pages) {
    const pageContentText = pageLines
      .map((line, i) => {
        const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
        return i === 0 ? `BT /F1 11 Tf 50 780 Td (${escaped}) Tj` : `0 -14 Td (${escaped}) Tj`
      })
      .join('\n') + ' ET'
    const pageNum = nextObjNum++
    const contentNum = nextObjNum++
    pageObjNums.push(pageNum)
    contentObjNums.push(contentNum)
    objects[pageNum] = `<< /Type /Page /Parent ${pagesNum} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R >>`
    objects[contentNum] = `<< /Length ${Buffer.byteLength(pageContentText, 'utf8')} >>\nstream\n${pageContentText}\nendstream`
  }
  objects[catalogNum] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`
  objects[pagesNum] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjNums.length} >>`
  objects[fontNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  const totalObjs = nextObjNum - 1
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i <= totalObjs; i++) {
    offsets[i] = Buffer.byteLength(body, 'utf8')
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(body, 'utf8')
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= totalObjs; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  const trailer = `trailer\n<< /Size ${totalObjs + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(body + xref + trailer, 'utf8')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()
  const runTag = new Date().toISOString()
  const storagePath = `known-good-estimate/${jobId}/extension-reno-brief.pdf`
  const result = { passed: false, job_id: jobId }

  // ── Background Stage 6 checkpoint poller ──────────────────────────────
  // Direct DB evidence that stage6_completed_trade_ids grew incrementally
  // (chunk 1 -> checkpoint -> chunk 2 -> checkpoint -> ...) rather than
  // jumping from empty straight to fully complete. Records every DISTINCT
  // value seen, with a timestamp and the batch's stall_stage/stall_reason
  // at that moment (so a wall-clock deferral between chunks is visible
  // too, not just eventual completion).
  const stage6CheckpointHistory = []
  let lastSeenCompletedIds = null
  let pollerBatchId = null
  const pollStage6Checkpoint = async () => {
    try {
      const { data: batchRow } = await supabase
        .from('document_processing_batches')
        .select('id, stage6_completed_trade_ids, stall_stage, stall_reason, stalled_at, status, quote_id, scope_reasoning_completed_at')
        .eq('job_id', jobId)
        .maybeSingle()
      if (!batchRow) return
      pollerBatchId = batchRow.id
      const idsKey = JSON.stringify((batchRow.stage6_completed_trade_ids ?? []).slice().sort((a, b) => a - b))
      if (idsKey !== lastSeenCompletedIds) {
        lastSeenCompletedIds = idsKey
        const snapshot = {
          sampled_at: new Date().toISOString(),
          stage6_completed_trade_ids: batchRow.stage6_completed_trade_ids ?? [],
          count: (batchRow.stage6_completed_trade_ids ?? []).length,
          stall_stage: batchRow.stall_stage, stall_reason: batchRow.stall_reason, stalled_at: batchRow.stalled_at,
          batch_status: batchRow.status, quote_id: batchRow.quote_id,
        }
        stage6CheckpointHistory.push(snapshot)
        log('stage6_checkpoint_changed', snapshot)
      }
    } catch (pollErr) {
      log('stage6_checkpoint_poll_failed', { error: pollErr instanceof Error ? pollErr.message : String(pollErr) })
    }
  }
  const pollerInterval = setInterval(pollStage6Checkpoint, 4_000)

  try {
    log('run_started', { job_id: jobId, brief_length_chars: BRIEF_TEXT.length })

    await supabase.from('builders').upsert(
      { id: BUILDER_ID, email: 'multitrade-known-good-check@getworka.com', name: 'Multi-Trade Known-Good Estimate Check' },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    const { error: jobErr } = await supabase.from('jobs').insert({
      id: jobId,
      builder_id: BUILDER_ID,
      address: `MULTI-TRADE CHECK — 42 Kooyong Road, Armadale VIC (${runTag}), safe to delete`,
      status: 'quoting',
      job_type: 'health_check',
    })
    if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)

    const pdfBuffer = buildSyntheticPdf(BRIEF_TEXT)
    const { error: uploadErr } = await supabase.storage.from('plans').upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
    if (uploadErr) throw new Error(`storage upload failed: ${uploadErr.message}`)

    const { data: fileRow, error: fileErr } = await supabase
      .from('files')
      .insert({
        job_id: jobId, builder_id: BUILDER_ID, storage_path: storagePath,
        filename: 'extension-reno-brief.pdf', file_type: 'pdf', intake_status: 'uploaded',
      })
      .select()
      .single()
    if (fileErr || !fileRow) throw new Error(`files insert failed: ${fileErr?.message ?? 'no row returned'}`)
    log('file_created', { job_id: jobId, file_id: fileRow.id })

    const overallDeadline = Date.now() + OVERALL_TIMEOUT_MS
    const startedAtMs = Date.now()
    let lastProgressAtMs = startedAtMs
    let finalEvent = null
    let connectionCount = 0

    while (!finalEvent && Date.now() < overallDeadline) {
      connectionCount++
      const intakeUrl = `${APP_URL.replace(/\/$/, '')}/api/intake/${fileRow.id}?job_id=${jobId}&started_at=${startedAtMs}&last_progress_at=${lastProgressAtMs}`
      log('intake_route_call_started', { job_id: jobId, url: intakeUrl, connection: connectionCount })

      const controller = new AbortController()
      const remainingMs = overallDeadline - Date.now()
      const timer = setTimeout(() => controller.abort(), remainingMs)
      let streamEndedCleanly = false
      try {
        const res = await fetch(intakeUrl, {
          headers: {
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            'x-worka-builder-id': BUILDER_ID,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          const bodyText = await res.text().catch(() => '')
          throw new Error(`intake route returned HTTP ${res.status}: ${bodyText.slice(0, 1000)}`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let currentEvent = null
        while (true) {
          const { done, value } = await reader.read()
          if (done) { streamEndedCleanly = true; break }
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice('event: '.length).trim()
            } else if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice('data: '.length))
              log('sse_event', { job_id: jobId, event: currentEvent, data })
              if (currentEvent === 'progress' || currentEvent === 'document_progress') {
                lastProgressAtMs = Date.now()
              }
              if (currentEvent === 'complete' || currentEvent === 'needs_clarification' || currentEvent === 'error') {
                finalEvent = { event: currentEvent, data }
              }
            }
          }
          if (finalEvent) break
        }
        reader.cancel().catch(() => {})
      } finally {
        clearTimeout(timer)
      }

      if (!finalEvent && streamEndedCleanly) {
        if (CRON_SECRET) {
          try {
            const recRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/cron/intake-recovery`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } })
            const recBody = await recRes.text().catch(() => '')
            log('recovery_triggered', { job_id: jobId, http_status: recRes.status, body: recBody.slice(0, 2000) })
          } catch (recErr) {
            log('recovery_trigger_failed', { job_id: jobId, error: recErr instanceof Error ? recErr.message : String(recErr) })
          }
        }
        log('reconnecting', { job_id: jobId, connection: connectionCount })
        await sleep(3_000)
      }
    }

    if (!finalEvent) throw new Error(`SSE stream never reached a terminal event within ${OVERALL_TIMEOUT_MS}ms across ${connectionCount} connection(s)`)
    result.final_event = finalEvent

    if (finalEvent.event !== 'complete') {
      log('run_did_not_complete', { job_id: jobId, final_event: finalEvent })
      result.passed = finalEvent.event === 'needs_clarification'
    } else {
      const quoteId = finalEvent.data.quote_id
      await sleep(15_000)

      const { data: quote, error: quoteErr } = await supabase
        .from('quotes')
        .select('id, status, total_cost, margin_pct, overall_confidence, qa_report, document_contribution')
        .eq('id', quoteId)
        .single()
      if (quoteErr || !quote) throw new Error(`quote fetch failed: ${quoteErr?.message ?? 'no row'}`)

      const { data: lineItems, error: liErr } = await supabase
        .from('quote_line_items')
        .select('trade_category_id, description, quantity, unit, rate, total, margin_pct, pricing_type, confidence, manual_input_required, assumption_status')
        .eq('quote_id', quoteId)
        .order('trade_category_id', { ascending: true })
      if (liErr) throw new Error(`line items fetch failed: ${liErr.message}`)

      const items = lineItems ?? []
      const priced = items.filter((i) => i.rate !== null || i.pricing_type === 'provisional_sum')
      const tradesCovered = Array.from(new Set(items.map((i) => i.trade_category_id))).sort((a, b) => a - b)
      const clientPrice = items.reduce((sum, i) => (i.total === null ? sum : sum + i.total * (1 + (i.margin_pct ?? 0))), 0)

      result.passed = true
      result.quote = {
        quote_id: quoteId, status: quote.status, total_cost: quote.total_cost,
        margin_pct: quote.margin_pct, overall_confidence: quote.overall_confidence,
        has_qa_report: quote.qa_report !== null, qa_report: quote.qa_report,
        document_contribution: quote.document_contribution,
        line_item_count: items.length, priced_line_item_count: priced.length,
        trade_categories_covered: tradesCovered,
        computed_client_price_ex_gst: Math.round(clientPrice * 100) / 100,
        line_items: items,
      }
      log('estimate_result', result.quote)
    }

    log('run_passed', { job_id: jobId, passed: result.passed })
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    log('run_failed', result)
  } finally {
    clearInterval(pollerInterval)
    // One last poll after the run ends, in case the final chunk's
    // checkpoint write landed after the last periodic sample.
    await pollStage6Checkpoint()
    result.stage6_checkpoint_history = stage6CheckpointHistory
    result.batch_id = pollerBatchId

    try {
      const { data: batchRow } = await supabase
        .from('document_processing_batches')
        .select('id, status, stall_stage, stall_reason, stalled_at, stall_count, total_ai_call_attempts, classification_triggered, quote_id, scope_reasoning_completed_at, stage6_completed_trade_ids, stage3_completed_trade_ids')
        .eq('job_id', jobId)
        .maybeSingle()
      if (batchRow) {
        result.batch_id = batchRow.id
        log('diagnostic_batch_state', { job_id: jobId, batch: batchRow })
      }
    } catch (diagErr) {
      log('diagnostic_batch_state_failed', { job_id: jobId, error: diagErr instanceof Error ? diagErr.message : String(diagErr) })
    }

    log('stage6_checkpoint_evidence_summary', {
      job_id: jobId,
      distinct_checkpoint_values_observed: stage6CheckpointHistory.length,
      multi_chunk_evidence: stage6CheckpointHistory.length > 1
        ? 'stage6_completed_trade_ids was observed at more than one distinct value over the run -- direct evidence of incremental, chunk-by-chunk persistence'
        : 'only one (or zero) distinct checkpoint values observed -- either the whole plan fit in a single chunk, polling missed intermediate writes, or chunking did not engage as expected',
      history: stage6CheckpointHistory,
    })

    if (AUTO_CLEANUP && result.passed) {
      try {
        await supabase.from('files').delete().eq('job_id', jobId)
        await supabase.from('jobs').delete().eq('id', jobId)
        await supabase.storage.from('plans').remove([storagePath])
        log('cleanup_complete', { job_id: jobId })
      } catch (cleanupErr) {
        log('cleanup_failed', { job_id: jobId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
      }
    } else {
      log('cleanup_skipped', { job_id: jobId, batch_id: result.batch_id, message: 'AUTO_CLEANUP not set -- job/file/batch/quote rows left in place for inspection; delete manually once done' })
    }
  }

  process.exit(result.passed ? 0 : 1)
}

main()
