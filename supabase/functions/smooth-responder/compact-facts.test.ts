import {test} from 'node:test'
import assert from 'node:assert/strict'
import {expandCompactFacts, hasDenseText} from './compact-facts.ts'
test('compact schedule preserves products, unpriced selections and exact provenance',()=>{
 const rows=expandCompactFacts([[0,'fixtures','tap','Brand X tap; 2 units; price unknown','p2 row3','Tap row',90]],1)
 assert.equal(rows[0].value,'Brand X tap; 2 units; price unknown')
 assert.equal(rows[0].page_reference,'p2 row3')
 assert.equal(rows[0].source_file_index,0)
})
test('partial or wrong-document results fail before any persistence',()=>{
 for(const r of [null,[[0,'fixtures']],[[2,'fixtures','tap','x',null,'row',90]],[[0,'fixtures','tap','x',null,'',90]]]) assert.throws(()=>expandCompactFacts(r,1))
})

test('dense schedules are isolated before a predictably oversized grouped call',()=>{
 assert.equal(hasDenseText({type:'text',text:'x'.repeat(16000)}),true)
 assert.equal(hasDenseText([{type:'text',text:'x'.repeat(9000)},{type:'text',text:'x'.repeat(9000)}]),true)
 assert.equal(hasDenseText({type:'text',text:'short'}),false)
 assert.equal(hasDenseText({type:'document',source:{data:'x'.repeat(20000)}}),false)
})

test('qualitative confidence is conservatively normalized without losing valid rows',()=>{
 const r=expandCompactFacts([[0,'materials','tile','Tile A; price unknown','p2','Row A','high'],[0,'materials','paint','Paint B',null,'Row B','medium']],1)
 assert.equal(r.length,2)
 assert.equal(r[0].confidence,80)
 assert.equal(r[1].confidence,50)
 assert.throws(()=>expandCompactFacts([[0,'materials','x','x',null,'row','certain']],1))
})

test('fractional and percentage confidence are normalized without accepting out-of-range values',()=>{
 for(const [input,expected] of [[0.98,98],['0.95',95],[85,85],['80',80]]) assert.equal(expandCompactFacts([[0,'fixtures','tap','x',null,'row',input]],1)[0].confidence,expected)
 for(const input of [-1,101,null,'certain']) assert.throws(()=>expandCompactFacts([[0,'fixtures','tap','x',null,'row',input]],1))
})
