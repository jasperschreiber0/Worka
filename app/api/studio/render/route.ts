import {matchesJson} from '@/lib/studio-json'
import {renderRepository} from '@/lib/studio-render-store'
import {NextRequest,NextResponse} from 'next/server'
import {identity,sameOrigin,StoreError,getProject} from '@/lib/studio-store'
import {renderInput,renderImage,renderedImage} from '@/lib/studio-image-api'
import {guardedClaudeCall} from '@/supabase/functions/smooth-responder/ai-gateway'
import {gatewaySupabase} from '@/lib/ai-gateway-client'
export const runtime='nodejs',dynamic='force-dynamic',maxDuration=240
const active=new Set<string>()
export async function POST(req:NextRequest){let owner='',locked=false;try{
 sameOrigin(req);owner=await identity(req)
 if(!process.env.OPENAI_API_KEY)throw new StoreError('Connect OPENAI_API_KEY on the Worka server to generate a photorealistic image.',503)
 if(active.has(owner))throw new StoreError('An image is already being generated for this account.',429)
 if(Number(req.headers.get('content-length'))>6100000)throw new StoreError('Model image too large.',413)
 const raw=await req.text();if(raw.length>6100000)throw new StoreError('Model image too large.',413)
 let input,body;try{body=JSON.parse(raw);input=renderInput(body)}catch(e){throw new StoreError(e instanceof Error?e.message:'Invalid image.')}
 if(typeof body.projectId!=='string'||typeof body.revision!=='string'||body.revision.length>200000)throw new StoreError('Save your project before generating an image.')
 if(active.has(owner))throw new StoreError('An image is already being generated for this account.',429)
 active.add(owner);locked=true
 const project=await getProject(owner,body.projectId)
 if(!project)throw new StoreError('Project not found.',404)
 if(!matchesJson(project.workspace.project.working.design,body.revision))throw new StoreError('The model has changed. Save your current project before generating.',409)
 const store=await renderRepository()
 if((await store.list(owner,body.projectId)).length>=20)throw new StoreError('This project already has 20 saved images.',409)
 const {response}=await guardedClaudeCall({supabase:gatewaySupabase(),attribution:{kind:'builder',builderId:owner},callSite:'studio_photorealistic_image',model:'gpt-image-2.5-sunburst'},signal=>renderImage(process.env.OPENAI_API_KEY!,input,signal),{timeoutMs:210000,maxRetries:0,label:'studio_render'})
 const image=renderedImage(response.image)
 let saved=null,saveError=''
 try{saved=await store.save(owner,{projectId:body.projectId,revision:body.revision,image,source:body.image,style:body.style})}catch{saveError='The image was generated but could not be saved. Download it before leaving this page.'}
 return NextResponse.json({image,render:saved,saveError,createdAt:new Date().toISOString(),label:'AI concept visualisation; may differ from model. Not for measurement.'},{headers:{'Cache-Control':'no-store'}})
 }catch(e){return NextResponse.json({error:e instanceof StoreError?e.message:'Image generation did not complete. Check API access and billing, then retry; your editable model is unchanged.'},{status:e instanceof StoreError?e.status:502})}finally{if(locked)active.delete(owner)}}
