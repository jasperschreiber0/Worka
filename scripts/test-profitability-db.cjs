// Run with PGLITE_MODULE pointing to an installed @electric-sql/pglite package.
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
async function main() {
  const db = new PGlite()
  const checks = []
  const check = (name, fn) =>
    Promise.resolve()
      .then(fn)
      .then(() => checks.push(name))
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to authenticated;
create table builders(id uuid primary key);create table jobs(id uuid primary key,builder_id uuid references builders(id));
create table trade_categories(id integer primary key);insert into trade_categories select generate_series(1,13);
create table quotes(id uuid primary key,job_id uuid references jobs(id),builder_id uuid references builders(id),status text,total_cost numeric,qa_report jsonb);
create table variations(id uuid primary key default gen_random_uuid(),job_id uuid references jobs(id),builder_id uuid references builders(id),title text,description text,amount numeric,status text,trade_category_id integer);
create table quote_line_items(id uuid primary key default gen_random_uuid(),quote_id uuid references quotes(id),trade_category_id integer,description text,quantity numeric,unit text,rate numeric,total numeric,margin_pct numeric,confidence numeric,is_assumption boolean,pricing_source text,predicted_by text,variation_id uuid,assumption_status text);
create table proof_events(id uuid primary key default gen_random_uuid(),builder_id uuid references builders(id),job_id uuid references jobs(id),event_type text,description text,metadata jsonb,created_at timestamptz default now());
create table job_cost_entries(id uuid primary key default gen_random_uuid(),builder_id uuid references builders(id),job_id uuid references jobs(id),description text,amount numeric check(amount>=0),trade_category_id integer references trade_categories(id),incurred_on date,cost_kind text,created_at timestamptz default now());
create table job_labour_hours(id uuid primary key default gen_random_uuid(),builder_id uuid references builders(id),job_id uuid references jobs(id),hours numeric);
grant all on all tables in schema public to service_role;`)
  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/20260913105546_profitability_intelligence.sql'),
    'utf8',
  )
  await db.exec(migration)
  checks.push('Migration applies to isolated PostgreSQL-compatible database')
  const a = '10000000-0000-4000-8000-000000000001',
    b = '10000000-0000-4000-8000-000000000002',
    j = '20000000-0000-4000-8000-000000000001',
    other = '20000000-0000-4000-8000-000000000002',
    q = '30000000-0000-4000-8000-000000000001'
  await db.query('insert into builders values ($1),($2)', [a, b])
  await db.query('insert into jobs values ($1,$2),($3,$4)', [j, a, other, b])
  await db.query("insert into quotes values($1,$2,$3,'draft',100,null)", [q, j, a])
  await db.query(
    'insert into quote_line_items(quote_id,trade_category_id,total) values($1,2,100)',
    [q],
  )
  await db.query(
    "insert into business_financial_profiles(builder_id,profile) values($1,'{}'),($2,'{}')",
    [a, b],
  )
  await db.query(
    'insert into job_profitability_settings(job_id,builder_id) values($1,$2),($3,$4)',
    [j, a, other, b],
  )
  await check('RLS restricts profile and project reads to the authenticated builder', async () => {
    await db.exec('set role authenticated')
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [a])
    assert.equal((await db.query('select * from business_financial_profiles')).rows.length, 1)
    assert.equal((await db.query('select * from job_profitability_settings')).rows.length, 1)
    await db.exec('reset role')
  })
  await check('Anon cannot read financial profiles', async () => {
    await db.exec('set role anon')
    await assert.rejects(() => db.query('select * from business_financial_profiles'))
    await db.exec('reset role')
  })
  await check('Browser cannot mutate profiles or call import RPC', async () => {
    await db.exec('set role authenticated')
    await assert.rejects(() => db.query("update business_financial_profiles set profile='{}'"))
    await assert.rejects(() =>
      db.query("select import_profitability_costs($1,$2,'x','x','{}','[]')", [a, j]),
    )
    await db.exec('reset role')
  })
  const row = {
    description: 'Frame invoice',
    amount: 120,
    trade_category_id: 2,
    incurred_on: '2026-09-13',
    source_row: 2,
    labour_hours: 4,
    labour_cost: 60,
    classification_confidence: 1,
  }
  const imp = (builder, job, hash, rows) =>
    db.query('select import_profitability_costs($1,$2,$3,$4,$5,$6)', [
      builder,
      job,
      hash,
      'costs.csv',
      {},
      JSON.stringify(rows),
    ])
  await db.exec('set role service_role')
  await check('Cross-builder import denied before writing', async () => {
    await assert.rejects(() => imp(b, j, 'wrong', [row]))
    assert.equal((await db.query('select * from job_cost_entries')).rows.length, 0)
  })
  await check('Import inserts cost rows and proof event', async () => {
    await imp(a, j, 'valid', [row])
    assert.equal((await db.query('select * from job_cost_entries')).rows.length, 1)
    assert.equal(
      (await db.query("select * from proof_events where event_type='actual_cost'")).rows.length,
      1,
    )
  })
  await check('Duplicate import is rejected without duplicated costs', async () => {
    await assert.rejects(() => imp(a, j, 'valid', [row]))
    assert.equal((await db.query('select * from job_cost_entries')).rows.length, 1)
  })
  await check('Invalid second row rolls back entire batch', async () => {
    await assert.rejects(() => imp(a, j, 'bad', [row, { ...row, source_row: 3, amount: -2 }]))
    assert.equal((await db.query('select * from job_cost_entries')).rows.length, 1)
    assert.equal((await db.query('select * from cost_import_batches')).rows.length, 1)
  })
  await check('Correspondence creates draft evidence and candidate atomically', async () => {
    await db.query('select record_profitability_correspondence($1,$2,$3,$4)', [
      a,
      j,
      {
        type: 'possible_scope_change',
        title: 'Larger windows',
        excerpt: 'Make the windows taller',
        trade: null,
        confidence: 0.9,
        sender: 'Sample client',
        correspondence_date: '13 September 2026',
        trade_label: 'Windows / Glazing',
        action_required: 'Review against original scope',
      },
      { provider: 'paste', text: 'Make the windows taller' },
    ])
    assert.equal(
      (await db.query('select status from profitability_candidates')).rows[0].status,
      'potential',
    )
    const metadata = (await db.query("select metadata from proof_events where event_type='possible_scope_change'")).rows[0].metadata
    assert.equal(metadata.analysis.sender, 'Sample client')
    assert.equal(metadata.analysis.trade_label, 'Windows / Glazing')
    assert.equal(metadata.builder_confirmed, false)
  })
  const c = (await db.query('select id from profitability_candidates')).rows[0].id
  await check('Candidate cannot be approved by analysis/review RPC', async () => {
    await assert.rejects(() =>
      db.query('select review_profitability_candidate($1,$2,$3)', [a, c, { status: 'approved' }]),
    )
    assert.equal((await db.query('select count(*)::integer as n from variations')).rows[0].n, 0)
  })
  await db.query('select review_profitability_candidate($1,$2,$3)', [
    a,
    c,
    {
      estimated_cost: 100,
      proposed_charge: 150,
      incurred: 0,
      billed: 0,
      recovered: 0,
      trade_category_id: 2,
      status: 'priced',
    },
  ])
  await check('Draft variation creation is idempotent; approval remains draft', async () => {
    await db.query('select create_profitability_variation($1,$2)', [a, c])
    await db.query('select create_profitability_variation($1,$2)', [a, c])
    const rows = (await db.query('select * from variations')).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'draft')
  })
  await check('Learning adjustment is explicit, audited and cannot repeat', async () => {
    const args = [a, j, q, 2, 'apply', 13, JSON.stringify({ jobs: ['history'] })]
    await db.query('select apply_profitability_learning($1,$2,$3,$4,$5,$6,$7)', args)
    assert.equal(Number((await db.query('select total_cost from quotes')).rows[0].total_cost), 113)
    await assert.rejects(() =>
      db.query('select apply_profitability_learning($1,$2,$3,$4,$5,$6,$7)', args),
    )
    assert.equal((await db.query('select * from profitability_learning_decisions')).rows.length, 1)
  })
  await check('Changing a source cost invalidates prior completed learning', async () => {
    await db.query(
      "insert into profitability_reviews(job_id,builder_id,context,review,evidence) values($1,$2,'{}','{}','{}')",
      [j, a],
    )
    await db.query('update job_cost_entries set amount=130 where job_id=$1', [j])
    assert.equal((await db.query('select * from profitability_reviews')).rows.length, 0)
  })
  await check('Financial revision rejects a stale completion and writes a current one',async()=>{
    const revision=Number((await db.query('select profitability_revision from jobs where id=$1',[j])).rows[0].profitability_revision)
    await assert.rejects(()=>db.query('select confirm_profitability_review($1,$2,$3,$4,$5,$6)',[a,j,revision-1,{},{},{fingerprint:'stale'}]))
    await db.query('select confirm_profitability_review($1,$2,$3,$4,$5,$6)',[a,j,revision,{},{},{fingerprint:'current'}])
    assert.equal((await db.query('select * from profitability_reviews')).rows.length,1)
  })
  await check('Settings capture and classification are ownership-checked and audited',async()=>{
    await assert.rejects(()=>db.query('select save_profitability_settings($1,$2,$3,$4,$5,$6,$7)',[b,j,100,{},true,q,[]]))
    await db.query('select save_profitability_settings($1,$2,$3,$4,$5,$6,$7)',[a,j,150,{},true,q,[{id:'baseline',total:100}]])
    const cost=(await db.query('select id from job_cost_entries')).rows[0].id
    await db.query('select classify_profitability_cost($1,$2,$3,$4,$5)',[a,j,cost,2,'framing'])
    assert.equal(Number((await db.query('select amount from job_cost_entries')).rows[0].amount),130)
    assert.equal((await db.query("select * from proof_events where description='Builder corrected cost classification'")).rows.length,1)
    assert.equal((await db.query('select * from profitability_reviews')).rows.length,0)
  })
  await db.exec('reset role')
  await db.close()
  const output = { passed: checks.length, checks }
  fs.writeFileSync(
    path.join(__dirname, '../tuesday-db-tests.json'),
    JSON.stringify(output, null, 2),
  )
  console.log(JSON.stringify(output, null, 2))
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
