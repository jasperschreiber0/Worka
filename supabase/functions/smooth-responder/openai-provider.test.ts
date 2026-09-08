import {test} from 'node:test'
import assert from 'node:assert/strict'
import {openAIRequest, normalizeOpenAIResponse, OpenAIEstimationClient} from './openai-provider.ts'
import {classifyAnthropicError} from './pipeline-logic.ts'
const request = {system:'Synthetic test',max_tokens:500,tools:[{name:'estimate',input_schema:{type:'object'}}],messages:[{content:[{type:'text',text:'Synthetic facts'}]}]}
test('OpenAI uses bounded single-tool requests without persistence',()=>{
 const body=openAIRequest(request)
 assert.equal(body.store,false); assert.equal(body.max_output_tokens,500); assert.equal(body.parallel_tool_calls,false)
 assert.equal(body.reasoning.effort,'none'); assert.equal(body.tool_choice.name,'estimate')
 assert.throws(()=>openAIRequest({...request,messages:[{content:[{type:'unknown'}]}]}))
})
test('only a complete matching tool response produces input; failures retain usage',()=>{
 const raw={id:'synthetic',status:'completed',usage:{input_tokens:10,output_tokens:20},output:[{type:'function_call',name:'estimate',arguments:'{"items":[]}'}]}
 assert.deepEqual(normalizeOpenAIResponse(raw,'estimate').content[0].input,{items:[]})
 for(const changed of [{...raw,status:'incomplete'},{...raw,output:[]},{...raw,output:[...raw.output,...raw.output]},{...raw,output:[{...raw.output[0],arguments:'{'}]}]) {
  const result=normalizeOpenAIResponse(changed,'estimate'); assert.equal(result.content.length,0);assert.equal(result.usage.output_tokens,20)
 }
 assert.throws(()=>normalizeOpenAIResponse({...raw,usage:null},'estimate'))
})
test('quota errors stop as billing failures; API key goes only in server authorization header',async()=>{
 let count=0
 const client=new OpenAIEstimationClient('synthetic-key',async(url,init)=>{
  count++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal((init?.headers as any).Authorization,'Bearer synthetic-key')
  assert.ok(!String(init?.body).includes('synthetic-key'))
  return new Response(JSON.stringify({error:{code:'insufficient_quota'}}),{status:429})
 })
 await assert.rejects(()=>client.messages.create(request,{}),error=>classifyAnthropicError(error)==='credit_exhausted')
 assert.equal(count,1)
})
