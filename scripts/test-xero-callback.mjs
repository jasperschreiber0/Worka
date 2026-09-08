// Runs the actual Next.js route handlers with a real embedded PostgreSQL state
// store and mocked Xero transport. No network, mail, or accounting calls.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import test from 'node:test'
import { PGlite } from '../supabase/.temp/security-validation/node_modules/@electric-sql/pglite/dist/index.js'
const require = createRequire(import.meta.url)
const ts = require('typescript')
const { NextRequest, NextResponse } = require('next/server')
const cache = new Map()
let builder = '11111111-1111-4111-8111-111111111111'
let exchanges = 0, writes = 0, failSave = false, clients = 0
const db = new PGlite()
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE TABLE public.builders(id uuid PRIMARY KEY);
INSERT INTO public.builders VALUES ('${builder}'),('22222222-2222-4222-8222-222222222222');`)
await db.exec(readFileSync('supabase/migrations/20260907103156_xero_oauth_transactions.sql', 'utf8'))
const sb = {
  rpc: async (_, args) => ({ data: (await db.query('SELECT public.consume_xero_oauth_state($1,$2) AS ok', [args.p_state_hash, args.p_builder_id])).rows[0].ok, error: null }),
  from: (table) => ({
    delete: () => ({ eq: () => ({ lte: async () => ({ error: null }) }) }),
    insert: async (row) => { await db.query('INSERT INTO xero_oauth_transactions(state_hash,builder_id) VALUES ($1,$2)', [row.state_hash,row.builder_id]); return { error: null } },
    upsert: async (rows) => { assert.equal(table, 'xero_connections'); writes++; assert.equal(rows[0].builder_id, builder); return { error: failSave ? new Error('synthetic failure') : null } },
  }),
}
const fakeFetch = async (url) => {
  if (url === 'https://identity.xero.com/connect/token') { exchanges++; return { ok: true, json: async () => ({ access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 1800 }) } }
  assert.equal(url, 'https://api.xero.com/connections')
  return { ok: true, json: async () => [{ tenantId: 'synthetic-xero-tenant' }] }
}
function load(file) {
  file = resolve(file)
  if (cache.has(file)) return cache.get(file)
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(file,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const localRequire = (id) => {
    if (id === '@/lib/auth/api-auth') return { getAuthenticatedBuilderId: async () => builder, isDemoMode: () => false }
    if (id === '@supabase/supabase-js') return { createClient: () => { clients++; return sb } }
    if (id.startsWith('@/')) return load(id.slice(2) + '.ts')
    return require(id)
  }
  vm.runInThisContext('(function(require,module,exports,fetch){' + code + '\n})', { filename: file })(localRequire,module,module.exports,fakeFetch)
  cache.set(file,module.exports); return module.exports
}
Object.assign(process.env, { NODE_ENV: 'production', XERO_ENABLED: 'true', NEXT_PUBLIC_APP_URL: 'https://worka.test', NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic', XERO_CLIENT_ID: 'synthetic', XERO_CLIENT_SECRET: 'synthetic', XERO_TOKEN_ENCRYPTION_KEY: 'synthetic-test-only-key' })
const state = load('lib/xero-oauth-state.ts')
const connect = load('app/api/xero/connect/route.ts').GET
const callback = load('app/api/xero/callback/route.ts').GET
async function start() {
  const response = await connect(new NextRequest('https://worka.test/api/xero/connect'))
  assert.equal(response.status,200)
  assert.match(response.headers.get('set-cookie'), /Path=\/api\/xero/)
  assert.match(response.headers.get('set-cookie'), /HttpOnly/)
  assert.match(response.headers.get('set-cookie'), /Secure/)
  return new URL((await response.json()).auth_url).searchParams.get('state')
}
function request(value, cookie = value, code = 'synthetic-code') {
  const params = new URLSearchParams()
  if (value !== null) params.set('state',value)
  if (code !== null) params.set('code',code)
  return new NextRequest('https://worka.test/api/xero/callback?' + params, { headers: cookie ? { cookie: `${state.XERO_OAUTH_STATE_COOKIE}=${cookie}` } : {} })
}
function cleared(response) {
  assert.match(response.headers.get('set-cookie'), /Path=\/api\/xero/)
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
  assert.match(response.headers.get('set-cookie'), /HttpOnly/)
  assert.match(response.headers.get('set-cookie'), /Secure/)
}
test('actual callback: concurrent consumption permits one exchange/save; replay denied', async () => {
  const value = await start(); const before = exchanges
  const responses = await Promise.all(Array.from({length:8}, () => callback(request(value))))
  assert.equal(responses.filter(r => r.headers.get('location').endsWith('connected')).length,1)
  assert.equal(exchanges-before,1); assert.equal(writes,1)
  for (const response of responses) cleared(response)
  assert.match((await callback(request(value))).headers.get('location'),/status=error/)
  assert.equal(exchanges-before,1)
})
test('actual callback rejects missing, tampered, expired, wrong builder/cookie, invalid signature and missing code before side effects', async () => {
  const value = await start(); const before = [exchanges,writes]
  const expired = state.createXeroOAuthState(builder,Date.now()-700000)
  const requests = [request(null),request(value,null),request(value+'x',value),request(expired),request(value,value+'x'),request(value,value,null)]
  for (const req of requests) { const r=await callback(req); assert.match(r.headers.get('location'),/status=error/); cleared(r) }
  const owner=builder; builder='22222222-2222-4222-8222-222222222222'
  assert.match((await callback(request(value))).headers.get('location'),/status=error/); builder=owner
  assert.deepEqual([exchanges,writes],before)
})
test('database expiry wins even when signed state is fresh', async () => {
  const value=await start()
  await db.query("UPDATE xero_oauth_transactions SET created_at=now()-interval '20 minutes', expires_at=now()-interval '10 minutes' WHERE state_hash=$1",[state.hashXeroOAuthState(value)])
  const before=exchanges
  assert.match((await callback(request(value))).headers.get('location'),/status=error/)
  assert.equal(exchanges,before)
})
test('failed connection persistence reports error and never restores consumed state', async () => {
  const value=await start(); failSave=true
  const before=exchanges
  const response=await callback(request(value)); cleared(response)
  assert.match(response.headers.get('location'),/status=error/)
  failSave=false
  assert.match((await callback(request(value))).headers.get('location'),/status=error/)
  assert.equal(exchanges-before,1)
})

test('default-off release switch blocks every Xero operation even with credentials present', async () => {
  const before=[exchanges,writes,clients]
  delete process.env.XERO_ENABLED
  try {
    const initiation=await connect(new NextRequest('https://worka.test/api/xero/connect'))
    assert.equal((await initiation.json()).disabled,true)
    const response=await callback(request('disabled-state'));cleared(response)
    assert.match(response.headers.get('location'),/status=error/)
    const sync=load('app/api/xero/sync/route.ts')
    assert.equal((await sync.POST()).status,503)
    const items=load('app/api/xero/import-items/route.ts')
    for(const method of ['GET','POST','PATCH']){
      const req=new NextRequest('https://worka.test/api/xero/import-items',{method})
      assert.equal((await items[method](req)).status,503)
    }
    for(const route of ['status','history']){
      assert.equal((await (await load('app/api/xero/'+route+'/route.ts').GET()).json()).disabled,true)
    }
    assert.equal(await load('lib/xero-token.ts').getXeroAccessToken(builder),null)
    assert.deepEqual([exchanges,writes,clients],before)
  } finally {process.env.XERO_ENABLED='true'}
})

test.after(async () => { await db.close() })
