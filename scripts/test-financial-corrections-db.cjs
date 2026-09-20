// Isolated integration tests; reuses the base schema fixture from the original migration tests.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
async function main(){
 const db=new PGlite(),checks=[];const check=async(name,fn)=>{await fn();checks.push(name)}
 const fixture=fs.readFileSync(path.join(__dirname,'test-profitability-db.cjs'),'utf8').match(/await db\.exec\(`([\s\S]*?)`\)/)[1]
 await db.exec(fixture)
 await db.exec("alter table jobs add column status text default 'active';alter table job_labour_hours add column hourly_rate numeric;")
 for(const name of ['20260913105546_profitability_intelligence.sql','20260920085157_audit_trust_and_financial_corrections.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations',name),'utf8'))
 const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002',j='20000000-0000-4000-8000-000000000001',k='20000000-0000-4000-8000-000000000002',q='30000000-0000-4000-8000-000000000001',q2='30000000-0000-4000-8000-000000000002',c='40000000-0000-4000-8000-000000000001',h='50000000-0000-4000-8000-000000000001'
 await db.query('insert into builders values($1),($2)',[a,b]);await db.query('insert into jobs(id,builder_id)values($1,$2),($3,$4)',[j,a,k,b]);await db.query('insert into quotes(id,job_id,builder_id)values($1,$2,$3),($4,$5,$6)',[q,j,a,q2,k,b])
 await db.query(`insert into job_profitability_settings(job_id,builder_id,baseline_quote_id,baseline_items,settings)values($1,$2,$3,'[{"total":100}]','{"taxReconciled":true}')`,[j,a,q])
 await db.query("insert into job_cost_entries(id,job_id,builder_id,amount,cost_kind,description,trade_category_id)values($1,$2,$3,1000,'committed','Frame',2)",[c,j,a])
 await db.query('insert into job_labour_hours(id,job_id,builder_id,hours)values($1,$2,$3,2)',[h,j,a])
 const rev=async()=>Number((await db.query('select profitability_revision from jobs where id=$1',[j])).rows[0].profitability_revision)
 const correct=async(action,id,values,builder=a,revision,reason='Correct invoice reference')=>db.query('select correct_job_financial_record($1,$2,$3,$4,$5,$6,$7)',[builder,j,revision??await rev(),action,id,values,reason])
 const complete=async(builder=a,revision)=>db.query('select confirm_profitability_review($1,$2,$3,$4,$5,$6)',[builder,j,revision??await rev(),{jobId:j},{trades:[]},{taxReconciled:true,mappingsConfirmed:true,fingerprint:'fixture'}])
 await db.exec('set role service_role')
 await check('Cross-tenant, stale edits, invalid numbers and missing reasons fail',async()=>{
  await assert.rejects(()=>correct('correct_cost',c,{amount:900,cost_kind:'committed'},b));await assert.rejects(()=>correct('correct_cost',c,{amount:900,cost_kind:'committed'},a,0));await assert.rejects(()=>correct('correct_cost',c,{amount:'NaN',cost_kind:'committed'}));await assert.rejects(async()=>correct('void_cost',c,{},a,await rev(),'no'))
  assert.equal(Number((await db.query('select amount from job_cost_entries where id=$1',[c])).rows[0].amount),1000)
 })
 await check('Partial bill preserves total, remaining balance, and before/after evidence',async()=>{
  await correct('settle_cost',c,{amount:400,incurred_on:'2026-09-20'})
  const rows=(await db.query('select amount,cost_kind from job_cost_entries')).rows
  assert.equal(rows.reduce((s,r)=>s+Number(r.amount),0),1000);assert.equal(Number(rows.find(r=>r.cost_kind==='committed').amount),600)
  const event=(await db.query("select metadata from proof_events where event_type='cost_event'")).rows[0].metadata
  assert.equal(event.before.amount,1000);assert.equal(event.after.amount,600);assert.ok(event.settled_entry_id)
 })
 await check('Oversettlement and invalid date roll back every change',async()=>{
  const revision=await rev();await assert.rejects(()=>correct('settle_cost',c,{amount:601,incurred_on:'2026-09-20'}));await assert.rejects(()=>correct('settle_cost',c,{amount:100,incurred_on:'2026-02-30'}));assert.equal(await rev(),revision)
 })
 await check('Outstanding commitments and unpriced labour block completion',async()=>{
  await assert.rejects(()=>complete());await correct('settle_cost',c,{amount:600,incurred_on:'2026-09-20'});await assert.rejects(()=>complete());await correct('correct_hours',h,{hours:3,hourly_rate:60})
 })
 await check('Wrong-tenant baseline cannot become approved memory',async()=>{
  await db.query('update job_profitability_settings set baseline_quote_id=$1 where job_id=$2',[q2,j]);await assert.rejects(()=>complete());await db.query('update job_profitability_settings set baseline_quote_id=$1 where job_id=$2',[q,j])
 })
 await check('Completion closes the job atomically and repeated confirmation is idempotent',async()=>{
  await assert.rejects(()=>complete(b));await complete();assert.equal((await db.query('select status from jobs where id=$1',[j])).rows[0].status,'complete')
  const count=(await db.query("select count(*) from proof_events where event_type='approval'")).rows[0].count;await complete();assert.equal((await db.query("select count(*) from proof_events where event_type='approval'")).rows[0].count,count)
 })
 await check('Corrections invalidate approved memory and retain voided source history',async()=>{
  await correct('void_cost',c,{});assert.equal((await db.query('select * from profitability_reviews')).rows.length,0);assert.equal(Number((await db.query('select amount from job_cost_entries where id=$1',[c])).rows[0].amount),0);await complete()
 })
 await check('Browser and anon cannot invoke financial correction or completion',async()=>{
  const revision=await rev();for(const role of ['authenticated','anon']){await db.exec(`reset role;set role ${role}`);await assert.rejects(()=>correct('void_cost',c,{},a,revision));await assert.rejects(()=>complete(a,revision));await assert.rejects(()=>db.query('update job_cost_entries set amount=1'));await assert.rejects(()=>db.query('delete from job_labour_hours'))}await db.exec('reset role')
 })
 await check('Application functions have a fixed search path',async()=>{assert.equal((await db.query("select count(*)::integer n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proconfig is null")).rows[0].n,0)})
 await db.close();console.log(JSON.stringify({passed:checks.length,checks},null,2))
}
main().catch(e=>{console.error(e);process.exitCode=1})
