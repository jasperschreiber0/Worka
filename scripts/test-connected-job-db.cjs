// Real SQL/state-transition tests on isolated PostgreSQL-compatible PGlite.
// External storage and AI workers are deliberately not exercised here.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID:id}=require('node:crypto')
async function main(){
 const db=new PGlite(),checks=[];const check=async(name,fn)=>{await fn();checks.push(name)}
 const fixture=fs.readFileSync(path.join(__dirname,'test-profitability-db.cjs'),'utf8').match(/await db\.exec\(`([\s\S]*?)`\)/)[1]
 await db.exec(fixture)
 await db.exec(`alter table jobs add column status text default 'active';alter table job_labour_hours add column hourly_rate numeric;
 alter table variations add column approved_at timestamptz;alter table variations add column approved_by text;
 alter table quotes alter column id set default gen_random_uuid();alter table quotes add column version integer default 1;alter table quotes add column is_current boolean default false;alter table quotes add column confidence_score numeric;
 create table files(id uuid primary key default gen_random_uuid(),job_id uuid,builder_id uuid,filename text,storage_path text,file_type text,content_hash text,duplicate_of_file_id uuid,file_size_bytes bigint,created_at timestamptz default now(),processing_batch_id uuid,intake_status text,failure_reason text,failure_stage text);
 create table project_facts(id uuid primary key default gen_random_uuid(),job_id uuid,category text,key text,value text,evidence text,confidence numeric,superseded boolean default false);
 create table document_processing_batches(id uuid primary key default gen_random_uuid(),job_id uuid,builder_id uuid,primary_file_id uuid,status text);
 create table document_processing_jobs(id uuid primary key default gen_random_uuid(),parent_job_id uuid,document_id uuid);
 create table estimate_workflow(batch_id uuid,state text);create table estimating_access(builder_id uuid,enabled boolean);
 create table scope_items(id uuid primary key,job_id uuid,trade_category_id integer);create table assumptions(id uuid primary key,line_item_id uuid);create schema storage;create table storage.objects(bucket_id text,name text);
 create function enqueue_estimate_workflow(uuid,uuid) returns void language sql set search_path=public as $$insert into estimate_workflow values($1,'queued')$$;
 create function register_estimate_continuation(uuid,uuid) returns void language sql set search_path=public as $$select$$;
 grant usage on schema storage to service_role;grant all on all tables in schema storage to service_role;
 grant all on all tables in schema public to service_role;grant select on jobs to authenticated;`)
 for(const name of ['20260913105546_profitability_intelligence.sql','20260920085157_audit_trust_and_financial_corrections.sql','20260926023541_connected_job_workflow.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations',name),'utf8'))
 checks.push('Connected migration applies to isolated database')
 const a=id(),b=id(),j=id(),k=id(),q=id(),f=id(),f2=id(),f3=id()
 await db.query('insert into builders values($1),($2)',[a,b]);await db.query('insert into jobs(id,builder_id)values($1,$2),($3,$4)',[j,a,k,b])
 await db.query("insert into quotes(id,job_id,builder_id,status,is_current)values($1,$2,$3,'approved',true)",[q,j,a])
 await db.query("insert into files(id,job_id,builder_id,filename,storage_path,file_type,drawing_state)values($1,$2,$3,'demo plans.pdf','demo','pdf','unresolved'),($4,$2,$3,'renamed.pdf','duplicate','pdf','unresolved'),($5,$2,$3,'revision.pdf','revision','pdf','unresolved')",[f,j,a,f2,f3])
 await db.exec("insert into storage.objects values('plans','demo'),('plans','revision')");await db.query("insert into estimating_access values($1,true)",[a])
 await db.exec('set role service_role')
 const rev=async()=>Number((await db.query('select profitability_revision from jobs where id=$1',[j])).rows[0].profitability_revision)
 const save=async(kind,title,payload={},result={},recordId=id(),version=0,builder=a,basis)=> (await db.query("select save_job_workflow($1,$2,$3,$4,$5,$6,$7,$8,'save',$9) r",[builder,j,recordId,version,kind,title,payload,result,basis??await rev()])).rows[0].r
 const act=async(r,action='confirm',builder=a)=>(await db.query("select save_job_workflow($1,$2,$3,$4,$5,$6,'{}','{}',$7,$8) r",[builder,j,r.id,r.version,r.kind,r.title,action,await rev()])).rows[0].r
 let po,bill,credit
 await check('Purchase order approval creates one commitment across retries',async()=>{
  po=await save('purchase_order','DEMO frame timber',{supplier:'Demo Timber',source_amount:1100,tax_basis:'inclusive',trade_id:2});const approved=await act(po);await act(po);po=approved
  assert.equal((await db.query('select * from job_cost_entries')).rows.length,1);assert.equal(Number((await db.query('select amount from job_cost_entries')).rows[0].amount),1000)
 })
 await check('Bill replaces outstanding commitment without double counting',async()=>{
  bill=await save('bill','DEMO partial timber invoice',{supplier:'Demo Timber',invoice_ref:'INV1',source_amount:440,tax_basis:'inclusive',po_id:po.id,release_amount:400});bill=await act(bill)
  assert.equal(Number((await db.query('select sum(amount) n from job_cost_entries')).rows[0].n),1000)
  assert.equal(Number((await db.query("select sum(amount) n from job_cost_entries where cost_kind='committed'")).rows[0].n),600)
 })
 await check('Duplicate invoice and oversized settlement roll back atomically',async()=>{
  const duplicate=await save('bill','Duplicate',{...bill.payload});await assert.rejects(()=>act(duplicate));
  const oversized=await save('bill','Too much',{...bill.payload,invoice_ref:'INV2',release_amount:601});await assert.rejects(()=>act(oversized));
  assert.equal(Number((await db.query('select sum(amount) n from job_cost_entries')).rows[0].n),1000)
 })
 await check('Signed credit preserves source amount and reduces actuals',async()=>{
  credit=await save('bill','DEMO supplier credit',{supplier:'Demo Timber',invoice_ref:'CR1',source_amount:-110,tax_basis:'inclusive',release_amount:0});credit=await act(credit)
  const cost=(await db.query('select * from job_cost_entries where id=$1',[credit.linked_id])).rows[0];assert.equal(Number(cost.amount),-100);assert.equal(cost.import_metadata.original_amount,-110)
 })
 await check('Hypothetical becomes only a draft variation, once',async()=>{
  const r=await save('selection','DEMO bathroom tile change',{room:'Bathroom'},{ready:true,proposed_charge:5280,email_draft:'AUD 5280 ex GST'});assert.equal((await db.query('select * from variations')).rows.length,0)
  await act(r);await act(r);const rows=(await db.query('select * from variations')).rows;assert.equal(rows.length,1);assert.equal(rows[0].status,'draft');assert.equal(Number(rows[0].amount),5280)
  assert.equal((await db.query('select is_current from quotes where id=$1',[q])).rows[0].is_current,true)
 })
 await check('Stale proposals, cross-tenant access and changed record kinds fail',async()=>{
  const r=await save('deadline','DEMO insurance',{due_on:'2026-10-01'});await db.query("update job_cost_entries set amount=amount+1 where id=$1",[credit.linked_id]);await assert.rejects(()=>act(r));await assert.rejects(()=>save('deadline','Forbidden',{}, {},id(),0,b));await assert.rejects(()=>save('bill','Changed',{}, {},r.id,r.version));await assert.rejects(()=>act(po,'confirm',b))
 })
 await check('Programme cannot complete with an unfinished dependency',async()=>{
  let dep=await save('programme','DEMO rough-in',{owner:'Sparky',dependencies:[]});dep=await act(dep);let r=await save('programme','DEMO plaster',{owner:'Plasterer',dependencies:[dep.id]});r=await act(r);await assert.rejects(()=>act(r,'complete'));await act(dep,'complete');await act(r,'complete')
 })
 await check('Drawing hashes detect renamed duplicates and replacements preserve facts for review',async()=>{
  await db.query('select finalise_job_upload($1,$2,$3,$4,100)',[a,j,f,'a'.repeat(64)]);await db.query("select reconcile_job_drawing($1,$2,$3,'add',null)",[a,j,f]);
  await db.query('select finalise_job_upload($1,$2,$3,$4,100)',[a,j,f2,'a'.repeat(64)]);assert.equal((await db.query('select drawing_state from files where id=$1',[f2])).rows[0].drawing_state,'duplicate')
  await db.query("select confirm_job_answer($1,$2,null,'Tile allowance','Supply only','Builder confirmed')",[a,j]);await db.query('select finalise_job_upload($1,$2,$3,$4,100)',[a,j,f3,'b'.repeat(64)]);await db.query("select reconcile_job_drawing($1,$2,$3,'replace',$4)",[a,j,f3,f]);
  const fact=(await db.query('select * from project_facts')).rows[0];assert.equal(fact.review_required,true);assert.equal(fact.value,'Supply only');await assert.rejects(()=>db.query("select prepare_estimate_refresh($1,$2,$3,'retain')",[a,j,id()]));await db.query("select confirm_job_answer($1,$2,$3,'','Supply only','Checked revision')",[a,j,fact.id])
 })
 await check('Refresh snapshots selected sources and preserves approved baseline on retries',async()=>{
  const request=id();const call=()=>db.query("select prepare_estimate_refresh($1,$2,$3,'retain') r",[a,j,request]);const run=(await call()).rows[0].r;assert.deepEqual(run.file_ids,[f3]);await call();assert.equal((await db.query('select * from estimate_source_sets')).rows.length,1);assert.equal((await db.query('select is_current from quotes where id=$1',[q])).rows[0].is_current,true);await assert.rejects(()=>db.query('select clear_generated_estimate($1,$2,$3)',[a,j,q]))
 })
 await check('Scope pack refuses missing specifications and wrong-job attachments',async()=>{
  const r=await save('scope_pack','DEMO plaster scope',{});await assert.rejects(()=>act(r));await assert.rejects(()=>save('scope_pack','Wrong file',{file_ids:[id()]}))
 })
 await check('Builder issue approval is separate from evidenced client approval; retries preserve one decision',async()=>{
  const v=(await db.query('select id from variations limit 1')).rows[0].id
  const decision=(action,date=null,evidence='')=>db.query('select record_variation_decision($1,$2,$3,$4,$5) r',[a,v,action,date,evidence])
  await assert.rejects(()=>decision('approved','2026-09-01','Client says yes by email'))
  await decision('builder_approved');assert.equal((await db.query('select status from variations where id=$1',[v])).rows[0].status,'draft')
  await assert.rejects(()=>decision('issued','2026-09-01',''))
  await decision('issued','2026-09-01','Proposal emailed to demo client');assert.equal((await db.query('select status from variations where id=$1',[v])).rows[0].status,'pending')
  await decision('approved','2026-09-02','Demo client written approval retained')
  const n=(await db.query("select count(*) n from proof_events where description='Variation approved'")).rows[0].n
  await decision('approved','2026-09-02','Demo client written approval retained');assert.equal((await db.query("select count(*) n from proof_events where description='Variation approved'")).rows[0].n,n)
  assert.equal((await db.query('select approval_evidence from variations where id=$1',[v])).rows[0].approval_evidence.date,'2026-09-02');await assert.rejects(()=>decision('rejected','2026-09-03','Trying to undo final approval'))
 })
 await check('Material transfer debits and credits owned jobs once and rejects a foreign destination',async()=>{
  const destination=id();await db.query('insert into jobs(id,builder_id)values($1,$2)',[destination,a])
  const r=await save('material_transfer','DEMO 12 lengths H3 pine',{to_job_id:destination,source_amount:220,tax_basis:'inclusive',evidence:'12 lengths from Demo Timber; source invoice retained'})
  const before=Number((await db.query('select sum(amount) n from job_cost_entries')).rows[0].n);await act(r);await act(r)
  assert.equal(Number((await db.query('select sum(amount) n from job_cost_entries')).rows[0].n),before);assert.equal(Number((await db.query('select sum(amount) n from job_cost_entries where job_id=$1',[destination])).rows[0].n),200)
  const bad=await save('material_transfer','Foreign destination',{...r.payload,to_job_id:k});await assert.rejects(()=>act(bad))
 })
 await check('Credit imports preserve signed labour values and duplicate imports cannot add costs twice',async()=>{
  const rows=[{description:'DEMO credit',amount:-110,labour_cost:-10,labour_hours:null,source_row:2,incurred_on:'2026-09-01'}]
  const call=()=>db.query("select import_profitability_costs($1,$2,'credit-fixture','demo-credit.csv','{}',$3)",[a,j,JSON.stringify(rows)])
  await call();await assert.rejects(call);const row=(await db.query("select amount,labour_cost from job_cost_entries where description='DEMO credit'")).rows[0];assert.equal(Number(row.amount),-110);assert.equal(Number(row.labour_cost),-10)
 })
 await check('Accepted trade quote replaces only reviewed draft items once and preserves approved quotes',async()=>{
  const draft=id(),item1=id(),item2=id();await db.query("insert into quotes(id,job_id,builder_id,status)values($1,$2,$3,'draft')",[draft,j,a])
  await db.query("insert into quote_line_items(id,quote_id,trade_category_id,description,total)values($1,$3,6,'Plaster labour',1000),($2,$3,6,'Plaster board',500)",[item1,item2,draft])
  let r=await save('trade_quote','DEMO plasterer accepted quote',{supplier:'Demo Plaster',source_amount:2200,tax_basis:'inclusive',trade_id:6});r=await act(r)
  const call=(quote=draft)=>db.query('select apply_job_trade_quote($1,$2,$3,$4,$5,$6)',[a,j,r.id,quote,[item1,item2],r.version])
  await assert.rejects(()=>call(q));await call();await call();const rows=(await db.query('select total,assumption_status from quote_line_items where quote_id=$1',[draft])).rows
  assert.equal(rows.filter(r=>r.assumption_status!=='excluded').reduce((sum,r)=>sum+Number(r.total),0),2000);assert.equal((await db.query('select status from quotes where id=$1',[q])).rows[0].status,'approved')
 })
 await check('Programme revisions retain the original and reject competing stale revisions',async()=>{
  let original=await save('programme','DEMO plaster week',{owner:'Plasterer'});original=await act(original)
  const replacement=await save('programme','DEMO plaster revised dates',{replaces_record_id:original.id,replaces_version:original.version,owner:'Plasterer'});await act(replacement)
  assert.equal((await db.query('select status from job_workflow_records where id=$1',[original.id])).rows[0].status,'superseded')
  const stale=await save('programme','Competing revision',{replaces_record_id:original.id,replaces_version:original.version,owner:'Plasterer'});await assert.rejects(()=>act(stale))
 })
 await check('Browser and anon cannot mutate operational records or call privileged actions',async()=>{
  for(const role of ['authenticated','anon']){await db.exec(`reset role;set role ${role}`);await assert.rejects(()=>db.query("update job_workflow_records set title='bad'"));await assert.rejects(()=>db.query("select reconcile_job_drawing($1,$2,$3,'add',null)",[a,j,f]));}
  await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[b]);assert.equal((await db.query('select * from job_workflow_records')).rows.length,0)
 })
 await db.close();console.log(JSON.stringify({passed:checks.length,checks},null,2))
}
main().catch(e=>{console.error(e);process.exit(1)})
