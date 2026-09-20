import test from 'node:test'
import assert from 'node:assert/strict'
import { todayOperations, rankTodayExceptions, targetMarkup } from './today.ts'

test('pricing target converts margin to markup without rounding down to 35%', () => {
  assert.equal(targetMarkup(26.3)?.toFixed(1), '35.7')
  assert.equal(targetMarkup(0), 0)
  for (const n of [null, 100, -1, NaN, Infinity]) assert.equal(targetMarkup(n), null)
})
test('Today counts only active jobs and genuinely overdue, owned issued invoices', () => {
  const jobs = [{ id:'a', address:'A', status:'active' },{ id:'b', address:'B', status:'quoting' }]
  const invoice = { id:'1', job_id:'a', amount:100, status:'sent', due_date:'2026-09-01' }
  const result = todayOperations(jobs, [invoice, {...invoice,id:'2',status:'paid'}, {...invoice,id:'3',status:'draft'}, {...invoice,id:'4',job_id:'foreign'}, {...invoice,id:'5',due_date:'2026-09-20'}],
    [{id:'v',job_id:'a',amount:999,status:'pending'},{id:'w',job_id:'a',amount:888,status:'approved'}], '2026-09-20')
  assert.equal(result.activeJobs,1)
  assert.equal(result.overdueCount,1)
  assert.equal(result.overdueTotal,100)
  assert.equal(result.pendingCount,1)
  assert.equal(result.exceptions.length,3)
  assert.equal(result.exceptions[1].impact,undefined)
})
test('existing due, latest-quote and claim reminders remain evidence-based',()=>{
  const jobs=[{id:'a',address:'A',status:'active'}]
  const quotes=[{job_id:'a',status:'sent',sent_at:'2026-09-01T00:00:00Z',version:1},{job_id:'a',status:'approved',sent_at:'2026-09-02T00:00:00Z',version:2}]
  const claims=[{job_id:'a',invoice_id:null,label:'Frame'},{job_id:'a',invoice_id:'paid',label:'Deposit'},{job_id:'foreign',invoice_id:null,label:'Other'}]
  const r=todayOperations(jobs,[],[],'2026-09-20',quotes,claims)
  assert.deepEqual(r.exceptions.map(e=>e.id),['a:claims'])
  assert.match(r.exceptions[0].detail,/Check stage completion/)
  const sent=todayOperations(jobs,[],[],'2026-09-20',quotes.slice(0,1),[])
  assert.equal(sent.exceptions[0].id,'a:quote')
})
test('attention is deduplicated and sorted by urgency, age, then known impact', () => {
  const base = {priority:1,title:'Review',detail:'Evidence',href:'/jobs',action:'Open'}
  const rows = [{...base,id:'small',impact:1},{...base,id:'large',impact:200},{...base,id:'dated',dueOn:'2026-01-01'}, {...base,id:'later',priority:3,impact:999}]
  assert.deepEqual(rankTodayExceptions([...rows,rows[0]]).map(r=>r.id),['dated','large','small','later'])
})
test('margin leakage and below-target warnings combine without hiding independent actions', () => {
  const base={priority:1,title:'Review',detail:'Evidence',href:'/jobs',action:'Open'}
  const source=[{...base,id:'job:leakage'},{...base,id:'job:margin',detail:'Below target'},{...base,id:'job:invoices'}]
  const result=rankTodayExceptions(source)
  assert.equal(result.length,2)
  assert.equal(result.find(r=>r.id==='job:leakage')?.detail,'Evidence Below target')
  assert.equal(source[0].detail,'Evidence')
})
