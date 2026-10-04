import test from 'node:test'
import assert from 'node:assert/strict'
import {decodeRecovery,encodeRecovery,recoveryConflicts} from './studio-recovery-version.ts'
import {newWorkspace} from './studio-workspace.ts'
test('unsaved edits can resume only against the saved version they were based on',()=>{const w=newWorkspace(),saved={workspace:w,version:4,history:[]},edited={...w,name:'Unsaved edit'},r=decodeRecovery(encodeRecovery(edited,4))!;assert.equal(recoveryConflicts(r,saved),false);assert.equal(recoveryConflicts(r,{...saved,version:5,workspace:{...w,name:'Other device edit'}}),true)})
test('legacy recovery cannot overwrite newer server work, but identical recovery is safe',()=>{const w=newWorkspace(),saved={workspace:w,version:7,history:[]};assert.equal(recoveryConflicts(decodeRecovery(JSON.stringify(w))!,saved),false);assert.equal(recoveryConflicts(decodeRecovery(JSON.stringify({...w,name:'Old work'}))!,saved),true);assert.equal(decodeRecovery('bad data'),null)})
