import test from 'node:test'
import assert from 'node:assert/strict'
import {loginDestination,recoveryIdentity} from './studio-access.ts'
test('sign-in keeps an internal destination and rejects external or executable redirects',()=>{
 assert.equal(loginDestination('/studio?view=plan'),'/studio?view=plan')
 for(const input of [null,'https://evil.test','//evil.test','/\\evil.test','javascript:alert(1)','/\nevil'])assert.equal(loginDestination(input),'/studio')
})
test('recovery can only be scoped to an authenticated identifier or explicit local account',()=>{
 assert.equal(recoveryIdentity('local-builder'),'local-builder')
 assert.equal(recoveryIdentity('11111111-1111-4111-8111-111111111111'),'11111111-1111-4111-8111-111111111111')
 for(const v of ['', 'anonymous','../latest'])assert.throws(()=>recoveryIdentity(v))
})
