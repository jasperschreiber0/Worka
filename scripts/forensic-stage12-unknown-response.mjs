#!/usr/bin/env node
// ONE-TIME, read-only forensic: recovers the raw persisted Claude response
// (ai_operations.result, populated for scope_key'd calls per ai-gateway.ts)
// for the DA-Mod stage_document_intelligence call that succeeded at the API
// level but produced classification:'unknown' downstream, and compares it
// against a known-good prior stage_document_intelligence call for the same
// job. Zero writes, zero Anthropic calls.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const TARGET_OP_ID = '821048cc-6f6c-4abc-a7c8-9392f484367a'   // this run's DA-Mod call (succeeded, but unknown downstream)
const KNOWN_GOOD_OP_ID = 'a31ebb53-653d-4e50-9bcb-44f55a1b11f0' // 2026-08-22 original successful call
const TARGET_FILE_ID = 'f2b240fb-5be7-4931-b795-4d140c1c7e63'
const JOB_ID = '1f12de7f-47b5-442e-9581-1f813796eb70'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

function summarizeResult(row) {
  if (!row) return null
  const r = row.result
  const summary = {
    op_id: row.id, status: row.status, call_site: row.call_site,
    input_tokens: row.input_tokens, output_tokens: row.output_tokens,
    duration_ms: row.duration_ms, request_id: row.request_id,
    error_classification: row.error_classification, error_message: row.error_message,
    result_present: r != null,
  }
  if (r && typeof r === 'object') {
    summary.result_top_level_keys = Object.keys(r)
    summary.stop_reason = r.stop_reason ?? null
    summary.result_id = r.id ?? null
    summary.result_model = r.model ?? null
    summary.result_usage = r.usage ?? null
    summary.result_role = r.role ?? null
    const content = Array.isArray(r.content) ? r.content : null
    summary.content_is_array = Array.isArray(r.content)
    summary.content_block_count = content?.length ?? null
    summary.content_block_types = content ? content.map((b) => ({ type: b?.type, name: b?.name ?? null })) : null
    if (content) {
      summary.content_blocks_detail = content.map((b) => {
        if (b?.type === 'text') {
          return { type: 'text', text_length: b.text?.length ?? 0, text_preview: (b.text ?? '').slice(0, 800) }
        }
        if (b?.type === 'tool_use') {
          const inputStr = JSON.stringify(b.input ?? {})
          return {
            type: 'tool_use', name: b.name, id: b.id,
            input_keys: b.input && typeof b.input === 'object' ? Object.keys(b.input) : null,
            input_json_length: inputStr.length,
            input_preview: inputStr.slice(0, 1500),
            documents_field_type: Array.isArray(b.input?.documents) ? 'array' : typeof b.input?.documents,
            documents_length: Array.isArray(b.input?.documents) ? b.input.documents.length : null,
            facts_field_type: Array.isArray(b.input?.facts) ? 'array' : typeof b.input?.facts,
            facts_length: Array.isArray(b.input?.facts) ? b.input.facts.length : null,
          }
        }
        return { type: b?.type ?? 'unknown_block_type', raw_keys: b && typeof b === 'object' ? Object.keys(b) : null }
      })
    }
  }
  return summary
}

async function main() {
  const { data: targetOp, error: targetErr } = await supabase
    .from('ai_operations').select('*').eq('id', TARGET_OP_ID).maybeSingle()
  log('target_op_raw_present', { found: !!targetOp, error: targetErr?.message ?? null })
  log('target_op_summary', summarizeResult(targetOp))
  // Full raw result, unsummarized, so nothing is paraphrased away.
  log('target_op_full_result_json', { result: targetOp?.result ?? null })

  const { data: knownGoodOp, error: kgErr } = await supabase
    .from('ai_operations').select('*').eq('id', KNOWN_GOOD_OP_ID).maybeSingle()
  log('known_good_op_summary', summarizeResult(knownGoodOp))
  log('known_good_op_full_result_json', { result: knownGoodOp?.result ?? null })

  const { data: fileRow } = await supabase
    .from('files')
    .select('id, filename, intake_status, intake_stage, intake_pct, ai_failure_classification, ai_failure_count, failure_stage, failure_reason')
    .eq('id', TARGET_FILE_ID).maybeSingle()
  log('target_file_row', fileRow)

  const { data: batchRow } = await supabase
    .from('document_processing_batches')
    .select('*')
    .eq('id', fileRow?.processing_batch_id ?? '00000000-0000-0000-0000-000000000000')
    .maybeSingle()
  log('target_batch_row', batchRow)

  const { data: pdRows } = await supabase.from('project_documents').select('*').eq('job_id', JOB_ID)
  log('project_documents_for_job', { count: pdRows?.length ?? 0, rows: pdRows })

  process.exit(0)
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
