import test from 'node:test'
import assert from 'node:assert/strict'
import {action,dueActions,nextActions,recordSent,studioAction,testJob} from './brief-actions.ts'
import {assembleBriefActions,loadBriefActions} from './brief-source.ts'
import {newWorkspace} from './studio-workspace.ts'
import {deliverBrief} from './brief-delivery.ts'
import type {BriefDeliveryState,BriefPending} from './brief-delivery.ts'
import {rectangleGeometry} from './studio-geometry.ts'
import {newScopeReview} from './studio-scope.ts'
import {defaultProjectTiming} from './studio-cash-forecast.ts'

const now=new Date('2026-10-05T00:00:00Z')
const make=(key='a',jobKey='job:a',priority:'medium'|'high'='medium',state:unknown='v1')=>action({key,jobKey,jobName:'Alfred Street',priority,message:'Confirm excavation.',action:'Review',href:'/jobs/abc'},state)
test('test jobs excluded without hiding real addresses containing similar words',()=>{
 for(const name of ['TEST ONLY — Kaspr Worka readiness','QA — live workflow check','Demo project','Synthetic test only','Sample house'])assert.equal(testJob(name),true,name)
 for(const name of ['12 Test Street','Testament House','Demolition at Alfred','McCann'])assert.equal(testJob(name),false,name)
 const w=newWorkspace();w.demo=true;assert.equal(studioAction(w),null)
})
test('one next step per job, urgent first, no lower-priority daily drip',()=>{
 const high=make('invoice','job:a','high'),low=make('quote')
 assert.deepEqual(nextActions([low,high]),[high])
 const sent=recordSent({},[low,high],[high],now)
 assert.deepEqual(dueActions([low,high],sent,new Date('2026-10-06')),[])
 assert.equal(dueActions([high],sent,new Date('2026-10-12')).length,1)
 assert.equal(dueActions([make('invoice','job:a','high','v2')],sent,now).length,1)
})
test('only delivered actions are remembered; resolved actions are removed',()=>{
 const all=Array.from({length:8},(_,i)=>make(String(i),'job:'+i)),due=dueActions(all,{},now)
 assert.equal(due.length,5)
 const saved=recordSent({},all,due,now)
 assert.equal(dueActions(all,saved,now).length,3)
 assert.deepEqual(recordSent(saved,[],[],now),{})
 assert.equal(make('a','a','medium',{a:1,b:2}).fingerprint,make('a','a','medium',{b:2,a:1}).fingerprint)
})
test('legacy drafts become practical prompts; excluded and test jobs stay out',()=>{
 const data={jobs:[{id:'real',address:'1234 Smith Street',status:'quoting'},{id:'test',address:'TEST ONLY — Readiness',status:'quoting'}],quotes:['real','test'].map(job_id=>({id:job_id,job_id,status:'draft',quote_line_items:[{id:'1',description:'Excavation',total:null,rate:null},{id:'2',description:'Lift',total:null,rate:null,assumption_status:'excluded'}]})),invoices:[],variations:[],studios:[]}
 const result=assembleBriefActions(data,now,'2026-10-05')
 assert.equal(result.length,1);assert.match(result[0].message,/Confirm the price for Excavation/);assert.doesNotMatch(result[0].message,/assumptions|Lift/)
})
test('becoming overdue is new evidence; passing another day is not',()=>{
 const data={jobs:[{id:'j',address:'Alfred',status:'active'}],quotes:[],invoices:[{id:'i',job_id:'j',amount:100,status:'sent',due_date:'2026-10-05'}],variations:[],studios:[]}
 const due=assembleBriefActions(data,now,'2026-10-05')[0],over=assembleBriefActions(data,now,'2026-10-06')[0],older=assembleBriefActions(data,now,'2026-10-07')[0]
 assert.notEqual(due.fingerprint,over.fingerprint);assert.equal(over.fingerprint,older.fingerprint)
})
test('unverified Studio work never claims a reliable variation value',()=>{
 const w=newWorkspace();w.name='McCann';w.project.baseline=structuredClone(w.project.working);w.project.working.markup=30
 const next=studioAction(w)!
 assert.match(next.message,/Upload/);assert.doesNotMatch(next.message,/\$/)
 assert.match(next.href!,new RegExp('project='+w.project.id))
})
test('reviewed variation reconciles price, profit and scenario cash without changing accepted scope',()=>{
 const w=newWorkspace();w.name='Alfred Street'
 w.project.working.design.geometry=rectangleGeometry(8,6,2.7);w.project.working.design.geometry.verified=true
 w.project.working.lines=[{id:'floor',name:'Floor finish',trade:'Interiors',unit:'item',source:'entered',quantity:1,rate:100,rateVerified:true,included:true,allowance:false,note:'Confirmed test scope'}]
 w.scopeReview=newScopeReview();w.scopeReview.kind='new-build';w.scopeReview.documents=[{name:'Floor plan',pages:1,revision:'A',status:'current',note:''}]
 w.scopeReview.items=w.scopeReview.items.map(i=>({...i,status:i.key==='finishes'?'included':'excluded',note:'Reviewed test scope',lineIds:i.key==='finishes'?['floor']:[]}))
 w.project.baseline=structuredClone(w.project.working);w.project.working.lines[0].rate=80
 w.cashTiming={...defaultProjectTiming('2026-10-05'),costGstPercent:10}
 const before=JSON.stringify(w),next=studioAction(w)!
 assert.match(next.message,/client price −\$27.50 including GST/)
 assert.match(next.message,/gross profit −\$5.00 excluding GST/)
 assert.match(next.message,/receipts −\$27.50; payments −\$22.00/)
 assert.match(next.href!,/view=financials/);assert.equal(JSON.stringify(w),before)
 w.project.working.lines[0].rateVerified=false
 assert.doesNotMatch(studioAction(w)!.message,/\$/)
})
test('every source query has owner isolation and no Studio images or history',async()=>{
 const seen:{table:string;select:string;filters:[string,unknown][]}[]=[]
 const db={from(table:string){const entry={table,select:'',filters:[] as [string,unknown][]};seen.push(entry);const q:any={select(s:string){entry.select=s;return q},eq(k:string,v:unknown){entry.filters.push([k,v]);return q},in(){return q},not(){return q},lte(){return q},order(){return q},range(){return Promise.resolve({data:[],error:null})}};return q}}
 await loadBriefActions(db as any,'builder-a',now)
 assert.equal(seen.length,5)
 for(const q of seen)assert.ok(q.filters.some(([key,value])=>key===(q.table==='studio_workspaces'?'owner_id':'builder_id')&&value==='builder-a'))
 const projection=seen.find(q=>q.table==='studio_workspaces')!.select
 assert.doesNotMatch(projection,/image|history|\*/);assert.match(projection,/document->workspace->project/)
})
test('failed source read stops generation rather than sending partial all-clear',async()=>{
 const db={from(){const q:any={select(){return q},eq(){return q},in(){return q},not(){return q},lte(){return q},order(){return q},range(){return Promise.resolve({data:null,error:new Error('offline')})}};return q}}
 await assert.rejects(loadBriefActions(db as any,'builder',now),/offline/)
})
test('outbox retries exactly the same email, then suppresses next-day duplicates',async()=>{
 let state:BriefDeliveryState={sent:{},pending:null},succeed=false
 const messages:BriefPending[]=[]
 const io={claim:async()=>structuredClone(state),save:async(s:BriefDeliveryState)=>{state=structuredClone(s)},release:async()=>{},send:async(p:BriefPending)=>{messages.push(p);return succeed}}
 const builder={name:'Chris',email:'synthetic@example.invalid'}
 assert.equal(await deliverBrief(io,builder,[make()],now),'failed')
 assert.deepEqual(state.sent,{})
 succeed=true
 assert.equal(await deliverBrief(io,builder,[make('a','job:a','medium','changed')],new Date(now.getTime()+1000)),'sent')
 assert.deepEqual(messages[0],messages[1])
 assert.equal(await deliverBrief(io,builder,[make()],new Date(now.getTime()+86400000)),'quiet')
})
test('concurrent claim loss never sends; uncertain expired delivery fails closed',async()=>{
 let sends=0
 const io={claim:async()=>null,save:async()=>{},release:async()=>{},send:async()=>{sends++;return true}}
 assert.equal(await deliverBrief(io,{name:'Chris',email:'x'},[make()],now),'busy');assert.equal(sends,0)
 const pending={id:'old',createdAt:'2026-10-03',to:'x',email:{subject:'',text:'',html:''},actions:[make()]}
 await assert.rejects(deliverBrief({...io,claim:async()=>({sent:{},pending})},{name:'Chris',email:'x'},[make()],now),/reconciliation/)
 assert.equal(sends,0)
})
