import test from 'node:test'
import assert from 'node:assert/strict'
import {recognisedSet} from './studio-set-recognition.ts'
import {resumableModelDraft} from './studio-model-progress.ts'
test('an empty AI response retains its actionable missing-document explanation',()=>{
 assert.throws(()=>recognisedSet({floors:[],warnings:['Include wall location plan CD-500 and window schedule CD-600.']},[]),/CD-500 and window schedule CD-600/)
 assert.equal(resumableModelDraft({floors:[]}),false)
})
test('malformed warnings cannot hide the standard next step or expand an error without bounds',()=>{
 assert.throws(()=>recognisedSet({floors:[],warnings:[null,{},'x'.repeat(1001)]},[]),/Choose the floor-plan page/)
 assert.throws(()=>recognisedSet({floors:[],warnings:['one','two','three','four']},[]),(e:unknown)=>e instanceof Error&&e.message.includes('one two three')&&!e.message.includes('four'))
})
