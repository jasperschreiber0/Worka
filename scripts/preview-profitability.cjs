// Isolated UI/API fixture. No external service, credentials or customer records.
// Run: node scripts/preview-profitability.cjs (Ctrl+C stops both local servers).
const http = require('node:http'),
  crypto = require('node:crypto'),
  { spawn } = require('node:child_process'),
  path = require('node:path')
const builder = '10000000-0000-4000-8000-000000000001',
  job = '20000000-0000-4000-8000-000000000001',
  quote = '30000000-0000-4000-8000-000000000001',
  otherJob = '20000000-0000-4000-8000-000000000002'
const now = new Date().toISOString(),
  user = {
    id: builder,
    email: 'builder@example.invalid',
    aud: 'authenticated',
    role: 'authenticated',
    created_at: now,
    user_metadata: { full_name: 'Tuesday Preview', company_name: 'Sample Building Co' },
  }
const token = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(
    JSON.stringify({
      sub: builder,
      aud: 'authenticated',
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 86400,
    }),
  ).toString('base64url'),
  'local-fixture-only',
].join('.')
const session = {
  access_token: token,
  refresh_token: 'local-refresh-only',
  token_type: 'bearer',
  expires_in: 86400,
  expires_at: Math.floor(Date.now() / 1000) + 86400,
  user,
}
const categories = [
  'Site Works & Concrete',
  'Framing',
  'Roofing',
  'External Cladding',
  'Insulation',
  'Internal Linings',
  'Fit-out Carpentry',
  'Cabinetry',
  'Paint',
  'Flooring',
  'Fixtures & Tapware',
  'Electrical',
  'Preliminaries',
]
const items = [
  {
    id: '40000000-0000-4000-8000-000000000001',
    quote_id: quote,
    trade_category_id: 2,
    description: 'Framing labour and materials',
    total: 48200,
    margin_pct: 0.28,
    labour_cost: 18000,
    assumption_status: null,
    variation_id: null,
  },
  {
    id: '40000000-0000-4000-8000-000000000002',
    quote_id: quote,
    trade_category_id: 12,
    description: 'Electrical installation',
    total: 25000,
    margin_pct: 0.28,
    assumption_status: null,
    variation_id: null,
  },
  {
    id: '40000000-0000-4000-8000-000000000003',
    quote_id: quote,
    trade_category_id: 10,
    description: 'Tiling',
    total: 18000,
    margin_pct: 0.28,
    assumption_status: null,
    variation_id: null,
  },
]
const db = {
  builders: [{ ...user, name: 'Tuesday Preview' }],
  jobs: [
    {
      id: job,
      builder_id: builder,
      address: 'Sample renovation · 24 Banksia Street',
      status: 'active',
      job_type: 'renovation',
      created_at: now,
    },
    {
      id: otherJob,
      builder_id: '10000000-0000-4000-8000-000000000002',
      address: 'Other builder private job',
      status: 'active',
      created_at: now,
    },
  ],
  quotes: [
    {
      id: quote,
      job_id: job,
      builder_id: builder,
      status: 'draft',
      is_current: true,
      version: 1,
      total_cost: 91200,
      created_at: now,
    },
  ],
  quote_line_items: items,
  job_profitability_settings: [],
  business_financial_profiles: [
    {
      builder_id: builder,
      profile: {
        annualRevenue: 2000000,
        targetRevenue: 2500000,
        overheadMode: 'simple',
        annualOverhead: 300000,
        overheads: {},
        profitMode: 'percent',
        netProfitPct: 10,
        annualProfit: 0,
        workingWeeks: 48,
        jobsPerYear: 6,
        constructionVolume: null,
      },
      cash_flow: {
        opening: 30000,
        weeks: Array.from({ length: 13 }, (_, i) => ({
          inflow: i % 3 === 0 ? 28000 : 5000,
          outflow: 14000,
        })),
        complete: false,
      },
    },
  ],
  job_cost_entries: [
    {
      id: '50000000-0000-4000-8000-000000000001',
      job_id: job,
      builder_id: builder,
      trade_category_id: 2,
      description: 'Frame supplier and labour invoice',
      amount: 62100,
      cost_kind: 'incurred',
      supplier: 'Sample Framing',
      invoice_ref: 'F-001',
      incurred_on: '2026-09-10',
      labour_hours: 240,
      labour_cost: 24000,
      created_at: now,
    },
    {
      id: '50000000-0000-4000-8000-000000000002',
      job_id: job,
      builder_id: builder,
      trade_category_id: 12,
      description: 'Electrical final invoice',
      amount: 28000,
      cost_kind: 'incurred',
      created_at: now,
    },
    {
      id: '50000000-0000-4000-8000-000000000003',
      job_id: job,
      builder_id: builder,
      trade_category_id: 10,
      description: 'Tiling final invoice',
      amount: 16000,
      cost_kind: 'incurred',
      created_at: now,
    },
  ],
  job_labour_hours: [],
  profitability_candidates: [
    {
      id: '60000000-0000-4000-8000-000000000001',
      job_id: job,
      builder_id: builder,
      title: 'Taller black aluminium western windows',
      trade_category_id: null,
      estimated_cost: 4200,
      proposed_charge: 5600,
      status: 'potential',
      incurred: 1200,
      billed: 0,
      recovered: 0,
      evidence: 'Can we change the western windows to black aluminium and make them 2400 high?',
      confidence: 0.9,
      created_at: now,
    },
  ],
  variations: [],
  proof_events: [],
  communication_history: [],
  profitability_reviews: [],
  trade_categories: categories.map((name, i) => ({ id: i + 1, name })),
  notifications: [],
}
const json = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Range',
  })
  res.end(JSON.stringify(data))
}
function matches(row, params) {
  for (const [k, v] of params) {
    if (['select', 'order', 'offset', 'limit', 'on_conflict'].includes(k)) continue
    if (v.startsWith('eq.') && String(row[k]) !== v.slice(3)) return false
    if (v === 'is.null' && row[k] != null) return false
  }
  return true
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    })
    return res.end()
  }
  let raw = ''
  for await (const part of req) raw += part
  let body
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    return json(res, 400, { message: 'Invalid JSON' })
  }
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname.startsWith('/auth/v1/')) {
    if (url.pathname.endsWith('/user'))
      return req.headers.authorization?.includes(token)
        ? json(res, 200, user)
        : json(res, 401, { message: 'Unauthorized' })
    if (url.pathname.endsWith('/token')) return json(res, 200, session)
    if (url.pathname.endsWith('/logout')) return json(res, 200, {})
    return json(res, 200, {})
  }
  if (!url.pathname.startsWith('/rest/v1/')) return json(res, 404, { message: 'Not found' })
  const name = url.pathname.slice('/rest/v1/'.length)
  if (name.startsWith('rpc/')) {
    const rpc = name.slice(4)
    if(rpc==='confirm_profitability_review'){
      db.profitability_reviews=[{job_id:body.p_job,builder_id:body.p_builder,context:body.p_context,review:body.p_review,evidence:body.p_evidence}]
      return json(res,200,null)
    }
    if (rpc === 'save_profitability_settings') {
      const value = {
        job_id: body.p_job,
        builder_id: body.p_builder,
        original_contract: body.p_contract,
        settings: body.p_settings,
        baseline_quote_id: body.p_quote,
        baseline_items: body.p_items,
      }
      db.job_profitability_settings = [value]
      return json(res, 200, null)
    }
    if (rpc === 'classify_profitability_cost') {
      Object.assign(
        db.job_cost_entries.find((c) => c.id === body.p_cost),
        { trade_category_id: body.p_trade, category: body.p_category },
      )
      return json(res, 200, null)
    }
    if (rpc === 'import_profitability_costs') {
      db.cost_import_batches ??= []
      if (db.cost_import_batches.some((r) => r.fingerprint === body.p_fingerprint))
        return json(res, 409, { code: '23505', message: 'Duplicate' })
      const id = crypto.randomUUID()
      db.cost_import_batches.push({ id, fingerprint: body.p_fingerprint })
      for (const row of body.p_rows)
        db.job_cost_entries.push({
          ...row,
          id: crypto.randomUUID(),
          job_id: body.p_job,
          builder_id: body.p_builder,
          cost_kind: 'incurred',
          created_at: now,
        })
      db.profitability_reviews = []
      return json(res, 200, id)
    }
    if (rpc === 'review_profitability_candidate') {
      const c = db.profitability_candidates.find((c) => c.id === body.p_id)
      Object.assign(c, body.p_values)
      return json(res, 200, null)
    }
    if (rpc === 'create_profitability_variation') {
      const c = db.profitability_candidates.find((c) => c.id === body.p_candidate)
      c.variation_id ??= crypto.randomUUID()
      db.variations.push({
        id: c.variation_id,
        job_id: job,
        builder_id: builder,
        title: c.title,
        amount: c.proposed_charge,
        status: 'draft',
        created_at: now,
      })
      return json(res, 200, c.variation_id)
    }
    return json(res, 200, null)
  }
  db[name] ??= []
  const rows = db[name].filter((r) => matches(r, url.searchParams))
  if (req.method === 'GET') {
    let selected = rows
    const order = url.searchParams.get('order')
    if (order)
      selected = [...selected].sort((a, b) => {
        for (const term of order.split(',')) {
          const [key, direction] = term.split('.')
          if (a[key] !== b[key])
            return (String(a[key]) < String(b[key]) ? -1 : 1) * (direction === 'desc' ? -1 : 1)
        }
        return 0
      })
    const offset = Number(url.searchParams.get('offset') || 0),
      limit = Number(url.searchParams.get('limit') || 500)
    selected = selected.slice(offset, offset + limit)
    const fields = url.searchParams.get('select')
    if (fields && fields !== '*' && !fields.includes('('))
      selected = selected.map((r) => Object.fromEntries(fields.split(',').map((k) => [k, r[k]])))
    if (req.headers.accept?.includes('vnd.pgrst.object'))
      return selected.length
        ? json(res, 200, selected[0])
        : json(res, 406, {
            code: 'PGRST116',
            details: 'The result contains 0 rows',
            message: 'No rows',
          })
    return json(res, 200, selected)
  }
  let output = []
  if (req.method === 'POST') {
    for (const input of Array.isArray(body) ? body : [body]) {
      const key =
        name === 'business_financial_profiles'
          ? 'builder_id'
          : ['job_profitability_settings', 'profitability_reviews'].includes(name)
            ? 'job_id'
            : 'id'
      const old = req.headers.prefer?.includes('resolution=merge')
        ? db[name].find((r) => r[key] === input[key])
        : null
      if (old) {
        Object.assign(old, input)
        output.push(old)
      } else {
        const r = { id: crypto.randomUUID(), created_at: now, ...input }
        db[name].push(r)
        output.push(r)
      }
    }
  } else if (req.method === 'PATCH') {
    for (const row of rows) Object.assign(row, body)
    output = rows
  } else if (req.method === 'DELETE') {
    db[name] = db[name].filter((r) => !rows.includes(r))
  }
  if (req.headers.accept?.includes('vnd.pgrst.object')) return json(res, 200, output[0])
  json(res, 200, output)
})
server.listen(3222, '127.0.0.1', () => {
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, '../node_modules/next/dist/bin/next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3221',
    ],
    {
      cwd: path.join(__dirname, '..'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:3222',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'local-fixture-anon',
        SUPABASE_SERVICE_ROLE_KEY: 'local-fixture-service',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        XERO_ENABLED: 'false',
        NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3221',
      },
    },
  )
  child.stdout.on('data', (d) => process.stdout.write(d))
  child.stderr.on('data', () => {})
  process.on('SIGINT', () => {
    child.kill()
    server.close()
    process.exit(0)
  })
  console.log('LOCAL FIXTURE ONLY. Login builder@example.invalid / preview-password. Job: ' + job)
})
