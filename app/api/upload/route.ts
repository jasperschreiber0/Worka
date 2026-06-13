import { NextRequest, NextResponse } from 'next/server'
import type { File as DBFile, FileType, FileIntakeStatus } from '@/lib/types/database.types'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

export const maxDuration = 60

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 52428800 // 50 MB

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectFileType(filename: string): FileType {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'].includes(ext)) return 'image'
  if (ext === 'dwg') return 'dwg'
  return 'other'
}

/** Strip directory components and characters unsafe for a storage object key. */
function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'upload'
  return base.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 200) || 'upload'
}

function uniqueStoragePath(builderId: string, jobId: string, filename: string): string {
  const uid = crypto.randomUUID().slice(0, 8)
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : ''
  const base = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename
  return `${builderId}/${jobId}/${base}-${uid}${ext}`
}

// ─── POST /api/upload ─────────────────────────────────────────────────────────
//
// Accepts small JSON { job_id, builder_id, filename, content_type, size }.
// NO file bytes — the browser uploads directly to Supabase Storage via the
// signed URL returned in `upload_url`. This bypasses Vercel's 4.5 MB body limit.
//
// Flow:
//   1. POST /api/upload → creates DB record, returns { file, upload_url }
//   2. Browser PUTs file bytes to upload_url (direct to Supabase Storage)
//   3. Browser GETs /api/intake/[fileId] → AI extraction reads from storage

export async function POST(req: NextRequest): Promise<NextResponse> {
  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { job_id?: string; filename?: string; content_type?: string; size?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { job_id, content_type, size } = body
  const filename = body.filename ? sanitizeFilename(body.filename) : undefined

  if (!job_id) return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
  if (!filename) return NextResponse.json({ error: 'filename is required' }, { status: 400 })

  if (size && size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'File exceeds maximum size of 50 MB' }, { status: 422 })
  }

  const mimeType = content_type || 'application/octet-stream'
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey)

  if (isSupabaseConfigured) {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const supabase = createClient(supabaseUrl!, supabaseKey!)

      // Ensure builder row exists for users who signed up before the trigger was applied
      await supabase.from('builders').upsert(
        { id: builder_id, email: '', name: builder_id },
        { onConflict: 'id', ignoreDuplicates: true }
      )

      // The job must belong to the authenticated builder
      const { data: ownedJob } = await supabase
        .from('jobs')
        .select('id')
        .eq('id', job_id)
        .eq('builder_id', builder_id)
        .single()
      if (!ownedJob) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 })
      }

      const storagePath = uniqueStoragePath(builder_id, job_id, filename)

      // Create signed upload URL first — if storage isn't set up this will error
      const { data: signData, error: signError } = await supabase.storage
        .from('plans')
        .createSignedUploadUrl(storagePath)

      if (signError || !signData?.signedUrl) {
        const msg = signError?.message ?? 'Could not create upload URL'
        console.error('Signed URL error:', msg)
        return NextResponse.json(
          { error: `Storage error: ${msg}. Ensure the "plans" bucket exists in Supabase Storage.` },
          { status: 500 }
        )
      }

      // Insert DB record
      const { data: fileRow, error: dbError } = await supabase
        .from('files')
        .insert({
          job_id,
          quote_id: null,
          builder_id,
          storage_path: storagePath,
          filename,
          file_type: detectFileType(filename),
          intake_status: 'uploaded' as FileIntakeStatus,
        })
        .select()
        .single()

      if (dbError || !fileRow) {
        const msg = (dbError as { message?: string } | null)?.message ?? 'unknown'
        console.error('DB insert error:', msg)
        return NextResponse.json({ error: `Database error: ${msg}` }, { status: 500 })
      }

      return NextResponse.json(
        { file: fileRow as DBFile, upload_url: signData.signedUrl, content_type: mimeType },
        { status: 201 }
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Upload error:', msg)
      return NextResponse.json({ error: `Upload failed: ${msg}` }, { status: 500 })
    }
  }

  // ── Demo mode ─────────────────────────────────────────────────────────────
  const demoFile: DBFile = {
    id: crypto.randomUUID(),
    job_id,
    quote_id: null,
    builder_id,
    storage_path: `demo/${builder_id}/${job_id}/${filename}`,
    filename,
    file_type: detectFileType(filename),
    intake_status: 'uploaded' as FileIntakeStatus,
    failure_stage: null,
    failure_reason: null,
    extracted_text_length: null,
    page_count: null,
    line_item_count: null,
    processing_time_ms: null,
    created_at: new Date().toISOString(),
  }

  return NextResponse.json({ file: demoFile, upload_url: 'demo://skip' }, { status: 201 })
}
