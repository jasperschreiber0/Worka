export function renderInput(v:any){
 if(!v||typeof v.image!=='string'||v.image.length>6000000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(v.image)||typeof v.style!=='string'||v.style.length>1500||typeof v.title!=='string'||v.title.length>200)throw new Error('Choose a model view and a style description under 1,500 characters.')
 const bytes=Buffer.from(v.image.split(',')[1],'base64');if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('The model snapshot is not a PNG image.')
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(width<16||height<16||width>4096||height>4096)throw new Error('The model snapshot has unsupported dimensions.')
 return {bytes,style:v.style as string,title:v.title as string}
}
export async function renderImage(key:string,input:ReturnType<typeof renderInput>,signal:AbortSignal,transport:typeof fetch=fetch){
 const form=new FormData();form.set('model','gpt-image-2.5-sunburst');form.set('image',new Blob([new Uint8Array(input.bytes)],{type:'image/png'}),'model-view.png');form.set('size','1536x1024');form.set('quality','medium');form.set('output_format','png');form.set('n','1')
 form.set('prompt','Create a photorealistic architectural concept visualisation from this rendered editable building model. Preserve the supplied camera composition, number of storeys, footprint, wall arrangement and visible openings. Improve materials, lighting, shadows and realism. Keep cutaway views as cutaways. Do not add rooms, floors, openings, structural details or site topography. No text or dimensions. This is illustrative and must never be treated as measured geometry. User material/lighting preferences: '+input.style)
 const response=await transport('https://api.openai.com/v1/images/edits',{method:'POST',headers:{Authorization:'Bearer '+key},body:form,signal});const raw=await response.json()
 if(!response.ok)throw Object.assign(new Error(response.status===401?'The image API key was rejected.':response.status===429?'Image generation quota or rate limit reached.':'The image service could not complete this render.'),{status:response.status})
 // Preserve metering even when output validation fails after the gateway records usage.
 const usage=raw.usage;if(!Number.isFinite(usage?.input_tokens)||!Number.isFinite(usage?.output_tokens))throw new Error('The image service returned no usable usage record.')
 return {usage,id:response.headers.get('x-request-id')||undefined,image:raw.data?.[0]?.b64_json}
}
export function renderedImage(v:unknown){if(typeof v!=='string'||v.length>24000000||!/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(v))throw new Error('The image service returned an invalid image.');return 'data:image/png;base64,'+v}
