import {recoveryIdentity} from './studio-access.ts'
const database='worka-recovery',store='workspaces'
const recoveryKeys=(owner:string)=>{recoveryIdentity(owner);return {key:owner==='local-builder'?'latest':'owner:'+owner,localKey:owner==='local-builder'?legacyRecoveryKey:legacyRecoveryKey+'.'+owner}}
export const legacyRecoveryKey='worka.studio.workspace.recovery.v2'
let connection:Promise<IDBDatabase>|undefined
function open(){
 if(!connection)connection=new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open(database,1)
  request.onupgradeneeded=()=>request.result.createObjectStore(store)
  request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();connection=undefined};resolve(request.result)}
  request.onerror=()=>{connection=undefined;reject(request.error)}
  request.onblocked=()=>{connection=undefined;reject(new Error('Browser recovery is busy in another tab.'))}
 })
 return connection
}
function unpack(value:unknown):{snapshot:string;savedAt:number}|null {
 if(typeof value==='string'){try{const parsed=JSON.parse(value);if(typeof parsed.snapshot==='string'&&Number.isFinite(parsed.savedAt))return parsed}catch{}return {snapshot:value,savedAt:0}}
 if(value&&typeof value==='object'&&'snapshot' in value&&typeof value.snapshot==='string'&&'savedAt' in value&&typeof value.savedAt==='number')return {snapshot:value.snapshot,savedAt:value.savedAt}
 return null
}
export async function readBrowserRecovery(owner='local-builder'):Promise<string|null>{
 const {key,localKey}=recoveryKeys(owner)
 let local:ReturnType<typeof unpack>=null,stored:ReturnType<typeof unpack>=null
 try{local=unpack(localStorage.getItem(localKey))}catch{}
 try{
  const db=await open()
  stored=unpack(await new Promise<unknown>((resolve,reject)=>{const tx=db.transaction(store,'readonly'),r=tx.objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)}))
 }catch{/* A local fallback may be newer when IndexedDB was unavailable. */}
 return (local&&(!stored||local.savedAt>=stored.savedAt)?local:stored)?.snapshot||null
}
// Serialize writes so a slower earlier snapshot cannot replace a newer edit.
let pending:Promise<void>=Promise.resolve()
export function writeBrowserRecovery(snapshot:string,owner='local-builder'):Promise<void>{
 const {key,localKey}=recoveryKeys(owner)
 const next=pending.catch(()=>{}).then(async()=>{
  const record={snapshot,savedAt:Date.now()}
  try{
   const db=await open()
   await new Promise<void>((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(record,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Recovery save interrupted.'))})
   try{localStorage.removeItem(localKey)}catch{}
  }catch{localStorage.setItem(localKey,JSON.stringify(record))}
 })
 pending=next;return next
}
