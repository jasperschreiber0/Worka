import test from 'node:test'
import assert from 'node:assert/strict'
import {stableJson,matchesJson} from './studio-json.ts'
import {newWorkspace} from './studio-workspace.ts'
import {recoveryConflicts} from './studio-recovery-version.ts'

test('JSONB field ordering cannot turn unchanged model content into a revision conflict', () => {
  const model={width:8,depth:6,geometry:{walls:[{id:'a',height:2.7},{id:'b',height:3}]}}
  const stored={geometry:{walls:[{height:2.7,id:'a'},{height:3,id:'b'}]},depth:6,width:8}
  assert.ok(matchesJson(stored,JSON.stringify(model)))
  assert.equal(stableJson(model),stableJson(stored))
  assert.equal(matchesJson(stored,JSON.stringify({...model,width:9})),false)
  assert.equal(matchesJson(stored,'invalid'),false)
  assert.equal(matchesJson(stored,JSON.stringify({...model,geometry:{walls:[...model.geometry.walls].reverse()}})),false)
})

test('reordered saved workspace does not require recovery or discard; real edits still do', () => {
  const w=newWorkspace(),stored=JSON.parse(stableJson(w))
  assert.equal(recoveryConflicts({workspace:w,baseVersion:1},{workspace:stored,version:2,history:[]}),false)
  assert.equal(recoveryConflicts({workspace:{...w,name:'Changed'},baseVersion:1},{workspace:stored,version:2,history:[]}),true)
})

test('optional undefined fields follow JSON persistence while typed values remain distinct', () => {
  assert.equal(stableJson({x:1,optional:undefined}),stableJson({x:1}))
  assert.notEqual(stableJson({x:1}),stableJson({x:'1'}))
  assert.notEqual(stableJson(undefined),stableJson(null))
})
