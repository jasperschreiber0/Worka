import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

async function handle(request: NextRequest, jobId: string) {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (isDemoMode()) return request.method === 'GET'
    ? NextResponse.json({ milestones: [], demo: true })
    : NextResponse.json({ error: 'Connect your database to save programme changes.' }, { status: 400 })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'Programme storage is unavailable.' }, { status: 503 })
  const sb = createClient(url, key, { auth: { persistSession: false } })
  const { data: job, error: jobError } = await sb.from('jobs').select('id').eq('id', jobId).eq('builder_id', builderId).maybeSingle()
  if (jobError) return NextResponse.json({ error: 'Could not load job.' }, { status: 503 })
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })
  if (request.method === 'GET') {
    const { data, error } = await sb.from('job_milestones').select('id,title,due_date,completed_at,sort_order').eq('job_id', jobId).eq('builder_id', builderId).order('sort_order').order('created_at')
    return error ? NextResponse.json({ error: 'Could not load milestones.' }, { status: 503 }) : NextResponse.json({ milestones: data })
  }
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  if (request.method === 'PATCH') {
    if (typeof body.id !== 'string' || typeof body.completed !== 'boolean') return NextResponse.json({ error: 'Choose a milestone and status.' }, { status: 400 })
    const { data, error } = await sb.from('job_milestones').update({ completed_at: body.completed ? new Date().toISOString() : null }).eq('id', body.id).eq('job_id', jobId).eq('builder_id', builderId).select('id,title,due_date,completed_at,sort_order').maybeSingle()
    if (error) return NextResponse.json({ error: 'Could not update milestone.' }, { status: 503 })
    return data ? NextResponse.json({ milestone: data }) : NextResponse.json({ error: 'Milestone not found.' }, { status: 404 })
  }
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) return NextResponse.json({ error: 'Enter a milestone title of up to 200 characters.' }, { status: 400 })
  if (body.due_date && (typeof body.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date) || Number.isNaN(Date.parse(body.due_date)) || new Date(body.due_date).toISOString().slice(0, 10) !== body.due_date)) return NextResponse.json({ error: 'Enter a valid date.' }, { status: 400 })
  const { data, error } = await sb.from('job_milestones').insert({ job_id: jobId, builder_id: builderId, title: body.title.trim(), due_date: body.due_date || null }).select('id,title,due_date,completed_at,sort_order').single()
  return error ? NextResponse.json({ error: 'Could not save milestone.' }, { status: 503 }) : NextResponse.json({ milestone: data }, { status: 201 })
}

type Context = { params: { jobId: string } }
export const GET = (request: NextRequest, { params }: Context) => handle(request, params.jobId)
export const POST = (request: NextRequest, { params }: Context) => handle(request, params.jobId)
export const PATCH = (request: NextRequest, { params }: Context) => handle(request, params.jobId)
