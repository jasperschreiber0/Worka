import { NextRequest, NextResponse } from 'next/server'
import type { File as DBFile, FileType, FileIntakeStatus } from '@/lib/types/database.types'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 52428800 // 50MB

const ACCEPTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'application/octet-stream',
])

const DEMO_BUILDER_ID = '00000000-0000-0000-0000-000000000001'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectFileType(filename: string): FileType {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'].includes(ext)) return 'image'
  if (ext === 'dwg') return 'dwg'
  return 'other'
}

function isAcceptedMimeType(mimeType: string): boolean {
  if (ACCEPTED_MIME_TYPES.has(mimeType)) return true
  // Allow image/* broadly
  if (mimeType.startsWith('image/')) return true
  return false
}

// ─── POST /api/upload ─────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  // Extract fields
  const fileEntry = formData.get('file')
  const job_id = formData.get('job_id')?.toString() ?? ''
  const builder_id = formData.get('builder_id')?.toString() ?? DEMO_BUILDER_ID

  if (!fileEntry || typeof fileEntry === 'string') {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  if (!job_id) {
    return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
  }

  const uploadedFile = fileEntry as globalThis.File
  const filename = uploadedFile.name
  const mimeType = uploadedFile.type || 'application/octet-stream'

  // Validate file type
  if (!isAcceptedMimeType(mimeType)) {
    return NextResponse.json(
      { error: `File type not accepted: ${mimeType}` },
      { status: 422 }
    )
  }

  // Validate file size
  if (uploadedFile.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: 'File exceeds maximum size of 50MB' },
      { status: 422 }
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey)

  // ── Real mode: upload to Supabase Storage + insert DB row ─────────────────
  if (isSupabaseConfigured) {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const supabase = createClient(supabaseUrl!, supabaseKey!)

      const storagePath = `${builder_id}/${job_id}/${filename}`

      // Upload file bytes to Storage
      const fileBytes = await uploadedFile.arrayBuffer()
      const { error: storageError } = await supabase.storage
        .from('plans')
        .upload(storagePath, fileBytes, {
          contentType: mimeType,
          upsert: false,
        })

      if (storageError) {
        console.error('Storage upload error:', storageError)
        return NextResponse.json(
          { error: 'Failed to upload file to storage' },
          { status: 500 }
        )
      }

      // Insert file record
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
        console.error('DB insert error:', dbError)
        return NextResponse.json(
          { error: 'Failed to create file record' },
          { status: 500 }
        )
      }

      return NextResponse.json(
        { file: fileRow as DBFile, intake_started: true },
        { status: 201 }
      )
    } catch (err) {
      console.error('Upload error:', err)
      return NextResponse.json(
        { error: 'Upload failed' },
        { status: 500 }
      )
    }
  }

  // ── Demo mode: return mock File record ────────────────────────────────────
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
    { file: demoFile, intake_started: true },
    { status: 201 }
  )
}
