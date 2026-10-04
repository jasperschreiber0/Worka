import test from 'node:test'
import assert from 'node:assert/strict'
import {drawingFingerprint,validModelProgress} from './studio-model-progress.ts'
import {newWorkspace,parseWorkspace,clientProjection} from './studio-workspace.ts'
test('only the exact drawing set, scale and revision can resume its previous draft',async()=>{
 const pages:any=[{name:'Plan',image:'image',page:1,metresPerUnit:.02,revision:'A'}]
 const original=await drawingFingerprint(pages)
 assert.equal(original,await drawingFingerprint(structuredClone(pages)))
 for(const patch of [{metresPerUnit:.03},{revision:'B'},{image:'changed pixels'},{page:2}])assert.notEqual(original,await drawingFingerprint([{...pages[0],...patch}]))
})
test('rejected drafts round trip privately without becoming accepted geometry',async()=>{
 const w=newWorkspace();w.modelProgress={source:await drawingFingerprint([]),at:new Date().toISOString(),error:'Opening needs correction',draft:{floors:[{name:'Ground'}]}}
 assert.ok(parseWorkspace(JSON.stringify(w)));assert.equal(w.project.working.design.geometry,undefined);assert.equal(JSON.stringify(clientProjection(w)).includes('Opening needs correction'),false)
 assert.equal(validModelProgress({...w.modelProgress,draft:{floors:[]}}),false)
 assert.equal(validModelProgress({...w.modelProgress,draft:{floors:[{}],payload:'x'.repeat(200001)}}),false)
})
