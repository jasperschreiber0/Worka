#!/usr/bin/env node
// ============================================================
// WorkA — real known-good estimate, driven through the ACTUAL app route
// ============================================================
// Unlike scripts/synthetic-intake-health-check.mjs (talks to Supabase
// directly, bypassing pricing/QA), this drives the REAL
// GET /api/intake/[fileId] route on the live Next.js app -- the same
// route the browser's IntakeProgress.tsx calls -- so pricing
// (ensureQuotePriced) and QA (runQualityAssurance) actually run, not
// just Stage 6 line-item generation. Authenticates via the documented
// internal server-to-server path (lib/auth/api-auth.ts): Authorization:
// Bearer $SUPABASE_SERVICE_ROLE_KEY + x-worka-builder-id header.
//
// Input: a realistic, boundable small-residential brief (a single-
// bathroom renovation) an experienced estimator or an LLM could
// reasonably ballpark by hand -- not a trivial 3-sentence smoke-test
// document. See BRIEF_TEXT below.
//
// Cleanup: deletes the synthetic job/file/quote in a `finally` block
// regardless of outcome, matching every other script in this directory.
// Full results are printed to stdout BEFORE cleanup runs.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
const OVERALL_TIMEOUT_MS = 600_000 // 10 min safety ceiling for this script

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must all be set' }))
  process.exit(1)
}

const BUILDER_ID = '00000000-0000-0000-0000-0000000000fc' // reserved, distinct from the other two scripts' ids

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

// A realistic, boundable residential brief -- specific dimensions, a
// clear finish level, explicit exclusions -- exactly the shape of input
// an experienced estimator (or ChatGPT/Claude, asked directly) could
// ballpark by hand. Deliberately NOT a trivial one-liner.
const BRIEF_TEXT = [
  'RENOVATION SCOPE — MAIN BATHROOM',
  '138 Wattle Grove, Camberwell VIC 3124',
  '',
  'Existing single-storey brick veneer dwelling, built ~1985. Renovating the',
  'main bathroom only. No structural work, no plumbing relocation (all',
  'fixtures stay in their existing positions), no window changes.',
  '',
  'Room dimensions: 3.2m x 2.1m (6.72m2 floor area), ceiling height 2.4m.',
  '',
  'SCOPE OF WORKS:',
  '1. Full strip-out: remove existing tiles (floor + walls), vanity, toilet,',
  '   bath, shower screen, and exhaust fan. Dispose of all waste.',
  '2. Waterproofing: full waterproof membrane to floor and shower walls to',
  '   1800mm, per AS 3740, with waterproofer\'s certificate on completion.',
  '3. Tiling: new floor tiles (600x600mm porcelain) full room. New wall',
  '   tiles (300x600mm porcelain) full height in shower recess, 1200mm',
  '   elsewhere. Mid-range tile, supplied by builder, allow $65/m2 supply.',
  '4. Fixtures: new freestanding acrylic bath (1500mm). New semi-frameless',
  '   shower screen (900x900mm). New wall-hung vanity (900mm) with stone',
  '   top and under-mount basin. New wall-faced toilet suite.',
  '5. Tapware: new matte black tapware throughout — bath spout + mixer,',
  '   shower mixer + rail, basin mixer. Mid-range brand.',
  '6. Electrical: new ducted exhaust fan (existing ducting reused). Existing',
  '   lighting reused, no changes.',
  '7. Painting: prepare and repaint ceiling only (existing paint, 2 coats).',
  '   Walls fully tiled — no wall painting required.',
  '8. Heated towel rail: new single-bar heated towel rail, matte black.',
  '',
  'EXCLUSIONS: no structural work, no plumbing relocation, no window or',
  'door changes, no underfloor heating, no smart-home fixtures.',
  '',
  'Finish level: mid-range. Client wants a clean, contemporary finish',
  'without going to a premium/architect-designed spec.',
].join('\n')

function buildSyntheticPdf(text) {
  const lines = text.split('\n')
  // Simple single-column text block, 11pt, starting near the top of an
  // A4-ish page, wrapping to a new BT/Td per line — keeps the PDF content
  // stream trivial to hand-construct correctly (byte-accurate xref is the
  // part that actually has to be right for a PDF reader to accept it).
  const contentLines = lines.map((line, i) => {
    const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    return i === 0
      ? `BT /F1 11 Tf 50 780 Td (${escaped}) Tj`
      : `0 -14 Td (${escaped}) Tj`
  })
  const text_ = `${contentLines.join('\n')} ET`

  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objects[5] = `<< /Length ${Buffer.byteLength(text_, 'utf8')} >>\nstream\n${text_}\nendstream`

  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(body, 'utf8')
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(body, 'utf8')
  let xref = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(body + xref + trailer, 'utf8')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()
  const runTag = new Date().toISOString()
  const storagePath = `known-good-estimate/${jobId}/bathroom-reno-brief.pdf`
  const result = { passed: false, job_id: jobId }

  try {
    log('run_started', { job_id: jobId })

    await supabase.from('builders').upsert(
      { id: BUILDER_ID, email: 'known-good-check@getworka.com', name: 'Known-Good Estimate Check' },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    const { error: jobErr } = await supabase.from('jobs').insert({
      id: jobId,
      builder_id: BUILDER_ID,
      address: `KNOWN-GOOD CHECK — 138 Wattle Grove, Camberwell VIC (${runTag}), safe to delete`,
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
        filename: 'bathroom-reno-brief.pdf', file_type: 'pdf', intake_status: 'uploaded',
      })
      .select()
      .single()
    if (fileErr || !fileRow) throw new Error(`files insert failed: ${fileErr?.message ?? 'no row returned'}`)
    log('file_created', { job_id: jobId, file_id: fileRow.id })

    // ── Drive the REAL app route (not Supabase directly) — this is what
    //    actually exercises pricing (ensureQuotePriced) and QA
    //    (runQualityAssurance), which only fire from this route, not from
    //    a direct document-worker/smooth-responder invocation. ──────────
    const intakeUrl = `${APP_URL.replace(/\/$/, '')}/api/intake/${fileRow.id}?job_id=${jobId}`
    log('intake_route_call_started', { job_id: jobId, url: intakeUrl })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OVERALL_TIMEOUT_MS)
    let finalEvent = null
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
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice('event: '.length).trim()
          } else if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice('data: '.length))
            log('sse_event', { job_id: jobId, event: currentEvent, data })
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

    if (!finalEvent) throw new Error('SSE stream ended without a complete/needs_clarification/error event')
    result.final_event = finalEvent

    if (finalEvent.event !== 'complete') {
      log('run_did_not_complete', { job_id: jobId, final_event: finalEvent })
      result.passed = finalEvent.event === 'needs_clarification' // a correctly-recognized gap is not a pipeline failure
    } else {
      const quoteId = finalEvent.data.quote_id
      // Give ensureQuotePriced/runQualityAssurance's own fire-and-forget
      // background work (lib/run-background.ts — real on Railway, a
      // persistent process, not serverless) a short window to finish
      // after the SSE stream itself reports 'complete'.
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
    try {
      await supabase.from('files').delete().eq('job_id', jobId)
      await supabase.from('jobs').delete().eq('id', jobId)
      await supabase.storage.from('plans').remove([storagePath])
      log('cleanup_complete', { job_id: jobId })
    } catch (cleanupErr) {
      log('cleanup_failed', { job_id: jobId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
    }
  }

  process.exit(result.passed ? 0 : 1)
}

main()
