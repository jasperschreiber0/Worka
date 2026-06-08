import { NextRequest, NextResponse } from 'next/server'
import type { File as DBFile, FileType, FileIntakeStatus } from '@/lib/types/database.types'
import { cacheFile } from '@/lib/file-cache'

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
// Accepts JSON { job_id, builder_id, filename, content_type, size?, file_data? }.
// file_data: base64-encoded file bytes — if present, cached in memory so the
// intake pipeline can process without Supabase Storage.
// In real mode: also creates a Supabase Storage presigned URL for persistent storage.
// In demo mode: returns a mock file record with upload_url = 'demo://skip'.

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { job_id?: string; builder_id?: string; filename?: string; content_type?: string; size?: number; file_data?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { job_id, builder_id: rawBuilderId, filename, content_type, size, file_data } = body
  const builder_id = rawBuilderId ?? DEMO_BUILDER_ID

  if (!job_id) return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
  if (!filename) return NextResponse.json({ error: 'filename is required' }, { status: 400 })

  const mimeType = content_type || 'application/octet-stream'

  if (size && size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'File exceeds maximum size of 50 MB' }, { status: 422 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey)

  // ── Real mode: try Supabase, but always succeed via memory cache ──────────
  if (isSupabaseConfigured) {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const supabase = createClient(supabaseUrl!, supabaseKey!)

      // Ensure builder row exists
      await supabase.from('builders').upsert({ id: builder_id }, { onConflict: 'id', ignoreDuplicates: true })

      // Insert file record
      const storagePath = `${builder_id}/${job_id}/${filename}`
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
        const dbMsg = typeof dbError === 'object' && dbError !== null && 'message' in dbError
          ? String((dbError as { message: string }).message)
          : JSON.stringify(dbError)
        console.error('DB insert error:', dbMsg)
        // Fall through to demo mode rather than failing
      } else {
        const dbFile = fileRow as DBFile

        // Cache file bytes in memory so intake works even if storage upload fails
        if (file_data) {
          cacheFile(dbFile.id, file_data, mimeType, filename)
        }

        // Try to get a storage signed URL — non-fatal if it fails
        let signedUrl = 'memory://cached'
        try {
          const { data: signData } = await supabase.storage
            .from('plans')
            .createSignedUploadUrl(storagePath)
          if (signData?.signedUrl) signedUrl = signData.signedUrl
        } catch {
          // Storage not configured — intake will use memory cache
        }

        return NextResponse.json({ file: dbFile, upload_url: signedUrl }, { status: 201 })
      }
    } catch (err) {
      console.error('Upload error:', err)
      // Fall through to demo mode
    }
  }

  // ── Demo / fallback mode: return mock file record ─────────────────────────
  const fileId = crypto.randomUUID()
  const demoFile: DBFile = {
    id: fileId,
    job_id,
    quote_id: null,
    builder_id,
    storage_path: `demo/${builder_id}/${job_id}/${filename}`,
    filename,
    file_type: detectFileType(filename),
    intake_status: 'uploaded' as FileIntakeStatus,
    created_at: new Date().toISOString(),
  }

  // Cache file bytes even in demo mode so intake can process them
  if (file_data) {
    cacheFile(fileId, file_data, mimeType, filename)
  }

  return NextResponse.json({ file: demoFile, upload_url: 'demo://skip' }, { status: 201 })
}
