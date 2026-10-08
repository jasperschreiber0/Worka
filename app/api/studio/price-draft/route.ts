import Anthropic from '@anthropic-ai/sdk'
import {NextRequest,NextResponse} from 'next/server'
import {identity,sameOrigin,StoreError} from '@/lib/studio-store'
import {parseWorkspace} from '@/lib/studio-workspace'
import {preparePriceDraft} from '@/lib/studio-price-draft'
import {builderEstimateContext,builderEstimateSchema,applyBuilderEstimate,builderEstimatePrompt} from '@/lib/studio-builder-estimate'
import {OpenAIEstimationClient,ESTIMATION_MODEL} from '@/supabase/functions/smooth-responder/openai-provider'
import {guardedClaudeCall} from '@/supabase/functions/smooth-responder/ai-gateway'
import {gatewaySupabase} from '@/lib/ai-gateway-client'
export const runtime='nodejs',dynamic='force-dynamic',maxDuration=240
export async function POST(req:NextRequest){try{
 sameOrigin(req);const owner=await identity(req)
 const raw=await req.text();if(raw.length>29000000)throw new StoreError('This project is too large for one pricing pass.',413)
 let body;try{body=JSON.parse(raw)}catch{throw new StoreError('Invalid project.')}
 const input=parseWorkspace(body.workspace);if(!input)throw new StoreError('The project contains invalid measurements or scope.')
 if(!input.project.working.lines.length&&!input.plan&&!input.drawings?.length&&!input.documentReadings?.length)throw new StoreError('Upload plans or add scope to prepare a builder estimate.')
 const w={...input,project:{...input.project,working:preparePriceDraft(input.project.working,input.rates,false).revision}}
 const context=builderEstimateContext(w),serialized=JSON.stringify(context)
 if(context.groups.length>100)throw new StoreError('This scope has more than 100 distinct pricing groups.',413)
 const pages=[w.plan,...(w.drawings||[])].filter((p,i,a)=>p&&a.findIndex(x=>x?.image===p.image)===i).slice(0,8)
 const content:any[]=[{type:'text',text:serialized},...pages.flatMap(p=>[{type:'text',text:JSON.stringify({planName:p!.name,page:p!.page,role:p!.role})},{type:'image',source:{type:'base64',media_type:p!.image.split(';')[0].slice(5),data:p!.image.split(',')[1]}}])]
 if(serialized.length>750000)throw new StoreError('There is too much plan information for one pricing pass.',413)
 if(!process.env.OPENAI_API_KEY&&!process.env.ANTHROPIC_API_KEY)throw new StoreError('AI pricing is not connected. Existing prices and the slider remain available.',503)
 const apiKey=process.env.OPENAI_API_KEY,model=apiKey?ESTIMATION_MODEL:'claude-sonnet-4-6',client=apiKey?new OpenAIEstimationClient(apiKey):new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY,maxRetries:0})
 const {response}=await guardedClaudeCall<any>({supabase:gatewaySupabase(),attribution:{kind:'builder',builderId:owner},callSite:'studio_provisional_pricing',model},signal=>client.messages.create({model,max_tokens:26000,system:builderEstimatePrompt,tools:[{name:'submit_builder_estimate',input_schema:builderEstimateSchema as any}],tool_choice:{type:'tool',name:'submit_builder_estimate'},messages:[{role:'user',content}]},{signal}),{timeoutMs:210000,maxRetries:0,label:'studio_provisional_pricing'})
 const call=response.content?.find((c:any)=>c.type==='tool_use'&&c.name==='submit_builder_estimate')
 if(response.stop_reason!=='tool_use'||!call)throw new StoreError('The pricing pass did not finish. Your existing estimate is unchanged.',422)
 let priced;try{priced=applyBuilderEstimate(w,call.input)}catch(e){throw new StoreError((e as Error).message,422)}
 if(!parseWorkspace(priced))throw new StoreError('The pricing draft could not be saved safely. Your estimate is unchanged.',422)
 return NextResponse.json({workspace:priced,assumptions:call.input.assumptions},{headers:{'Cache-Control':'no-store'}})
 }catch(e){return NextResponse.json({error:e instanceof StoreError?e.message:'Pricing is temporarily unavailable. Your existing estimate is unchanged.'},{status:e instanceof StoreError?e.status:502})}}

