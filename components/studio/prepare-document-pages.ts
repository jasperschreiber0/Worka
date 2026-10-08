import {estimatingPageSelection} from '@/lib/studio-model-pages'
import {vectorDimensions,vectorScale} from '@/lib/studio-vector-scale'
import {drawingText} from '@/lib/studio-drawing-text'
import type {DocumentReading} from '@/lib/studio-document-reading'
import type {PlanSource} from '@/lib/studio-workspace'

export async function prepareDocumentPages(file:File,reading:DocumentReading,signal:AbortSignal,explicitSelection=false){
 const selection=explicitSelection?{pages:reading.sheets.map(s=>({...s,role:s.role as PlanSource["role"]})),omitted:[]}:estimatingPageSelection(reading),pages:PlanSource[]=[]
 if(!selection.pages.length)return {pages,omitted:selection.omitted}
 const {resolvePDFJS}=await import('unpdf/pdfjs'),engine=await resolvePDFJS()
 const pdf=await engine.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:true}).promise
 try{for(const sheet of selection.pages){
  if(signal.aborted)throw new DOMException('Stopped','AbortError')
  const page=await pdf.getPage(sheet.page),viewport=page.getViewport({scale:1}),view=page.getViewport({scale:Math.min(3,1800/Math.max(viewport.width,viewport.height))}),content=await page.getTextContent()
  const canvas=document.createElement('canvas');canvas.width=view.width;canvas.height=view.height
  const task=page.render({canvasContext:canvas.getContext('2d')!,viewport:view}),cancel=()=>task.cancel();signal.addEventListener('abort',cancel,{once:true})
  try{await task.promise}finally{signal.removeEventListener('abort',cancel)}
  if(signal.aborted)throw new DOMException('Stopped','AbortError')
  const vectors=vectorDimensions(await page.getOperatorList(),engine.OPS,content.items,viewport),scale=vectorScale(vectors)
  const image=canvas.toDataURL('image/jpeg',.75);canvas.width=canvas.height=0
  if(image.length>3500000)throw new Error('A rendered drawing is too large to save. Read the PDF using Plan setup.')
  pages.push({name:file.name,page:sheet.page,role:sheet.role,revision:reading.revision.slice(0,100),image,aspect:viewport.width/viewport.height,metresPerUnit:scale?.metresPerUnit||0,vectorDimensions:scale?.dimensions||[],text:drawingText(content.items,viewport),recognition:{warnings:[scale?`Scale recovered from ${scale.dimensions.length} independent printed dimensions; model remains unverified.`:'Automatic scale could not be established; check a printed dimension.','Selected automatically from the document index. Confirm revision and scope before generating.']}})
 }}finally{await pdf.destroy()}
 return {pages,omitted:selection.omitted}
}
