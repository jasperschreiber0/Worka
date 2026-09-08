import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

export async function GET(_request: NextRequest, { params }: { params: { jobId: string; fileId: string } }) {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'Sample files cannot be downloaded.' }, { status: 404 })
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: job, error: jobError } = await sb.from('jobs').select('id').eq('id', params.jobId).eq('builder_id', builderId).maybeSingle()
  if (jobError || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  const { data: file, error: fileError } = await sb.from('files').select('storage_path, filename').eq('id', params.fileId).eq('job_id', params.jobId).maybeSingle()
  if (fileError || !file?.storage_path) return NextResponse.json({ error: 'File not found' }, { status: 404 })
  const { data, error } = await sb.storage.from('plans').createSignedUrl(file.storage_path, 60, { download: file.filename })
  if (error || !data) return NextResponse.json({ error: 'Could not open this file. Please try again.' }, { status: 502 })
  const response = NextResponse.redirect(data.signedUrl)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
