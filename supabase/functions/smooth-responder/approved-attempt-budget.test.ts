import {test} from 'node:test'
import assert from 'node:assert/strict'
import {approvedAttemptCeiling} from './approved-attempt-budget.ts'
test('only an exact server-authorized job and batch receive 30 total attempts',()=>{
 const s={job_id:'job',approved_batch_id:'batch',approved_total_attempts:30}
 assert.equal(approvedAttemptCeiling(s,'job','batch'),30)
 for(const x of [null,{}, {...s,job_id:'other'},{...s,approved_batch_id:'other'},{...s,approved_total_attempts:'30'},{...s,approved_total_attempts:100}]) assert.equal(approvedAttemptCeiling(x,'job','batch'),20)
})
