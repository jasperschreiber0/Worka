import {validVectorDimensions} from './studio-vector-scale.ts'
import type {VectorDimension} from './studio-vector-scale.ts'
import {validDrawingText} from './studio-drawing-text.ts'
import type {DrawingText} from './studio-drawing-text.ts'
export function drawingInput(p:any){
 if(!p||typeof p.image!=='string'||p.image.length>3500000||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image)||typeof p.name!=='string'||p.name.length>500||!Number.isInteger(p.page)||p.page<1||p.page>1000||!Number.isFinite(p.aspect)||p.aspect<.05||p.aspect>20||!Number.isFinite(p.metresPerUnit)||p.metresPerUnit<0||p.metresPerUnit>1)throw new Error('Invalid drawing or scale.')
 if(p.vectorDimensions!==undefined&&!validVectorDimensions(p.vectorDimensions,p.aspect))throw new Error('Invalid vector dimension evidence.')
 if(p.text!==undefined&&!validDrawingText(p.text,p.aspect))throw new Error('Invalid drawing text evidence.')
 return p as {vectorDimensions?:VectorDimension[];text?:DrawingText[];image:string;name:string;page:number;aspect:number;metresPerUnit:number;role?:string;revision?:string}
}
export function drawingSetInput(input:any){
 if(!Array.isArray(input)||input.length<1||input.length>8)throw new Error('Choose one to eight drawing pages.')
 const pages=input.map(drawingInput)
 if(pages.reduce((n,p)=>n+p.image.length,0)>8000000)throw new Error('The drawing set is too large. Choose fewer or smaller pages.')
 if(new Set(pages.map(p=>p.name+'::'+p.page)).size!==pages.length)throw new Error('Remove repeated pages before reading the set.')
 return pages
}
