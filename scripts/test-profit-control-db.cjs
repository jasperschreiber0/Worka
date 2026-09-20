// Isolated PostgreSQL-compatible migration and authorization tests. No network or customer data.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
async function main(){
 const db=new PGlite(),checks=[]
 const check=async(name,fn)=>{await fn();checks.push(name)}
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to authenticated;
 create table builders(id uuid primary key);create table jobs(id uuid primary key,builder_id uuid references builders(id),profitability_revision bigint default 0);
 create table workers(id uuid primary key,builder_id uuid references builders(id));
 create table job_profitability_settings(job_id uuid primary key,builder_id uuid,original_contract numeric,baseline_items jsonb,settings jsonb);
 create table job_cost_entries(id uuid primary key default gen_random_uuid(),builder_id uuid,job_id uuid,amount numeric);
 create table job_labour_hours(id uuid primary key default gen_random_uuid(),builder_id uuid,job_id uuid,hours numeric,hourly_rate numeric);
 create table variations(id uuid primary key default gen_random_uuid(),builder_id uuid,job_id uuid);
 create table invoices(id uuid primary key default gen_random_uuid(),builder_id uuid,job_id uuid);
 create table proof_events(id uuid primary key default gen_random_uuid(),builder_id uuid not null,job_id uuid not null,event_type text,description text,metadata jsonb);
 grant all on all tables in schema public to service_role,authenticated;
 alter table jobs enable row level security;create policy own_job on jobs for all to authenticated using(builder_id=auth.uid()) with check(builder_id=auth.uid());
 create policy old_owner on job_cost_entries for all to authenticated using(builder_id=auth.uid());
 create policy old_owner on job_labour_hours for all to authenticated using(builder_id=auth.uid());
 create policy old_owner on variations for all to authenticated using(builder_id=auth.uid());
 create policy old_owner on invoices for all to authenticated using(builder_id=auth.uid());`)
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260920044222_profit_control_centre.sql'),'utf8'))
 const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002',j='20000000-0000-4000-8000-000000000001',k='20000000-0000-4000-8000-000000000002',w='30000000-0000-4000-8000-000000000001',v='30000000-0000-4000-8000-000000000002'
 await db.query('insert into builders values($1),($2)',[a,b]);await db.query('insert into jobs values($1,$2,7),($3,$4,1)',[j,a,k,b]);await db.query('insert into workers values($1,$2),($3,$4)',[w,a,v,b])
 await db.query(`insert into job_profitability_settings values($1,$2,100000,'[{"total":70000}]','{"taxReconciled":true,"labourIncluded":false}')`,[j,a])
 const save=(builder=a,job=j,revision=7,plan={})=>db.query('select save_job_control_plan($1,$2,$3,true,$4)',[builder,job,revision,plan])
 await check('Migration creates protected objects and a confirmed forecast',async()=>{
  await db.exec('set role service_role');await save();assert.equal(Number((await db.query('select confirmed_revision from job_control_plans')).rows[0].confirmed_revision),7)
 })
 await check('Cross-tenant job and supervisor are rejected by server RPC',async()=>{
  await assert.rejects(()=>save(b,j));await assert.rejects(()=>save(a,j,7,{lead_worker_id:v}));assert.equal((await db.query('select * from job_control_plans')).rows.length,1)
 })
 await check('Stale confirmation, incomplete cash, reversed dates and missing GST are rejected atomically',async()=>{
  await assert.rejects(()=>save(a,j,6));await assert.rejects(()=>save(a,j,7,{cash_received:10}));await assert.rejects(()=>save(a,j,7,{start_on:'2026-10-02',finish_on:'2026-10-01'}))
  await db.query(`update job_profitability_settings set settings='{}' where job_id=$1`,[j]);await assert.rejects(()=>save());await db.query(`update job_profitability_settings set settings='{"taxReconciled":true}' where job_id=$1`,[j])
 })
 await check('Uncosted hours block forecast approval',async()=>{
  await db.query('insert into job_labour_hours(builder_id,job_id,hours)values($1,$2,2)',[a,j]);await assert.rejects(()=>save());await db.query('update job_labour_hours set hourly_rate=50 where job_id=$1',[j]);await save()
 })
 await check('Cash, dated program and same-tenant supervisor persist with audit evidence',async()=>{
  await save(a,j,7,{lead_worker_id:w,start_on:'2026-10-01',finish_on:'2026-10-30',cash_received:25000,cash_paid:15000,cash_as_of:'2026-09-01'})
  assert.equal(Number((await db.query('select cash_paid from job_control_plans')).rows[0].cash_paid),15000);assert.ok((await db.query('select * from proof_events')).rows.length>0)
 })
 await check('Compliance upsert retains immutable review history and rejects other tenants',async()=>{
  for(const ref of ['policy 1','policy 2'])await db.query("select record_worker_compliance($1,$2,'insurance',$3,'2026-12-01')",[a,w,ref])
  assert.equal((await db.query('select * from worker_compliance_records')).rows.length,1);assert.equal((await db.query('select * from worker_compliance_events')).rows.length,2)
  await assert.rejects(()=>db.query("select record_worker_compliance($1,$2,'insurance','other',null)",[b,w]))
 })
 await check('Authenticated owner can read but cannot forge confirmations or compliance',async()=>{
  await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[a])
  assert.equal((await db.query('select * from job_control_plans')).rows.length,1)
  await assert.rejects(()=>db.query('update job_control_plans set confirmed_revision=99'));await assert.rejects(()=>save())
  await assert.rejects(()=>db.query("insert into worker_compliance_records(builder_id,worker_id,kind,evidence)values($1,$2,'licence','forged')",[a,w]))
 })
 await check('Another tenant cannot read plans, compliance or history',async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[b])
  for(const t of ['job_control_plans','worker_compliance_records','worker_compliance_events'])assert.equal((await db.query(`select * from ${t}`)).rows.length,0)
 })
 await check('Legacy financial writes reject a foreign job even with a matching builder_id',async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[a])
  for(const t of ['job_cost_entries','job_labour_hours','variations','invoices']){
   await assert.rejects(()=>db.query(`insert into ${t}(builder_id,job_id)values($1,$2)`,[a,k]));await db.query(`insert into ${t}(builder_id,job_id)values($1,$2)`,[a,j])
   await assert.rejects(()=>db.query(`update ${t} set job_id=$1 where builder_id=$2`,[k,a]))
  }
 })
 await check('Anon has neither reads nor financial RPC execution',async()=>{
  await db.exec('reset role;set role anon');await assert.rejects(()=>db.query('select * from job_control_plans'));await assert.rejects(()=>save());await db.exec('reset role')
 })
 await db.close();console.log(JSON.stringify({passed:checks.length,checks},null,2))
}
main().catch(e=>{console.error(e);process.exitCode=1})

