import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { Design } from '@/lib/project-studio'
import { buildTracedModel } from './traced-scene'

export type Finish = 'sage' | 'sand'
export type ModelOptions = { walls: boolean; labels: boolean; dimensions: boolean; presentation: boolean; finish: Finish; roof?:boolean; section?:number; selectedWall?:string; floorId?:string; furniture?:boolean }
export type ModelScene = { group: THREE.Group; annotations: THREE.Group; dimensions: THREE.Group; setFinish: (finish: Finish) => void; dispose: () => void }

// Geometry is created only when the building dimensions or wall height change.
// Shared primitives and instanced floorboards keep draw calls and allocations low.
export function buildModel(design: Design, options: ModelOptions): ModelScene {
  if(design.geometry)return buildTracedModel(design.geometry,options)
  const {width:w,depth:d,height:h}=design
  const group=new THREE.Group()
  group.position.set(-w/2,0,-d/2)
  const annotations=new THREE.Group(), dimensions=new THREE.Group()
  const geometries=new Set<THREE.BufferGeometry>(), materials=new Set<THREE.Material>(), textures=new Set<THREE.Texture>()
  function geom<T extends THREE.BufferGeometry>(g:T) { geometries.add(g);return g }
  function material(colour:string,roughness=.8) {
    const m=new THREE.MeshStandardMaterial({color:colour,roughness})
    materials.add(m);return m
  }
  const cube=geom(new THREE.BoxGeometry(1,1,1))
  const rounded=geom(new RoundedBoxGeometry(1,1,1,2,.09))
  const cylinder=geom(new THREE.CylinderGeometry(.5,.5,1,24))
  const sphere=geom(new THREE.SphereGeometry(1,12,8))
  const plaster=material('#f1efe6'), stone=material('#f4f0e6',.5), oak=material('#b99160'), darkOak=material('#806548')
  const sage=material('#819487'), fabric=material('#c6c9b9'), cushion=material('#ede5d7'), rug=material('#e3d9c8')
  const metal=material('#353f39',.38), foliage=material('#72826a'), pot=material('#bbac91'), white=material('#f5f3ec')
  function mesh(g:THREE.BufferGeometry,m:THREE.Material,x:number,y:number,z:number,sx:number,sy:number,sz:number,shadow=true) {
    const item=new THREE.Mesh(g,m);item.position.set(x,y,z);item.scale.set(sx,sy,sz);item.castShadow=shadow;item.receiveShadow=true;group.add(item);return item
  }
  // x/z are the lower-left footprint corner; y is the base elevation.
  function box(x:number,z:number,y:number,bw:number,bd:number,bh:number,m:THREE.Material,soft=false) {
    return mesh(soft?rounded:cube,m,x+bw/2,y+bh/2,z+bd/2,bw,bh,bd)
  }
  box(-.22,-.22,-.22,w+.44,d+.44,.2,stone)
  box(0,0,-.025,w,d,.025,oak)
  const plankCount=Math.ceil(w/.2), rows=Math.ceil(d/1.5)
  const floorMats=[material('#cdb18a'),material('#d4b993'),material('#c7a77d'),material('#d9bd96')]
  const matrix=new THREE.Matrix4()
  for(let colour=0;colour<floorMats.length;colour++){
    const boards: Array<[number,number,number,number]>=[]
    for(let col=0;col<plankCount;col++)for(let row=0;row<rows;row++){
      if((col*7+row*3)%4!==colour)continue
      const x=col*.2, z=row*1.5
      boards.push([x,z,Math.min(.196,w-x),Math.min(1.494,d-z)])
    }
    const instance=new THREE.InstancedMesh(cube,floorMats[colour],boards.length)
    boards.forEach(([x,z,bw,bd],i)=>{matrix.makeScale(bw,.015,bd);matrix.setPosition(x+bw/2,.005,z+bd/2);instance.setMatrixAt(i,matrix)})
    instance.receiveShadow=true;group.add(instance)
  }
  const wall=options.walls?h:.62
  box(0,0,0,w,.14,wall,plaster)
  box(0,0,0,.14,d,wall,plaster)
  box(w-.14,0,0,.14,.7,wall,plaster)
  box(w-.14,2.1,0,.14,d-2.1,wall,plaster)
  box(0,d-.14,0,1.3,.14,wall,plaster)
  box(w/2+.6,d-.14,0,w/2-.6,.14,wall,plaster)
  // Skirting and low wall caps articulate the cutaway without extra texture downloads.
  box(.14,.14,.015,w-.28,.035,.07,white)
  box(.14,.14,.015,.035,d-.28,.07,white)
  if(options.walls){
    box(w-.14,.7,0,.14,1.4,.9,plaster)
    box(w-.14,.7,2.1,.14,1.4,h-2.1,plaster)
    const glass=new THREE.MeshStandardMaterial({color:'#c4d8d3',roughness:.2,transparent:true,opacity:.34,depthWrite:false})
    materials.add(glass)
    box(w-.09,.72,.94,.018,1.36,1.12,glass)
    box(w-.16,.69,.89,.18,.035,1.22,metal)
    box(w-.16,2.08,.89,.18,.035,1.22,metal)
    box(w-.16,.69,.89,.18,1.42,.035,metal)
    box(w-.16,.69,2.075,.18,1.42,.035,metal)
    box(1.3,d-.14,2.2,w/2-.7,.14,h-2.2,plaster)
  }
  // Kitchen: recessed plinth, individual doors, stone bench, hob, sink and mixer.
  const kitchenWidth=w/2-.4
  box(w/2+.18,.18,.08,kitchenWidth,.62,.78,sage)
  box(w/2+.2,.23,0,kitchenWidth-.04,.52,.12,metal)
  box(w/2+.15,.15,.86,kitchenWidth+.06,.68,.055,stone,true)
  const doors=Math.max(4,Math.floor(kitchenWidth/.55))
  for(let i=0;i<doors;i++){
    box(w/2+.19+i*kitchenWidth/doors,.805,.15,kitchenWidth/doors-.016,.017,.68,sage)
    box(w/2+.23+i*kitchenWidth/doors,.83,.78,kitchenWidth/doors-.09,.018,.012,metal)
  }
  box(w-.99,.27,.916,.55,.38,.014,metal,true)
  for(const dx of [0,.27])for(const dz of [0,.2]) mesh(cylinder,metal,w-.85+dx,.935,.36+dz,.13,.004,.13,false)
  box(w/2+.5,.28,.916,.52,.34,.014,metal,true)
  box(w/2+.54,.31,.93,.44,.27,.012,stone,true)
  mesh(cylinder,metal,w/2+.75,1.06,.25,.025,.28,.025)
  box(w/2+.735,.25,1.18,.025,.16,.025,metal)
  box(w/2+.7,1.5,.08,1.9,.8,.77,sage,true)
  box(w/2+.64,1.44,.85,2.02,.92,.065,stone,true)
  // Living space: woven rug, low sofa, cushions and two nested coffee tables.
  box(.5,1.4,.028,2.9,2.6,.018,rug,true)
  box(.42,.5,.13,2.6,.92,.38,fabric,true)
  box(.42,.45,.46,2.6,.21,.4,fabric,true)
  box(.4,.47,.38,.21,1,.28,fabric,true)
  box(2.83,.47,.38,.21,1,.28,fabric,true)
  for(let i=0;i<3;i++) box(.65+i*.72,.69,.48,.7,.68,.09,cushion,true)
  box(.67,.63,.62,.43,.13,.34,sage,true).rotation.z=.1
  box(2.18,.63,.62,.4,.13,.34,cushion,true).rotation.z=-.12
  mesh(cylinder,oak,1.55,.4,2.24,1.12,.09,.75)
  mesh(cylinder,darkOak,1.55,.2,2.24,.25,.34,.25)
  mesh(cylinder,stone,2.28,.3,2.63,.64,.065,.64)
  mesh(cylinder,darkOak,2.28,.16,2.63,.12,.26,.12)
  box(1.29,2.03,.45,.32,.22,.024,white)
  // Dining, sized to fit both supported layout options.
  box(w/2+.72,3.6,.73,2,1.03,.075,oak,true)
  for(const x of [w/2+.84,w/2+2.5])for(const z of [3.72,4.42])box(x,z,.02,.09,.09,.71,darkOak)
  for(const x of [w/2+.92,w/2+1.98])for(const z of [3.01,4.85]){
    box(x,z,.4,.5,.48,.09,oak,true)
    box(x,z+(z>4?.41:0),.46,.5,.065,.37,oak,true)
    for(const dx of [.04,.39])for(const dz of [.04,.37])box(x+dx,z+dz,.02,.04,.04,.39,darkOak)
  }
  mesh(cylinder,pot,w/2+1.65,.91,4.1,.15,.25,.15)
  mesh(sphere,foliage,w/2+1.65,1.15,4.1,.18,.19,.17)
  // Restrained indoor planting.
  mesh(cylinder,pot,.62,.21,5.2,.43,.42,.43)
  mesh(cylinder,darkOak,.62,.75,5.2,.035,1,.035)
  for(let i=0;i<7;i++){
    const a=i*2.4
    const leaf=mesh(sphere,foliage,.62+Math.cos(a)*.22,.75+i*.085,5.2+Math.sin(a)*.22,.13,.27,.09)
    leaf.rotation.set(.3,a,.65)
  }
  function label(text:string,x:number,y:number,z:number,width=1.35) {
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=128
    const ctx=canvas.getContext('2d')!
    ctx.fillStyle='rgba(255,254,249,.95)';ctx.beginPath();ctx.roundRect(3,3,506,122,24);ctx.fill()
    ctx.strokeStyle='#dce3d5';ctx.lineWidth=3;ctx.stroke()
    ctx.font='500 44px Arial';ctx.fillStyle='#3e5546';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,256,67)
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;textures.add(texture)
    const mat=new THREE.SpriteMaterial({map:texture,depthTest:false,depthWrite:false});materials.add(mat)
    const sprite=new THREE.Sprite(mat);sprite.position.set(x,y,z);sprite.scale.set(width,width/4,1);sprite.renderOrder=10;return sprite
  }
  annotations.add(label('Living',w/4,.18,4.2),label('Kitchen',w*.75,1.35,.5),label('Dining',w*.75,.15,5.45))
  const points:number[]=[]
  function line(a:number[],b:number[]){points.push(...a,...b)}
  line([0,.04,d+.58],[w,.04,d+.58])
  line([w+.58,.04,0],[w+.58,.04,d])
  for(const x of [0,w])line([x,.04,d+.45],[x,.04,d+.71])
  for(const z of [0,d])line([w+.45,.04,z],[w+.71,.04,z])
  const lineGeo=geom(new THREE.BufferGeometry());lineGeo.setAttribute('position',new THREE.Float32BufferAttribute(points,3))
  const lineMat=new THREE.LineBasicMaterial({color:'#819385'});materials.add(lineMat)
  dimensions.add(new THREE.LineSegments(lineGeo,lineMat),label(w.toFixed(1)+' m',w/2,.08,d+.83,.92),label(d.toFixed(1)+' m',w+.83,.08,d/2,.92))
  group.add(annotations,dimensions)
  return {
    group,annotations,dimensions,
    setFinish(finish) { sage.color.set(finish==='sage'?'#819487':'#b5a187');fabric.color.set(finish==='sage'?'#c6c9b9':'#d7cbb9') },
    dispose() { geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose()) },
  }
}
