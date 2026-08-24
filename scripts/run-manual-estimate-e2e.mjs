#!/usr/bin/env node
// ============================================================
// WorkA — live end-to-end verification of manual estimate creation,
// driven through the ACTUAL deployed app routes (not direct DB writes)
// ============================================================
// Reviewer-requested follow-up to the manual-estimate-creation milestone
// (POST /api/jobs/[jobId]/estimate, POST /api/quotes/[quoteId]/line-items,
// extended PATCH/new DELETE on .../line-items/[itemId]). Static
// verification (type-check, unit tests) can't prove the actual HTTP/DB
// integration — this script does, against the real production app and
// Supabase project, the same way run-known-good-estimate.mjs already
// verifies the AI pipeline: real fetch() calls to APP_URL, authenticated
// via the documented internal server-to-server path (lib/auth/api-auth.ts)
// -- Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY + x-worka-builder-id.
//
// Covers, in order:
//   1. Create a blank estimate (no document, no AI).
//   2. Add 3 line items across 3 trades.
//   3. Edit one item's quantity + rate; confirm total recomputes.
//   4. Delete one item; confirm total recomputes again.
//   5. Re-fetch fresh (not the same in-memory response) to confirm the
//      state actually persisted to the database, not just an API echo.
//   6. Confirm the job snapshot endpoint (the single shared data source
//      JobSnapshotPanel reads from on the /jobs/[jobId] page, the chat
//      side panel, AND MobileJobSheet -- all three render the same
//      component, confirmed by source inspection, not re-derived here)
//      reflects the manually-created quote.
//   7. Run the real AI estimation pipeline (GET /api/intake/[fileId], the
//      same SSE route the browser calls) against the SAME job.
//   8. Confirm AI did NOT create a second quote for the job -- reused the
//      existing draft quote from step 1.
//   9. Confirm AI added its own line items without deleting the surviving
//      manual ones.
//   10. Edit an AI-added line item through the same manual-edit route,
//       confirm it succeeds and its provenance flips to human -- proving
//       an AI-generated estimate remains fully editable after the fact.
//
// Cleanup: deletes the synthetic job (cascades quotes/quote_line_items/
// files) and the uploaded storage object in a `finally` block regardless
// of outcome. Full results are printed to stdout BEFORE cleanup runs.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
const CRON_SECRET = process.env.CRON_SECRET
const OVERALL_TIMEOUT_MS = 600_000 // 10 min safety ceiling, same budget as run-known-good-estimate.mjs

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must all be set' }))
  process.exit(1)
}

