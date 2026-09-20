import test from 'node:test'
import assert from 'node:assert/strict'
import {isOpenJob} from './job-status.ts'
import {todayOperations} from './today.ts'
test('only recognised open statuses contribute to open work',()=>{for(const s of ['quoting','quoted','active'])assert.equal(isOpenJob(s),true);for(const s of ['complete','completed','archived','cancelled','unexpected'])assert.equal(isOpenJob(s),false)})
test('completed jobs stop quote chasing but retain overdue invoice collection',()=>{const r=todayOperations([{id:'j',address:'Finished job',status:'complete'}],[{id:'i',job_id:'j',amount:100,status:'sent',due_date:'2026-01-01'}],[],'2026-09-20',[{job_id:'j',status:'sent',sent_at:'2026-01-01',version:1}]);assert.equal(r.exceptions.some(e=>e.id==='j:quote'),false);assert.equal(r.exceptions.some(e=>e.id==='j:invoices'),true)})
