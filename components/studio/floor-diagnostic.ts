import type {PlanSource} from '@/lib/studio-workspace'

/** Number the saved geometry over its source so the reader can locate each index. */
export async function floorDiagnostic(page:PlanSource,draft:any):Promise<string|undefined>{
 const walls=draft?.floors?.[0]?.plan?.walls
 if(!Array.isArray(walls)||!walls.length)return undefined
 const source=new Image();source.src=page.image;await source.decode()
 const canvas=document.createElement('canvas');canvas.width=Math.round(Math.min(2200,2200*page.aspect));canvas.height=Math.round(canvas.width/page.aspect)
 const ctx=canvas.getContext('2d')!;ctx.drawImage(source,0,0,canvas.width,canvas.height)
 const scale=canvas.width/1000
 const point=(p:any)=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)
 function label(text:string,x:number,y:number,colour:string){ctx.font='bold 18px sans-serif';const width=ctx.measureText(text).width;ctx.fillStyle='white';ctx.fillRect(x-2,y-18,width+4,21);ctx.fillStyle=colour;ctx.fillText(text,x,y)}
 walls.forEach((w:any,i:number)=>{
  if(!point(w.a)||!point(w.b))return
  ctx.strokeStyle='#cc2020';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(w.a.x*scale,w.a.y*scale);ctx.lineTo(w.b.x*scale,w.b.y*scale);ctx.stroke()
  label('W'+i,(w.a.x+w.b.x)/2*scale,(w.a.y+w.b.y)/2*scale,'#b00000')
  ;(w.openings||[]).forEach((o:any,j:number)=>{if(!point(o.center))return;const x=o.center.x*scale,y=o.center.y*scale;ctx.fillStyle='#075acc';ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.fill();label(i+'/'+j,x+6,y-6,'#075acc')})
 })
 const image=canvas.toDataURL('image/jpeg',.8);canvas.width=canvas.height=0
 return image.length<=3500000?image:undefined
}
