import * as THREE from 'three'
import { geometryBounds, length, levels } from '@/lib/studio-geometry'
import type { Geometry, FloorGeometry } from '@/lib/studio-geometry'
import type { ModelOptions, ModelScene } from './studio-scene'
function buildFloorModel(g:FloorGeometry,options:ModelOptions):ModelScene {
  const group=new THREE.Group(),annotations=new THREE.Group(),dimensions=new THREE.Group()
  const b=geometryBounds(g);group.position.set(-b.minX-b.width/2,0,-b.minY-b.depth/2)
  const geometries:THREE.BufferGeometry[]=[],materials:THREE.Material[]=[],textures:THREE.Texture[]=[]
  const mat=(color:string)=>{const m=new THREE.MeshStandardMaterial({color,roughness:.8});materials.push(m);return m}
  const plaster=mat('#e4e4d8'),selected=mat('#548f78'),floor=mat('#cfb590'),glass=mat('#9ec2bc')
  glass.transparent=true;glass.opacity=.35;glass.depthWrite=false
  const cube=new THREE.BoxGeometry(1,1,1);geometries.push(cube)
  const shape=new THREE.Shape(g.footprint.map(p=>new THREE.Vector2(p.x,-p.y)))
  const slab=new THREE.ExtrudeGeometry(shape,{depth:.15,bevelEnabled:false});geometries.push(slab)
  const base=new THREE.Mesh(slab,floor);base.rotation.x=-Math.PI/2;base.position.y=-.15;base.receiveShadow=true;group.add(base)
  const label=(text:string,x:number,y:number,z:number)=>{
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=100
    const c=canvas.getContext('2d')!;c.fillStyle='#fffef8';c.fillRect(0,0,512,100);c.fillStyle='#294f41';c.font='36px Arial';c.textAlign='center';c.textBaseline='middle';c.fillText(text,256,50,490)
    const t=new THREE.CanvasTexture(canvas);t.colorSpace=THREE.SRGBColorSpace;textures.push(t);const m=new THREE.SpriteMaterial({map:t,depthTest:false,toneMapped:false});materials.push(m)
    const s=new THREE.Sprite(m);s.position.set(x,y,z);s.scale.set(2,.39,1);s.renderOrder=20;return s
  }
  for(const w of g.walls){
    const l=length(w.a,w.b),height=Math.min(w.height,options.section??12,options.walls?w.height:.65)
    const wall=new THREE.Group();wall.position.set(w.a.x,0,w.a.y);wall.rotation.y=-Math.atan2(w.b.y-w.a.y,w.b.x-w.a.x)
    const material=w.id===options.selectedWall?selected:w.colour?mat(w.colour):plaster
    const box=(x:number,y:number,width:number,h:number,m=material,thickness=w.thickness)=>{if(width<=0||h<=0)return;const mesh=new THREE.Mesh(cube,m);mesh.position.set(x+width/2,y+h/2,0);mesh.scale.set(width,h,thickness);mesh.castShadow=true;mesh.receiveShadow=true;mesh.userData.wallId=w.id;wall.add(mesh)}
    let cursor=0
    for(const o of [...w.openings].sort((a,b)=>a.offset-b.offset)){
      box(cursor,0,o.offset-cursor,height);box(o.offset,0,o.width,Math.min(o.sill,height))
      const top=o.sill+o.height;box(o.offset,top,o.width,height-top)
      if(o.kind==='window')box(o.offset,o.sill,o.width,Math.max(0,Math.min(top,height)-o.sill),glass,.025)
      cursor=o.offset+o.width
    }
    box(cursor,0,l-cursor,height);group.add(wall)
    annotations.add(label(w.name,(w.a.x+w.b.x)/2,height+.3,(w.a.y+w.b.y)/2))
    dimensions.add(label(l.toFixed(2)+' m',(w.a.x+w.b.x)/2,.15,(w.a.y+w.b.y)/2))
  }
  if(options.roof&&(!g.roof||g.roof.style==='flat')){const roof=new THREE.Mesh(slab,g.roof?mat(g.roof.colour):plaster);roof.rotation.x=-Math.PI/2;roof.position.y=Math.max(...g.walls.map(w=>w.height),2.7);roof.castShadow=true;group.add(roof)}
  for(const r of g.rooms||[]){
    const shape=new THREE.Shape(r.polygon.map(p=>new THREE.Vector2(p.x,-p.y))),geo=new THREE.ShapeGeometry(shape);geometries.push(geo)
    const roomFloor=new THREE.Mesh(geo,mat({oak:'#bf9b71',tile:'#ddd9d0',concrete:'#a5a5a0',carpet:'#b5c0b5'}[r.finish]));roomFloor.rotation.x=-Math.PI/2;roomFloor.position.y=.012;roomFloor.receiveShadow=true;group.add(roomFloor)
    const minX=Math.min(...r.polygon.map(p=>p.x)),maxX=Math.max(...r.polygon.map(p=>p.x)),minY=Math.min(...r.polygon.map(p=>p.y)),maxY=Math.max(...r.polygon.map(p=>p.y)),x=(minX+maxX)/2,z=(minY+maxY)/2
    annotations.add(label(r.name,x,.25,z))
    if(options.furniture&&r.furniture!=='none'&&maxX-minX>(r.furniture==='lift'?.8:2)&&maxY-minY>(r.furniture==='lift'?.8:2)){
      const furniture=new THREE.Group();furniture.position.set(x,0,z);const fabric=mat('#d2d6c7'),wood=mat('#ac8963')
      const part=(w:number,h:number,d:number,px:number,py:number,pz:number,m=fabric)=>{const mesh=new THREE.Mesh(cube,m);mesh.scale.set(w,h,d);mesh.position.set(px,py,pz);mesh.castShadow=true;mesh.receiveShadow=true;furniture.add(mesh)}
      if(r.furniture==='bedroom'){part(1.6,.4,2,0,.23,0);part(1.65,.9,.1,0,.45,-1);part(.6,.12,.4,-.4,.49,-.6);part(.6,.12,.4,.4,.49,-.6)}
      if(r.furniture==='living'){part(1.8,.4,.8,0,.3,-.5);part(1.8,.65,.18,0,.55,-.84);part(.75,.1,.55,0,.35,.55,wood);part(.1,.35,.1,0,.175,.55,wood)}
      if(r.furniture==='dining'){part(1.4,.1,.8,0,.75,0,wood);for(const dx of [-.5,.5])for(const dz of [-.3,.3])part(.07,.7,.07,dx,.35,dz,wood);for(const dz of [-.8,.8])part(.5,.45,.45,0,.25,dz)}
      if(r.furniture==='kitchen-island'||r.furniture==='kitchen-wall'){
        // Illustrative layout inside the room bounds, not a joinery take-off.
        const width=maxX-minX,depth=maxY-minY,benchX=-width/2+.34,benchLength=Math.min(depth-.3,4.8),cabinet=mat('#c3b293'),top=mat('#eeece4'),steel=mat('#879895'),dark=mat('#334c48')
        part(.6,.84,benchLength,benchX,.42,0,cabinet);part(.66,.05,benchLength+.04,benchX,.865,0,top)
        const hasIsland=r.furniture==='kitchen-island',islandLength=Math.min(2.4,depth-1.6),serviceX=hasIsland?width/2-.65:benchX
        if(hasIsland){part(.9,.84,islandLength,serviceX,.42,0,cabinet);part(1,.05,islandLength+.1,serviceX,.865,0,top)}
        part(.45,.025,.5,serviceX,.9,-.45,steel);part(.34,.028,.38,serviceX,.918,-.45,dark)
        part(.035,.28,.035,serviceX-.2,1.02,-.45,steel);part(.17,.035,.035,serviceX-.13,1.15,-.45,steel)
        // Dishwasher front faces the kitchen circulation area.
        part(.025,.72,.58,serviceX+(hasIsland?-.455:.305),.43,.4,steel)
        part(.03,.06,.58,serviceX+(hasIsland?-.47:.32),.75,.4,dark)
      }
      if(r.furniture==='lift'){
        const width=Math.min(1.45,maxX-minX-.1),depth=Math.min(1.45,maxY-minY-.1),steel=mat('#899c98')
        part(width,.06,depth,0,.04,0,steel);part(.06,2.1,depth,-width/2,1.08,0,steel);part(.06,2.1,depth,width/2,1.08,0,steel);part(width,2.1,.05,0,1.08,-depth/2,steel)
      }
      group.add(furniture)
    }
  }
  if(options.roof&&g.roof?.style==='gable'){
    const r=g.roof,h=Math.max(...g.walls.map(w=>w.height),2.7),x0=b.minX-r.overhang,x1=b.minX+b.width+r.overhang,z0=b.minY-r.overhang,z1=b.minY+b.depth+r.overhang,rise=(r.axis==='x'?(z1-z0):(x1-x0))/2*Math.tan(r.pitch*Math.PI/180)
    const a=[x0,h,z0],bb=[x1,h,z0],c=[x1,h,z1],d=[x0,h,z1],ra=r.axis==='x'?[x0,h+rise,(z0+z1)/2]:[(x0+x1)/2,h+rise,z0],rb=r.axis==='x'?[x1,h+rise,(z0+z1)/2]:[(x0+x1)/2,h+rise,z1]
    const triangles=r.axis==='x'?[a,bb,rb,a,rb,ra,ra,rb,c,ra,c,d,a,ra,d,bb,c,rb]:[a,ra,rb,a,rb,d,ra,bb,c,ra,c,rb,a,bb,ra,d,rb,c]
    const roofGeo=new THREE.BufferGeometry();roofGeo.setAttribute('position',new THREE.Float32BufferAttribute(triangles.flat(),3));roofGeo.computeVertexNormals();geometries.push(roofGeo);const material=mat(r.colour);material.side=THREE.DoubleSide;const roof=new THREE.Mesh(roofGeo,material);roof.castShadow=true;group.add(roof)
  }
  group.add(annotations,dimensions)
  return {group,annotations,dimensions,setFinish(f){floor.color.set(f==='sage'?'#cfb590':'#dac9b1')},dispose(){geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose())}}
}

export function buildTracedModel(g:Geometry,options:ModelOptions):ModelScene {
  const group=new THREE.Group(),annotations=new THREE.Group(),dimensions=new THREE.Group(),b=geometryBounds(g)
  const models=levels(g).filter(l=>!options.floorId||options.floorId==='all'||l.id===options.floorId).map(l=>{
    const m=buildFloorModel(l.geometry,options);m.group.position.set(-b.minX-b.width/2,l.elevation,-b.minY-b.depth/2)
    m.group.remove(m.annotations,m.dimensions);m.annotations.position.copy(m.group.position);m.dimensions.position.copy(m.group.position)
    annotations.add(m.annotations);dimensions.add(m.dimensions);group.add(m.group);return m
  })
  group.add(annotations,dimensions)
  return {group,annotations,dimensions,setFinish(f){models.forEach(m=>m.setFinish(f))},dispose(){models.forEach(m=>m.dispose())}}
}
