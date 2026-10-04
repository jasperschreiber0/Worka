import {createClient} from '@supabase/supabase-js'
import {mkdir,readdir,readFile,writeFile,rename} from 'node:fs/promises'
import path from 'node:path'
import {createRenderRepository} from './studio-render-record'
import type {RenderIO} from './studio-render-record'
import {getProject,localMode,StoreError} from './studio-store'
import {ensurePrivateRenderBucket,renderBucket as bucket} from './studio-render-bucket'
const root=path.join(process.cwd(),'.worka-studio','renders')
async function authorize(owner:string,id:string){if(!await getProject(owner,id))throw new StoreError('Save this project before generating or opening its images.',404)}
const local:RenderIO={
 async list(prefix){try{return await readdir(path.join(root,prefix))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e}},
 async read(key){return readFile(path.join(root,key),'utf8')},
 async write(key,data){const file=path.join(root,key);await mkdir(path.dirname(file),{recursive:true});await writeFile(file+'.tmp',data,{flag:'wx'});await rename(file+'.tmp',file)}
}
export async function renderRepository(){
 if(localMode())return createRenderRepository(local,authorize)
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY
 if(!url||!key)throw new StoreError('Private image storage is not configured.',503)
 const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
 try{await ensurePrivateRenderBucket(client.storage)}catch{throw new StoreError('Private image storage is unavailable.',503)}
 const objects=client.storage.from(bucket)
 return createRenderRepository({
  async list(prefix){const {data,error}=await objects.list(prefix,{limit:21});if(error)throw new StoreError('Saved images could not be listed.',503);return data.map(o=>o.name)},
  async read(key){const {data,error}=await objects.download(key);if(error||!data)throw new StoreError('Saved image not found.',404);return data.text()},
  async write(key,data){const {error}=await objects.upload(key,data,{contentType:'application/json',upsert:false});if(error)throw new StoreError('Image storage failed. Download the generated image to keep it.',503)}
 },authorize)
}
