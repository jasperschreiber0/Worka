import type {Point} from './studio-geometry.ts'
import {pdfTextRuns} from './studio-pdf-text.ts'
export type VectorDimension={label:string;a:Point;b:Point;metres:number}
type Matrix=number[]
const multiply=(a:Matrix,b:Matrix)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]]
export function vectorDimensions(ops:{fnArray:ArrayLike<number>;argsArray:any[]},codes:Record<string,number>,items:any[],viewport:{width:number;convertToViewportPoint:(x:number,y:number)=>number[]}):VectorDimension[]{
 items=pdfTextRuns(items)
 let matrix:Matrix=[1,0,0,1,0,0];const stack:Matrix[]=[],segments:{a:Point;b:Point}[]=[];let pending:{a:Point;b:Point}[]=[]
 const point=(x:number,y:number)=>{const p=viewport.convertToViewportPoint(matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]);return {x:p[0]*1000/viewport.width,y:p[1]*1000/viewport.width}}
 for(let i=0;i<ops.fnArray.length;i++){const code=ops.fnArray[i],args=ops.argsArray[i];if([codes.stroke,codes.closeStroke,codes.fillStroke,codes.eoFillStroke,codes.closeFillStroke,codes.closeEOFillStroke].includes(code)){segments.push(...pending);pending=[]}else if([codes.fill,codes.eoFill,codes.endPath].includes(code)){pending=[]}else if(code===codes.save||code===codes.paintFormXObjectBegin){stack.push([...matrix]);if(code===codes.paintFormXObjectBegin&&args?.[0])matrix=multiply(matrix,args[0])}else if(code===codes.restore||code===codes.paintFormXObjectEnd){matrix=stack.pop()||[1,0,0,1,0,0]}else if(code===codes.transform)matrix=multiply(matrix,args);else if(code===codes.constructPath){const commands=args[0],coords=args[1];let j=0,last:Point|undefined;for(const command of commands){if(command===codes.moveTo){last=point(coords[j++],coords[j++])}else if(command===codes.lineTo){const next=point(coords[j++],coords[j++]);if(last&&Math.hypot(next.x-last.x,next.y-last.y)>10)pending.push({a:last,b:next});last=next}else if(command===codes.curveTo){j+=6;last=undefined}else if(command===codes.curveTo2||command===codes.curveTo3){j+=4;last=undefined}else if(command===codes.rectangle){j+=4;last=undefined}else last=undefined}}}
 const dimensions:VectorDimension[]=[]
 for(const item of items){const text=String(item.str||'').trim();if(!/^\d{3,5}$/.test(text.replace(/,/g,''))||!Array.isArray(item.transform))continue;const metres=Number(text.replace(/,/g,''))/1000;if(metres<.5||metres>100)continue;const t=item.transform,size=Math.hypot(t[0],t[1]);if(!size)continue;const xy=viewport.convertToViewportPoint(t[4]+t[0]/size*item.width/2,t[5]+t[1]/size*item.width/2),center={x:xy[0]*1000/viewport.width,y:xy[1]*1000/viewport.width};const vertical=Math.abs(t[1])>Math.abs(t[0]);
 const matches=segments.filter(s=>vertical?Math.abs(s.a.x-s.b.x)<.2&&Math.abs(s.a.x-center.x)<6&&Math.abs((s.a.y+s.b.y)/2-center.y)<4:Math.abs(s.a.y-s.b.y)<.2&&Math.abs(s.a.y-center.y)<6&&Math.abs((s.a.x+s.b.x)/2-center.x)<4).sort((a,b)=>{const dist=(s:{a:Point;b:Point})=>Math.hypot((s.a.x+s.b.x)/2-center.x,(s.a.y+s.b.y)/2-center.y);return dist(a)-dist(b)})
 if(matches[0])dimensions.push({label:text,...matches[0],metres})
 }
 return dimensions.slice(0,100)
}
export function vectorScale(evidence:VectorDimension[]){
 const unique=evidence.filter((d,i)=>Number.isFinite(d.metres)&&d.metres>=.5&&d.metres<=100&&[d.a?.x,d.a?.y,d.b?.x,d.b?.y].every(Number.isFinite)&&Math.hypot(d.a.x-d.b.x,d.a.y-d.b.y)>10&&!evidence.slice(0,i).some(p=>Math.abs(p.metres-d.metres)<.001))
 if(unique.length<3)return null
 const scales=unique.map(d=>d.metres/Math.hypot(d.a.x-d.b.x,d.a.y-d.b.y)).sort((a,b)=>a-b),median=scales[Math.floor(scales.length/2)]
 const agreeing=unique.filter(d=>Math.abs(d.metres/Math.hypot(d.a.x-d.b.x,d.a.y-d.b.y)/median-1)<.01)
 if(agreeing.length<3||agreeing.length<unique.length*.8||!agreeing.some(d=>Math.abs(d.a.x-d.b.x)>Math.abs(d.a.y-d.b.y))||!agreeing.some(d=>Math.abs(d.a.y-d.b.y)>Math.abs(d.a.x-d.b.x)))return null
 return {metresPerUnit:median,dimensions:agreeing}
}

export function validVectorDimensions(v:any,aspect:number):v is VectorDimension[]{return Array.isArray(v)&&v.length<=100&&v.every(d=>d&&typeof d.label==='string'&&d.label.length<=160&&Number.isFinite(d.metres)&&d.metres>=.5&&d.metres<=100&&[d.a,d.b].every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1000&&p.y>=0&&p.y<=1000/aspect+.1))}
