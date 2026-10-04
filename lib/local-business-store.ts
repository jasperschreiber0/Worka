import {mkdir,readFile,writeFile,rename} from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {EMPTY_PROFILE,financialProfile} from './profitability.ts'
import type {FinancialProfile} from './profitability.ts'
import {validateCashPlan} from './cash-plan.ts'
import type {CashPlan} from './cash-plan.ts'
type RecordData={profile:FinancialProfile;profileRevision:string|null;plan:CashPlan|null;cashRevision:string|null}
const state=globalThis as typeof globalThis & {businessWrites?:Map<string,Promise<unknown>>}
export class BusinessStoreError extends Error{status:number;constructor(message:string,status=400){super(message);this.status=status}}
export function localBusinessStore(directory=path.join(process.cwd(),'.worka-studio')){
 const file=path.join(directory,'business.json')
 async function read():Promise<RecordData>{try{return JSON.parse(await readFile(file,'utf8'))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {profile:structuredClone(EMPTY_PROFILE),profileRevision:null,plan:null,cashRevision:null};throw new BusinessStoreError('Saved business figures could not be read. Nothing was overwritten.',500)}}
 async function write(kind:'profile'|'cash',input:unknown,revision:unknown){
  state.businessWrites??=new Map()
  const run=(state.businessWrites.get(file)||Promise.resolve()).catch(()=>{}).then(async()=>{
   const data=await read(),key=kind==='profile'?'profileRevision':'cashRevision'
   if(revision!==data[key])throw new BusinessStoreError('These figures changed in another window. Reload before saving.',409)
   if(kind==='profile'){financialProfile(input as FinancialProfile);data.profile=structuredClone(input as FinancialProfile)}else data.plan=validateCashPlan(input)
   data[key]=new Date(Math.max(Date.now(),Date.parse(data[key]||'')+1||0)).toISOString()
   await mkdir(directory,{recursive:true});const temp=path.join(directory,randomUUID()+'.tmp');await writeFile(temp,JSON.stringify(data),'utf8');await rename(temp,file);return data
  });state.businessWrites.set(file,run);return run
 }
 return {read,write}
}
