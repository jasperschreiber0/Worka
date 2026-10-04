// Some CAD exporters store text as independently positioned glyphs, in arbitrary
// stream order. Reassemble only nearby glyphs on the same baseline and font.
// This recovers printed text; it does not infer dimensions from font size.
export function pdfTextRuns(items:any[]):any[]{
 const visible=items.filter(i=>typeof i.str==='string'&&i.str.trim())
 if(!visible.length||visible.filter(i=>i.str.trim().length===1).length/visible.length<.65)return items
 const groups=new Map<string,any[]>()
 const unpositioned=visible.filter(i=>!Array.isArray(i.transform)||!Math.hypot(i.transform[0],i.transform[1])||!Number.isFinite(i.width))
 for(const item of visible){
  if(unpositioned.includes(item))continue
  const t=item.transform,size=Math.hypot(t[0],t[1]);if(!size||!Number.isFinite(item.width))continue
  const ux=t[0]/size,uy=t[1]/size,along=t[4]*ux+t[5]*uy,across=-t[4]*uy+t[5]*ux
  const key=[item.fontName,Math.round(size*10),Math.round(Math.atan2(uy,ux)*1000),Math.round(across*2)].join(':')
  const group=groups.get(key)||[];group.push({item,along,size});groups.set(key,group)
 }
 const result:any[]=[]
 for(const group of Array.from(groups.values())){
  group.sort((a,b)=>a.along-b.along)
  let run:any=null,end=0
  for(const {item,along,size} of group){
   const gap=along-end
   if(run&&gap>=-size*.12&&gap<=size*.6&&run.str.length+item.str.length<160){
    run.str+=(gap>size*.18?' ':'')+item.str
    run.width=along+item.width-run.start;end=along+item.width
   }else{run={...item,transform:[...item.transform],start:along};result.push(run);end=along+item.width}
  }
 }
 return [...result.map(({start,...item})=>item),...unpositioned]
}
