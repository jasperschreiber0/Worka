import { cookies } from 'next/headers'
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import { createClient } from '@supabase/supabase-js'
import { mkdir,readFile,writeFile,rename } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID,createHash } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { parseWorkspace } from './studio-workspace'
import type { StoredWorkspace,Workspace,ClientProjection } from './studio-workspace'
import {isStudioOrigin} from './studio-origin'

const directory=path.join(process.cwd(),'.worka-studio')
export const localMode=()=>process.env.WORKA_LOCAL_STUDIO==='1'&&!process.env.NEXT_PUBLIC_SUPABASE_URL
export class StoreError extends Error {constructor(message:string,public status=400){super(message)}}
export function sameOrigin(req:NextRequest){if(!isStudioOrigin(req.headers.get('origin'),req.nextUrl.origin,req.headers.get('sec-fetch-site')))throw new StoreError('This request must come from Worka.',403)}
export async function identity(req:NextRequest){
  if(localMode()){
    if(!['localhost','127.0.0.1','[::1]'].includes(req.nextUrl.hostname))throw new StoreError('Local storage is available on this computer only.',403)
    return 'local-builder'
  }
  if(!process.env.NEXT_PUBLIC_SUPABASE_URL)throw new StoreError('Shared storage needs a configured account. Use the local launcher for storage on this computer.',503)
  const client=createRouteHandlerClient({cookies}),{data:{user}}=await client.auth.getUser()
  if(!user)throw new StoreError('Sign in to save and share projects.',401)
  return user.id
}
function admin(){const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw new StoreError('Shared project storage is not configured.',503);return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})}
const safe=(id:string)=>{if(!/^[-a-zA-Z0-9]{1,100}$/.test(id))throw new StoreError('Invalid project identifier.');return id}
type LocalStore={projects:Record<string,StoredWorkspace>;shares:Record<string,Share>}
export type Share={owner:string;projectId:string;payload:ClientProjection;expiresAt:string;revoked:boolean;feedback:{name:string;message:string;at:string}[]}
async function readLocal():Promise<LocalStore>{try{return JSON.parse(await readFile(path.join(directory,'workspace.json'),'utf8'))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {projects:{},shares:{}};throw new StoreError('The saved workspace could not be read. It has not been overwritten.',500)}}
// Serialize writes and replace atomically; never overwrite an unseen version from another tab.
const state=globalThis as typeof globalThis & {studioWrite?:Promise<unknown>}
async function localWrite<T>(fn:(db:LocalStore)=>T):Promise<T>{const run=(state.studioWrite||Promise.resolve()).catch(()=>{}).then(async()=>{const db=await readLocal(),result=fn(db);await mkdir(directory,{recursive:true});const temp=path.join(directory,randomUUID()+'.tmp');await writeFile(temp,JSON.stringify(db),'utf8');await rename(temp,path.join(directory,'workspace.json'));return result});state.studioWrite=run;return run}
export async function listProjects(owner:string){
  if(localMode())return Object.values((await readLocal()).projects).map(p=>({id:p.workspace.project.id,name:p.workspace.name,version:p.version}))
  const {data,error}=await admin().from('studio_workspaces').select('id,name,version').eq('owner_id',owner).order('updated_at',{ascending:false});if(error)throw new StoreError('Project storage is unavailable.',503);return data
}
export async function getProject(owner:string,id:string):Promise<StoredWorkspace|null>{safe(id);if(localMode())return (await readLocal()).projects[id]||null;const {data,error}=await admin().from('studio_workspaces').select('document').eq('owner_id',owner).eq('id',id).maybeSingle();if(error)throw new StoreError('Project storage is unavailable.',503);return data?.document||null}
export async function saveProject(owner:string,input:unknown,version:number,label:string){
  const w=parseWorkspace(input);if(!w)throw new StoreError('The project contains invalid measurements or data. Nothing was saved.')
  const id=safe(w.project.id)
  const build=(old:StoredWorkspace|null):StoredWorkspace=>{if((old?.version||0)!==version)throw new StoreError('This project changed in another window. Reload the saved version or download your edits before continuing.',409);if(old?.workspace.project.baseline){if(JSON.stringify(old.workspace.project.baseline)!==JSON.stringify(w.project.baseline))throw new StoreError('The accepted baseline cannot be overwritten.',409);if(old.workspace.approvals.some((a,i)=>JSON.stringify(a)!==JSON.stringify(w.approvals[i])))throw new StoreError('Recorded approval evidence cannot be overwritten.',409);const approved=old.workspace.project.variations.filter(v=>v.status==='approved');if(approved.some((v,i)=>JSON.stringify(v)!==JSON.stringify(w.project.variations[i])))throw new StoreError('Approved variation history cannot be overwritten.',409)}return {version:version+1,workspace:w,history:old?[...old.history.slice(-9),{at:new Date().toISOString(),label,workspace:old.workspace}]:[]}}
  if(localMode())return localWrite(db=>{const record=build(db.projects[id]||null);db.projects[id]=record;return record})
  const old=await getProject(owner,id),record=build(old),client=admin()
  const row={id,owner_id:owner,name:w.name,version:record.version,document:record,updated_at:new Date().toISOString()}
  const response=old?await client.from('studio_workspaces').update(row).eq('id',id).eq('owner_id',owner).eq('version',version).select('id'):await client.from('studio_workspaces').insert(row).select('id')
  if(response.error||!response.data?.length)throw new StoreError('The save conflicted or storage is unavailable. Your edits are still on screen.',409)
  return record
}
const digest=(token:string)=>createHash('sha256').update(token).digest('hex')
export async function createShare(owner:string,projectId:string,payload:ClientProjection){
  const token=randomUUID()+randomUUID(),hash=digest(token),share:Share={owner,projectId,payload,expiresAt:new Date(Date.now()+7*86400000).toISOString(),revoked:false,feedback:[]}
  if(localMode())await localWrite(db=>{db.shares[hash]=share})
  else {const {error}=await admin().from('studio_reviews').insert({token_hash:hash,owner_id:owner,project_id:projectId,document:share});if(error)throw new StoreError('Could not create the review link.',503)}
  return {token,expiresAt:share.expiresAt}
}
export async function getShare(token:string){if(!/^[a-f0-9-]{72}$/.test(token))throw new StoreError('Review not found.',404);const hash=digest(token);let share:Share|undefined
  if(localMode())share=(await readLocal()).shares[hash]
  else {const {data,error}=await admin().from('studio_reviews').select('document').eq('token_hash',hash).maybeSingle();if(error)throw new StoreError('Review unavailable.',503);share=data?.document}
  if(!share||share.revoked||Date.parse(share.expiresAt)<Date.now())throw new StoreError('This review link has expired or been revoked.',404)
  return share
}
export async function addFeedback(token:string,name:string,message:string){
  if(!name.trim()||name.length>200||!message.trim()||message.length>2000)throw new StoreError('Enter your name and a comment up to 2,000 characters.')
  const share=await getShare(token),entry={name:name.trim(),message:message.trim(),at:new Date().toISOString()},hash=digest(token)
  if(localMode())await localWrite(db=>{const s=db.shares[hash];if(!s||s.revoked||Date.parse(s.expiresAt)<Date.now())throw new StoreError('Review expired.',404);if(s.feedback.length>=100)throw new StoreError('This review has reached its comment limit.',429);s.feedback.push(entry)})
  else {const {error}=await admin().rpc('studio_add_feedback',{review_hash:hash,entry});if(error)throw new StoreError('Could not add the comment. Please retry.',503)}
  return {ok:true}
}
export async function reviews(owner:string,projectId:string){if(localMode())return Object.entries((await readLocal()).shares).filter(([,s])=>s.projectId===projectId).map(([id,s])=>({id,...s}));const {data,error}=await admin().from('studio_reviews').select('token_hash,document').eq('owner_id',owner).eq('project_id',projectId);if(error)throw new StoreError('Reviews unavailable.',503);return data.map(d=>({id:d.token_hash,...d.document}))}
export async function revoke(owner:string,id:string){if(!/^[a-f0-9]{64}$/.test(id))throw new StoreError('Invalid review.');if(localMode())return localWrite(db=>{if(db.shares[id])db.shares[id].revoked=true});const client=admin(),{data}=await client.from('studio_reviews').select('document').eq('token_hash',id).eq('owner_id',owner).single();if(!data)throw new StoreError('Review not found.',404);const {error}=await client.from('studio_reviews').update({document:{...data.document,revoked:true}}).eq('token_hash',id).eq('owner_id',owner);if(error)throw new StoreError('Could not revoke review.',503)}
