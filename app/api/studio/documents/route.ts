import {NextRequest,NextResponse} from 'next/server'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {createClient} from '@supabase/supabase-js'
import {identity,sameOrigin,localMode,getProject,StoreError} from '@/lib/studio-store'
import {ensurePrivateRenderBucket} from '@/lib/studio-render-bucket'
export const runtime='nodejs',dynamic='force-dynamic'
const limit=20*1024*1024,bucket='studio-documents'
async function storage(){
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY
 if(!url||!key)throw new StoreError('Private drawing storage is unavailable.',503)
 const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
 await ensurePrivateRenderBucket(client.storage,bucket,['application/pdf'],limit)
 return client.storage.from(bucket)
}
function failure(e:unknown){return NextResponse.json({error:e instanceof StoreError?e.message:'Original drawing storage is unavailable.'},{status:e instanceof StoreError?e.status:503})}
export async function POST(req:NextRequest){try{
 sameOrigin(req);const owner=await identity(req),project=req.nextUrl.searchParams.get('project')||''
 if(!await getProject(owner,project))throw new StoreError('Save the project before attaching its original PDF.',404)
 if(Number(req.headers.get('content-length'))>limit)throw new StoreError('Choose a PDF under 20 MB.',413)
 const bytes=Buffer.from(await req.arrayBuffer())
 if(bytes.length>limit)throw new StoreError('Choose a PDF under 20 MB.',413)
 if(bytes.subarray(0,5).toString()!=='%PDF-')throw new StoreError('Upload a PDF drawing.')
 const id=createHash('sha256').update(bytes).digest('hex'),key=`${owner}/${project}/${id}.pdf`
 if(localMode()){const file=path.join(process.cwd(),'.worka-studio','documents',key);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes)}
 else{const {error}=await(await storage()).upload(key,bytes,{contentType:'application/pdf',upsert:true});if(error)throw new StoreError('The original PDF could not be saved. Retry the upload.',503)}
 return NextResponse.json({id})
 }catch(e){return failure(e)}}
export async function GET(req:NextRequest){try{
 const owner=await identity(req),project=req.nextUrl.searchParams.get('project')||'',id=req.nextUrl.searchParams.get('id')||''
 if(!/^[a-f0-9]{64}$/.test(id))throw new StoreError('Drawing not found.',404)
 const record=await getProject(owner,project)
 if(!record||![record.workspace.plan,...(record.workspace.drawings||[])].some(p=>p?.originalId===id))throw new StoreError('Drawing not found.',404)
 const key=`${owner}/${project}/${id}.pdf`
 let bytes:Uint8Array
 if(localMode())bytes=await readFile(path.join(process.cwd(),'.worka-studio','documents',key))
 else{const {data,error}=await(await storage()).download(key);if(error||!data)throw new StoreError('Drawing not found.',404);bytes=new Uint8Array(await data.arrayBuffer())}
 return new NextResponse(bytes as any,{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="original-drawing.pdf"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})
 }catch(e){return failure(e)}}
