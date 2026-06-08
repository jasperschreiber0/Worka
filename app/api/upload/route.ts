import { NextRequest, NextResponse } from 'next/server'
import type { File as DBFile, FileType, FileIntakeStatus } from '@/lib/types/database.types'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 52428800 // 50 MB

const DEMO_BUILDER_ID = '00000000-0000-0000-0000-000000000001'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectFileType(filename: string): FileType {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'].includes(ext)) return 'image'
  if (ext === 'dwg') return 'dwg'
  return 'other'
}

// ─── POST /api/upload ─────────────────────────────────────────────────────────
//
// Accepts JSON { job_id, builder_id, filename, content_type, size? }.
// In real mode: creates a Supabase Storage presigned upload URL and inserts the
// file DB record, then returns { file, upload_url } so the client can PUT the
// file bytes directly to Supabase Storage — bypassing Vercel's 4.5 MB body limit.
// In demo mode: returns a mock file record with upload_url = 'demo://upload'.

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { job_id?: string; builder_id?: string; filename?: string; content_type?: string; size?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { job_id, builder_id: rawBuilderId, filename, content_type, size } = body
  const builder_id = rawBuilderId ?? DEMO_BUILDER_ID

  if (!job_id) {
    return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
  }
  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 })
  }

  const mimeType = content_type || 'application/octet-stream'

  if (size && size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'File exceeds maximum size of 50 MB' }, { status: 422 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey)

  // ── Real mode: presigned URL + DB record ──────────────────────────────────
  if (isSupabaseConfigured) {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const supabase = createClient(supabaseUrl!, supabaseKey!)

      const storagePath = `${builder_id}/${job_id}/${filename}`

      // Create a presigned upload URL — client will PUT file bytes directly to
      // Supabase Storage, bypassing Vercel's request body size limit.
      const { data: signData, error: signError } = await supabase.storage
        .from('plans')
        .createSignedUploadUrl(storagePath)

      if (signError || !signData) {
        const errMsg = signError?.message ?? 'unknown'
        console.error('Signed URL error:', errMsg, signError)
        return NextResponse.json(
          { error: `Storage error: ${errMsg}. Check that the "plans" bucket exists in Supabase Storage and has upload permissions.` },
          { status: 500 }
        )
      }

      // Ensure builder row exists (no-op if already present — satisfies FK)
      await supabase.from('builders').upsert({ id: builder_id }, { onConflict: 'id', ignoreDuplicates: true })

      // Insert file record (status 'uploaded' — intake triggered after client PUT)
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
        const dbMsg = typeof dbError === 'object' && dbError !== null && 'message' in dbError ? String((dbError as { message: string }).message) : JSON.stringify(dbError)
        console.error('DB insert error:', dbMsg)
        return NextResponse.json({ error: `Database error: ${dbMsg}` }, { status: 500 })
      }

      return NextResponse.json(
        { file: fileRow as DBFile, upload_url: signData.signedUrl },
        { status: 201 }
      )
    } catch (err) {
      console.error('Upload error:', err)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }
  }

  // ── Demo mode: return mock file record, skip real upload ──────────────────
  const demoFile: DBFile = {
    id: crypto.randomUUID(),
    job_id,
    quote_id: null,
    builder_id,
    storage_path: `demo/${builder_id}/${job_id}/${filename}`,
    filename,
    file_type: detectFileType(filename),
    intake_status: 'uploaded' as FileIntakeStatus,
    created_at: new Date().toISOString(),
  }

  return NextResponse.json(
    { file: demoFile, upload_url: 'demo://skip' },
    { status: 201 }
  )
}
