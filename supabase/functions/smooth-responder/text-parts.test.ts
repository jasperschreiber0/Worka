import {test} from 'node:test'
import assert from 'node:assert/strict'
import {splitTextParts,combinePartResults} from './text-parts.ts'
test('all source characters survive bounded overlapping parts',()=>{
 const text=Array.from({length:3000},(_,i)=>'row '+i+' product and price\n').join('')
 const parts=splitTextParts(text)
 assert.ok(parts.every(p=>p.length<=12000))
 let joined=parts[0]
 for(const part of parts.slice(1)) joined+=part.slice(300)
 assert.equal(joined,text)
})
test('one saved part never marks a three-part document complete',()=>{
 const payload={documents:[{file_index:0}],facts:[{category:'fixtures',key:'tap',value:'price unknown'}]}
 assert.equal(combinePartResults([{part_index:0,payload}],3),null)
 assert.equal(combinePartResults([{part_index:0,payload},{part_index:0,payload}],2),null)
 const all=combinePartResults([0,1,2].map(part_index=>({part_index,payload})),3)
 assert.equal(all.documents.length,1)
 assert.equal(all.facts.length,1)
})