// Reserved, distinct from the other known-good/health-check scripts'
// builder ids (...fc single-bathroom, ...fd multi-trade).
const BUILDER_ID = '00000000-0000-0000-0000-0000000000fe'
const AUTH_HEADERS = { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'x-worka-builder-id': BUILDER_ID }

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A small, real, calibrated brief — same content run-known-good-estimate.mjs
// already validated against the live pipeline, reused here rather than
// invented fresh so this run's AI-side behaviour is a known quantity and
// only the manual/AI interaction is actually being tested.
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
  const contentLines = lines.map((line, i) => {
    const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    return i === 0 ? `BT /F1 11 Tf 50 780 Td (${escaped}) Tj` : `0 -14 Td (${escaped}) Tj`
  })
  const pageContentText = contentLines.join('\n') + ' ET'

  const objects = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(pageContentText, 'utf8')} >>\nstream\n${pageContentText}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(body, 'utf8')
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(body, 'utf8')
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  const trailer = `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(body + xref + trailer, 'utf8')
}

// ── Assertion helper — records pass/fail without throwing, so every step
// still runs and the final report shows exactly which checks failed. ──
const checks = []
function check(name, ok, detail = {}) {
  checks.push({ name, ok, ...detail })
  log(ok ? 'check_passed' : 'check_FAILED', { name, ...detail })
  return ok
}

async function apiFetch(path, options = {}) {
  const url = `${APP_URL.replace(/\/$/, '')}${path}`
  const res = await fetch(url, {
    ...options,
    headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body, keep null */ }
  return { ok: res.ok, status: res.status, json, text }
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()
  const runTag = new Date().toISOString()
  const storagePath = `manual-estimate-e2e/${jobId}/bathroom-brief.pdf`
  const result = { job_id: jobId, passed: false }

  try {
    log('run_started', { job_id: jobId })

    await supabase.from('builders').upsert(
      { id: BUILDER_ID, email: 'manual-estimate-e2e-check@getworka.com', name: 'Manual Estimate E2E Check' },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    const { error: jobErr } = await supabase.from('jobs').insert({
      id: jobId,
      builder_id: BUILDER_ID,
      address: `MANUAL ESTIMATE E2E CHECK — 138 Wattle Grove, Camberwell VIC (${runTag}), safe to delete`,
      status: 'quoting',
      job_type: 'health_check',
    })
    if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)
    log('job_created', { job_id: jobId })

    // ── Step 1: Create a blank estimate — no document, no AI ────────────
    const createRes = await apiFetch(`/api/jobs/${jobId}/estimate`, { method: 'POST' })
    check('create_estimate_ok', createRes.ok && !!createRes.json?.quote_id, { status: createRes.status, body: createRes.json ?? createRes.text })
    const quoteId = createRes.json?.quote_id
    if (!quoteId) throw new Error('no quote_id returned from create-estimate — cannot continue')
    result.quote_id = quoteId

    const idempotentRes = await apiFetch(`/api/jobs/${jobId}/estimate`, { method: 'POST' })
    check('create_estimate_idempotent', idempotentRes.json?.quote_id === quoteId, { second_call_quote_id: idempotentRes.json?.quote_id, original: quoteId })

    const blankGet = await apiFetch(`/api/quotes/${quoteId}`)
    check('blank_quote_has_zero_items', blankGet.ok && blankGet.json?.line_items_by_category?.flatMap((g) => g.items)?.length === 0, { count: blankGet.json?.line_items_by_category?.flatMap((g) => g.items)?.length })
    check('blank_quote_status_draft', blankGet.json?.quote?.status === 'draft', { status: blankGet.json?.quote?.status })

    // ── Step 2: Add 3 line items across 3 trades ─────────────────────────
    const itemsToAdd = [
      { trade_category_id: 2, description: 'New stud wall to garage', quantity: 12, unit: 'lm', rate: 85 },   // Framing — 1020
      { trade_category_id: 12, description: 'Additional double GPO — garage', quantity: 4, unit: 'ea', rate: 180 }, // Electrical — 720
      { trade_category_id: 9, description: 'Repaint garage internal walls', quantity: 28, unit: 'm2', rate: 22 },   // Paint — 616
    ]
    const addedItemIds = {}
    for (const item of itemsToAdd) {
      const addRes = await apiFetch(`/api/quotes/${quoteId}/line-items`, { method: 'POST', body: JSON.stringify(item) })
      const ok = check(`add_item_ok:${item.description}`, addRes.ok && !!addRes.json?.item_id, { status: addRes.status, body: addRes.json ?? addRes.text })
      if (ok) addedItemIds[item.description] = addRes.json.item_id
    }

    const afterAddGet = await apiFetch(`/api/quotes/${quoteId}`)
    const afterAddItems = afterAddGet.json?.line_items_by_category?.flatMap((g) => g.items) ?? []
    check('three_items_present', afterAddItems.length === 3, { count: afterAddItems.length })
    const expectedTotal1 = 1020 + 720 + 616
    check('total_after_add_correct', afterAddGet.json?.summary?.total_cost === expectedTotal1, { expected: expectedTotal1, actual: afterAddGet.json?.summary?.total_cost })

    // Direct DB read — confirms provenance columns actually persisted, not
    // just what the GET route happens to echo back.
    const { data: dbItemsAfterAdd } = await supabase
      .from('quote_line_items')
      .select('id, description, pricing_source, predicted_by, total')
      .eq('quote_id', quoteId)
    check('all_manual_items_tagged_correctly', (dbItemsAfterAdd ?? []).every((i) => i.pricing_source === 'manual' && i.predicted_by === 'human'), { rows: dbItemsAfterAdd })

    // ── Step 3: Edit one item's quantity + rate ──────────────────────────
    const electricalItemId = addedItemIds['Additional double GPO — garage']
    const editRes = await apiFetch(`/api/quotes/${quoteId}/line-items/${electricalItemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity: 6, rate: 195 }),
    })
    check('edit_item_ok', editRes.ok && editRes.json?.action === 'edited', { status: editRes.status, body: editRes.json ?? editRes.text })

    const afterEditGet = await apiFetch(`/api/quotes/${quoteId}`)
    const expectedTotal2 = 1020 + (6 * 195) + 616
    check('total_after_edit_correct', afterEditGet.json?.summary?.total_cost === expectedTotal2, { expected: expectedTotal2, actual: afterEditGet.json?.summary?.total_cost })
    const editedItem = (afterEditGet.json?.line_items_by_category ?? []).flatMap((g) => g.items).find((i) => i.id === electricalItemId)
    check('edited_item_fields_correct', editedItem?.quantity === 6 && editedItem?.rate === 195 && editedItem?.total === 1170, { item: editedItem })

    // ── Step 4: Delete one item ───────────────────────────────────────────
    const paintItemId = addedItemIds['Repaint garage internal walls']
    const deleteRes = await apiFetch(`/api/quotes/${quoteId}/line-items/${paintItemId}`, { method: 'DELETE' })
    check('delete_item_ok', deleteRes.ok && deleteRes.json?.deleted === true, { status: deleteRes.status, body: deleteRes.json ?? deleteRes.text })

    const afterDeleteGet = await apiFetch(`/api/quotes/${quoteId}`)
    const afterDeleteItems = afterDeleteGet.json?.line_items_by_category?.flatMap((g) => g.items) ?? []
    check('two_items_remain', afterDeleteItems.length === 2, { count: afterDeleteItems.length })
    const expectedTotal3 = 1020 + 1170
    check('total_after_delete_correct', afterDeleteGet.json?.summary?.total_cost === expectedTotal3, { expected: expectedTotal3, actual: afterDeleteGet.json?.summary?.total_cost })

    // ── Step 5: Refresh — an independent, later GET must show the same
    // persisted state, not something only true of the prior response. ────
    await sleep(2_000)
    const refreshGet = await apiFetch(`/api/quotes/${quoteId}`)
    const refreshItems = refreshGet.json?.line_items_by_category?.flatMap((g) => g.items) ?? []
    check('persists_across_refresh', refreshItems.length === 2 && refreshGet.json?.summary?.total_cost === expectedTotal3, { count: refreshItems.length, total: refreshGet.json?.summary?.total_cost })

    // ── Step 6: Snapshot endpoint — the single shared data source
    // JobSnapshotPanel reads from on /jobs/[jobId], the chat side panel,
    // and MobileJobSheet (which wraps JobSnapshotPanel directly, confirmed
    // by source inspection — not three separate code paths to test). ─────
    const snapshotRes = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    check('snapshot_reflects_manual_quote', snapshotRes.ok && snapshotRes.json?.snapshot?.quote?.id === quoteId, { status: snapshotRes.status, snapshot_quote_id: snapshotRes.json?.snapshot?.quote?.id })

    // ── Step 7: Run the real AI pipeline against the SAME job ────────────
    const pdfBuffer = buildSyntheticPdf(BRIEF_TEXT)
    const { error: uploadErr } = await supabase.storage.from('plans').upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
    if (uploadErr) throw new Error(`storage upload failed: ${uploadErr.message}`)

    const { data: fileRow, error: fileErr } = await supabase
      .from('files')
      .insert({
        job_id: jobId, builder_id: BUILDER_ID, storage_path: storagePath,
        filename: 'bathroom-brief.pdf', file_type: 'pdf', intake_status: 'uploaded',
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
      log('intake_route_call_started', { job_id: jobId, connection: connectionCount })

      const controller = new AbortController()
      const remainingMs = overallDeadline - Date.now()
      const timer = setTimeout(() => controller.abort(), remainingMs)
      let streamEndedCleanly = false
      try {
        const res = await fetch(intakeUrl, {
          headers: { ...AUTH_HEADERS, Accept: 'text/event-stream' },
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
              if (currentEvent === 'progress' || currentEvent === 'document_progress') lastProgressAtMs = Date.now()
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
            log('recovery_triggered', { job_id: jobId, http_status: recRes.status })
          } catch (recErr) {
            log('recovery_trigger_failed', { job_id: jobId, error: recErr instanceof Error ? recErr.message : String(recErr) })
          }
        }
        log('reconnecting', { job_id: jobId, connection: connectionCount })
        await sleep(3_000)
      }
    }

    check('ai_pipeline_reached_terminal_event', !!finalEvent, { final_event: finalEvent?.event, connections: connectionCount })

    if (finalEvent?.event === 'complete') {
      await sleep(10_000) // let background pricing/QA settle

      // ── Step 8: exactly ONE quote for this job — AI reused the manual one ──
      const { data: allQuotesForJob } = await supabase.from('quotes').select('id, status, total_cost').eq('job_id', jobId)
      check('exactly_one_quote_for_job', (allQuotesForJob ?? []).length === 1, { quotes: allQuotesForJob })
      check('ai_reused_the_manual_quote_id', allQuotesForJob?.[0]?.id === quoteId, { ai_quote_id: allQuotesForJob?.[0]?.id, manual_quote_id: quoteId })

      // ── Step 9: AI added items without deleting the surviving manual ones ──
      const { data: finalLineItems } = await supabase
        .from('quote_line_items')
        .select('id, description, pricing_source, predicted_by')
        .eq('quote_id', quoteId)
      const finalDescriptions = (finalLineItems ?? []).map((i) => i.description)
      check('ai_added_new_items', (finalLineItems ?? []).length > 2, { count: finalLineItems?.length })
      check('manual_stud_wall_item_survived', finalDescriptions.includes('New stud wall to garage'), { descriptions: finalDescriptions })
      check('manual_gpo_item_survived', finalDescriptions.includes('Additional double GPO — garage'), { descriptions: finalDescriptions })

      // ── Step 10: edit an AI-added item through the manual-edit route ────
      const aiAddedItem = (finalLineItems ?? []).find((i) => i.pricing_source !== 'manual' && i.predicted_by !== 'human')
      if (aiAddedItem) {
        result.ai_item_edited = aiAddedItem.description
        const aiEditRes = await apiFetch(`/api/quotes/${quoteId}/line-items/${aiAddedItem.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ description: `${aiAddedItem.description} (manually verified)` }),
        })
        check('ai_generated_item_is_editable', aiEditRes.ok && aiEditRes.json?.action === 'edited', { status: aiEditRes.status, body: aiEditRes.json ?? aiEditRes.text })

        const { data: aiItemAfterEdit } = await supabase.from('quote_line_items').select('predicted_by, description').eq('id', aiAddedItem.id).single()
        check('ai_item_provenance_flips_to_human_after_edit', aiItemAfterEdit?.predicted_by === 'human', { row: aiItemAfterEdit })
      } else {
        check('found_an_ai_added_item_to_edit', false, { note: 'no non-manual item found among final line items — cannot test editing an AI-generated line' })
      }
    } else {
      log('ai_pipeline_did_not_complete', { job_id: jobId, final_event: finalEvent })
    }

    result.checks = checks
    result.passed = checks.every((c) => c.ok)
    log('run_finished', { job_id: jobId, passed: result.passed, checks_total: checks.length, checks_failed: checks.filter((c) => !c.ok).length })
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    result.checks = checks
    result.passed = false
    log('run_failed', { job_id: jobId, error: result.error })
  } finally {
    log('final_result', result)
    try {
      await supabase.from('files').delete().eq('job_id', jobId)
      await supabase.from('jobs').delete().eq('id', jobId) // cascades quotes/quote_line_items
      await supabase.storage.from('plans').remove([storagePath])
      log('cleanup_complete', { job_id: jobId })
    } catch (cleanupErr) {
      log('cleanup_failed', { job_id: jobId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
    }
  }

  process.exit(result.passed ? 0 : 1)
}

main()
