import test from 'node:test'
import assert from 'node:assert/strict'
import {readBrowserRecovery,writeBrowserRecovery,legacyRecoveryKey} from './studio-browser-recovery.ts'

test('large drawings recover, writes stay ordered, and a newer fallback survives an IndexedDB write failure',async()=>{
 const stored=new Map<string,unknown>();let fail=false;const local=new Map<string,string>()
 const oldDb=Object.getOwnPropertyDescriptor(globalThis,'indexedDB'),oldLocal=Object.getOwnPropertyDescriptor(globalThis,'localStorage')
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>local.get(k)||null,setItem:(k:string,v:string)=>local.set(k,v),removeItem:(k:string)=>local.delete(k)}})
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){const request:any={result:{transaction(){const tx:any={objectStore:()=>({get(key:string){const r:any={};queueMicrotask(()=>{r.result=stored.get(key);r.onsuccess()});return r},put(value:unknown,key:string){queueMicrotask(()=>{if(fail){tx.error=new Error('Disk unavailable');tx.onerror()}else{stored.set(key,value);tx.oncomplete()}})}})};return tx}}};queueMicrotask(()=>request.onsuccess());return request}}})
 try{
  local.set(legacyRecoveryKey,'legacy');assert.equal(await readBrowserRecovery(),'legacy')
  const large='drawing'.repeat(900000);await writeBrowserRecovery(large);assert.equal(await readBrowserRecovery(),large);assert.equal(local.has(legacyRecoveryKey),false)
  await Promise.all([writeBrowserRecovery('first'),writeBrowserRecovery('latest')]);assert.equal(await readBrowserRecovery(),'latest')
  fail=true;await writeBrowserRecovery('newest fallback');assert.equal(await readBrowserRecovery(),'newest fallback')
  const ownerA='11111111-1111-4111-8111-111111111111',ownerB='22222222-2222-4222-8222-222222222222'
  fail=false;await writeBrowserRecovery('private A',ownerA);assert.equal(await readBrowserRecovery(ownerB),null);assert.equal(await readBrowserRecovery(ownerA),'private A');assert.equal(await readBrowserRecovery(),'newest fallback')
  await writeBrowserRecovery('private B',ownerB);assert.equal(await readBrowserRecovery(ownerA),'private A')
  fail=false;await writeBrowserRecovery('restored database');assert.equal(await readBrowserRecovery(),'restored database');assert.equal(local.has(legacyRecoveryKey),false)
 }finally{if(oldDb)Object.defineProperty(globalThis,'indexedDB',oldDb);else delete (globalThis as any).indexedDB;if(oldLocal)Object.defineProperty(globalThis,'localStorage',oldLocal);else delete (globalThis as any).localStorage}
})
