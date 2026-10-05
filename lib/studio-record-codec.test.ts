import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {encodeStoredRecord,decodeStoredRecord} from './studio-record-codec.ts'

test('drawing-heavy revisions round trip without repeating image bytes',()=>{
 const image='data:image/jpeg;base64,'+randomBytes(500000).toString('base64')
 const workspace={plan:{image},drawings:[{image}],project:{id:'test',baseline:{note:'Protected'},variations:[]}}
 const record:any={version:11,workspace,history:Array.from({length:10},(_,i)=>({at:String(i),workspace:structuredClone(workspace)}))}
 const packed=encodeStoredRecord(record)
 assert.ok(JSON.stringify(packed).length<JSON.stringify(record).length/10)
 assert.deepEqual(decodeStoredRecord(packed),record)
 assert.equal(typeof record.workspace.plan.image,'string')
})
test('legacy records remain readable and corrupt encodings fail closed',()=>{
 const record:any={version:1,workspace:{name:'Original'},history:[]}
 assert.equal(decodeStoredRecord(record),record)
 const packed=encodeStoredRecord(record)
 assert.throws(()=>decodeStoredRecord({...packed,version:2}))
 assert.throws(()=>decodeStoredRecord({...packed,payload:'broken'}))
 assert.throws(()=>decodeStoredRecord({encoding:'future'}))
})
