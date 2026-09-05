#!/usr/bin/env node
// ============================================================
// WorkA — real client document set, driven through the ACTUAL app route
// ============================================================
// One-off validation script (not part of the standing CI suite): uploads a
// REAL set of client documents (paths given via CLIENT_DOC_DIR) to a FRESH
// job under the reserved known-good-check builder id, then drives the real
// GET /api/intake/[fileId] route exactly like scripts/run-known-good-
// estimate.mjs does for its single synthetic PDF -- except this handles N
// files via the route's existing `siblings` query param, so pricing
// (ensureQuotePriced) and QA (runQualityAssurance) run for real, on real
// content. Does NOT touch any existing job -- creates its own job_id.
//
// Cleanup: deletes the job/files/quote/storage objects in a `finally` block
// on success; preserves everything for forensics on failure/timeout, same
// as run-known-good-estimate.mjs.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
const CRON_SECRET = process.env.CRON_SECRET
const CLIENT_DOC_DIR = process.env.CLIENT_DOC_DIR || 'scripts/tmp-client-docs'
const OVERALL_TIMEOUT_MS = 900_000 // 15 min safety ceiling -- multi-document, larger real files

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must all be set' }))
  process.exit(1)
}

const BUILDER_ID = '00000000-0000-0000-0000-0000000000fc' // reserved, same known-good-check builder

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()
  const runTag = new Date().toISOString()
  const result = { passed: false, job_id: jobId }
  let primaryFileId = null
  const uploadedStoragePaths = []

  try {
    log('run_started', { job_id: jobId })

    const localFiles = fs.readdirSync(CLIENT_DOC_DIR)
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .sort()
    if (localFiles.length === 0) throw new Error(`no PDF files found in ${CLIENT_DOC_DIR}`)
    log('local_files_found', { job_id: jobId, count: localFiles.length, files: localFiles })

    await supabase.from('builders').upsert(
      { id: BUILDER_ID, email: 'known-good-check@getworka.com', name: 'Known-Good Estimate Check' },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    const { error: jobErr } = await supabase.from('jobs').insert({
      id: jobId,
      builder_id: BUILDER_ID,
      address: `CLIENT DOC VALIDATION — 16 Alfred Street Woonona (${runTag}), safe to delete`,
      status: 'quoting',
      job_type: 'health_check',
    })
    if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)

    const fileRows = []
    for (const filename of localFiles) {
      const localPath = path.join(CLIENT_DOC_DIR, filename)
      const buffer = fs.readFileSync(localPath)
      const storagePath = `known-good-estimate/${jobId}/${filename}`
      const { error: uploadErr } = await supabase.storage.from('plans').upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true })
      if (uploadErr) throw new Error(`storage upload failed for ${filename}: ${uploadErr.message}`)
      uploadedStoragePaths.push(storagePath)

      const { data: fileRow, error: fileErr } = await supabase
        .from('files')
        .insert({
          job_id: jobId, builder_id: BUILDER_ID, storage_path: storagePath,
          filename, file_type: 'pdf', intake_status: 'uploaded',
        })
        .select()
        .single()
      if (fileErr || !fileRow) throw new Error(`files insert failed for ${filename}: ${fileErr?.message ?? 'no row returned'}`)
      fileRows.push(fileRow)
      log('file_uploaded', { job_id: jobId, file_id: fileRow.id, filename, bytes: buffer.length })
    }

    primaryFileId = fileRows[0].id
    const siblingFileIds = fileRows.slice(1).map((f) => f.id)
    result.file_count = fileRows.length

    // ── Drive the REAL app route (not Supabase directly), with siblings ──
    // See run-known-good-estimate.mjs's own comment for why this exercises
    // pricing/QA and why the reconnect loop below exists (Railway's SSE
    // connection ceiling forces the real browser client to reconnect, and
    // this script replicates that explicitly).
    const overallDeadline = Date.now() + OVERALL_TIMEOUT_MS
    const startedAtMs = Date.now()
    let lastProgressAtMs = startedAtMs
    let finalEvent = null
    let connectionCount = 0

    while (!finalEvent && Date.now() < overallDeadline) {
      connectionCount++
      const siblingsParam = siblingFileIds.length > 0 ? `&siblings=${siblingFileIds.join(',')}` : ''
      const intakeUrl = `${APP_URL.replace(/\/$/, '')}/api/intake/${primaryFileId}?job_id=${jobId}&started_at=${startedAtMs}&last_progress_at=${lastProgressAtMs}${siblingsParam}`
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
      }
      log('estimate_result', result.quote)
    }

    log('run_passed', { job_id: jobId, passed: result.passed })
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    log('run_failed', result)
  } finally {
    try {
      const { data: batchRow } = await supabase
        .from('document_processing_batches')
        .select('id, status, stall_stage, stall_reason, stalled_at, stall_count, total_ai_call_attempts, classification_triggered, quote_id, scope_reasoning_completed_at')
        .eq('job_id', jobId)
        .maybeSingle()
      if (batchRow) {
        result.batch_id = batchRow.id
        log('diagnostic_batch_state', { job_id: jobId, batch: batchRow })
      }
    } catch (diagErr) {
      log('diagnostic_batch_state_failed', { job_id: jobId, error: diagErr instanceof Error ? diagErr.message : String(diagErr) })
    }

    if (result.passed) {
      try {
        await supabase.from('files').delete().eq('job_id', jobId)
        await supabase.from('jobs').delete().eq('id', jobId)
        if (uploadedStoragePaths.length > 0) await supabase.storage.from('plans').remove(uploadedStoragePaths)
        log('cleanup_complete', { job_id: jobId })
      } catch (cleanupErr) {
        log('cleanup_failed', { job_id: jobId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
      }
    } else {
      log('cleanup_skipped_for_forensics', { job_id: jobId, batch_id: result.batch_id, message: 'run did not pass -- job/file/batch/lock rows left in place for inspection; delete manually once done' })
    }
  }

  process.exit(result.passed ? 0 : 1)
}

main()
