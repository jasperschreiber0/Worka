import {test} from 'node:test'
import assert from 'node:assert/strict'
import {expandCompactFacts} from './compact-facts.ts'
test('compact schedule preserves products, unpriced selections and exact provenance',()=>{
 const rows=expandCompactFacts([[0,'fixtures','tap','Brand X tap; 2 units; price unknown','p2 row3','Tap row',90]],1)
 assert.equal(rows[0].value,'Brand X tap; 2 units; price unknown')
 assert.equal(rows[0].page_reference,'p2 row3')
 assert.equal(rows[0].source_file_index,0)
})
test('partial or wrong-document results fail before any persistence',()=>{
 for(const r of [null,[[0,'fixtures']],[[2,'fixtures','tap','x',null,'row',90]],[[0,'fixtures','tap','x',null,'',90]]]) assert.throws(()=>expandCompactFacts(r,1))
})
