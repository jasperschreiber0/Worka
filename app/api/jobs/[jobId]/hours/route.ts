import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { isValidTradeCategoryId } from '@/lib/trade-taxonomy'

export async function GET(_: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const builderId = await getAuthenticatedBuilderId(); if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { jobId } = await params
  if (isDemoMode()) return NextResponse.json({ hours: [] })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ hours: [] })
  const sb = createClient(url, key, { auth: { persistSession: false } }); const { data, error } = await sb.from('job_labour_hours').select('id,worker_id,work_date,hours,note,created_at,hourly_rate,trade_category_id').eq('builder_id', builderId).eq('job_id', jobId).order('work_date', { ascending: false }).limit(100)
  if (error) return NextResponse.json({ error: 'Could not load hours.' }, { status: 500 }); return NextResponse.json({ hours: data ?? [] })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const builderId = await getAuthenticatedBuilderId(); if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { jobId } = await params; const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  if (typeof body.hours !== 'number') return NextResponse.json({ error: 'Enter a valid number of hours.' }, { status: 400 })
  const hours = body.hours
  if (body.trade_category_id != null && !isValidTradeCategoryId(body.trade_category_id)) return NextResponse.json({ error: 'Choose a valid trade.' }, { status: 400 })
  if (body.note != null && (typeof body.note !== 'string' || body.note.length > 2000)) return NextResponse.json({ error: 'Keep notes under 2000 characters.' }, { status: 400 })
  if (body.work_date && (typeof body.work_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.work_date) || Number.isNaN(Date.parse(body.work_date)) || new Date(body.work_date).toISOString().slice(0, 10) !== body.work_date)) return NextResponse.json({ error: 'Enter a valid work date.' }, { status: 400 })
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return NextResponse.json({ error: 'Enter between 0 and 24 hours.' }, { status: 400 })
  if (isDemoMode()) return NextResponse.json({ hour: { id: `demo-hours-${Date.now()}`, worker_id: body.worker_id ?? null, work_date: body.work_date ?? new Date().toISOString().slice(0, 10), hours, note: body.note ?? null } }, { status: 201 })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!url || !key) return NextResponse.json({ error: 'Database is not configured.' }, { status: 503 })
  const sb = createClient(url, key, { auth: { persistSession: false } })
  const { data: job, error: jobError } = await sb.from('jobs').select('id').eq('id', jobId).eq('builder_id', builderId).maybeSingle()
  if (jobError) return NextResponse.json({ error: 'Could not verify job.' }, { status: 500 })
  if (!job) return NextResponse.json({ error: 'Job not found.' }, { status: 404 })
  let hourlyRate: number | null = null
  if (body.worker_id) {
    const { data: worker, error: workerError } = await sb.from('workers').select('id,hourly_rate').eq('id', body.worker_id).eq('builder_id', builderId).maybeSingle()
    if (workerError || !worker) return NextResponse.json({ error: 'Choose a worker from your team.' }, { status: 400 })
    hourlyRate = worker.hourly_rate
  }
  const { data, error } = await sb.from('job_labour_hours').insert({ builder_id: builderId, job_id: jobId, worker_id: body.worker_id || null, work_date: body.work_date || new Date().toISOString().slice(0, 10), hours, hourly_rate: hourlyRate, trade_category_id: body.trade_category_id ?? null, note: body.note || null }).select('id,worker_id,work_date,hours,note,created_at,hourly_rate,trade_category_id').single()
  if (error) return NextResponse.json({ error: 'Could not save hours.' }, { status: 500 }); return NextResponse.json({ hour: data }, { status: 201 })
}

