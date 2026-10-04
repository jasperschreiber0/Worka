import {NextRequest,NextResponse} from 'next/server'
import {identity,sameOrigin,StoreError} from '@/lib/studio-store'
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
 let input;try{input=renderInput(JSON.parse(raw))}catch(e){throw new StoreError(e instanceof Error?e.message:'Invalid image.')}
 active.add(owner);locked=true
 const {response}=await guardedClaudeCall({supabase:gatewaySupabase(),attribution:{kind:'builder',builderId:owner},callSite:'studio_photorealistic_image',model:'gpt-image-2.5-sunburst'},signal=>renderImage(process.env.OPENAI_API_KEY!,input,signal),{timeoutMs:210000,maxRetries:0,label:'studio_render'})
 return NextResponse.json({image:renderedImage(response.image),createdAt:new Date().toISOString(),label:'AI concept visualisation — may differ from model; not for measurement.'},{headers:{'Cache-Control':'no-store'}})
 }catch(e){return NextResponse.json({error:e instanceof StoreError?e.message:'Image generation did not complete. Check API access and billing, then retry; your editable model is unchanged.'},{status:e instanceof StoreError?e.status:502})}finally{if(locked)active.delete(owner)}}
