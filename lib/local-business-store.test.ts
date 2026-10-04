import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {localBusinessStore} from './local-business-store.ts'
import {EMPTY_PROFILE} from './profitability.ts'
test('local business data persists, rejects stale writes and separates profile from cash',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'worka-business-')),store=localBusinessStore(directory)
 const first=await store.read();assert.equal(first.plan,null)
 const profile={...EMPTY_PROFILE,targetRevenue:1000000,annualOverhead:150000,netProfitPct:10}
 const a=await store.write('profile',profile,null)
 const plan={version:1,startOn:'2026-10-03',opening:10000,buffer:5000,accounts:'Test account',complete:false,entries:[]}
 const b=await store.write('cash',plan,null);assert.deepEqual(b.profile,profile)
 assert.deepEqual((await localBusinessStore(directory).read()).plan,plan)
 await assert.rejects(store.write('profile',profile,null),/changed/)
 await assert.rejects(store.write('cash',{...plan,opening:NaN},b.cashRevision),/valid/)
 const results=await Promise.allSettled([store.write('profile',{...profile,targetRevenue:1100000},a.profileRevision),store.write('profile',{...profile,targetRevenue:1200000},a.profileRevision)])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(JSON.parse(await readFile(path.join(directory,'business.json'),'utf8')).plan,plan)
})
