import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildModel } from './studio-scene'
import type { ModelOptions, ModelScene } from './studio-scene'
import {levels,geometryBounds} from '@/lib/studio-geometry'
import type { Design } from '@/lib/project-studio'

export type CameraView = 'perspective' | 'plan' | 'front' | 'side'
export type Viewer = {
  update: (design: Design, options: ModelOptions) => void
  view: (view: CameraView) => void
  reset: () => void
  zoom: (direction: number) => void
  rotate: (x: number, y: number) => void
  expanded: (value: boolean) => void
  dispose: () => void
  exportImage: () => string
  walk: (roomId:string) => void
  move: (forward:number,side:number) => void
  saveView: () => {position:number[];zoom:number}
  restoreView: (view:{position:number[];zoom:number}) => void
}

export function createViewer(host: HTMLDivElement, initialDesign: Design, initialOptions: ModelOptions, onContextLost: () => void, onSelectWall?: (id:string)=>void): Viewer {
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'})
  const canvas=renderer.domElement
  canvas.setAttribute('aria-hidden','true')
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1,1.5))
  renderer.setClearColor('#faf9f5',0)
  renderer.outputColorSpace=THREE.SRGBColorSpace
  renderer.toneMapping=THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure=1.2
  renderer.shadowMap.enabled=true
  renderer.shadowMap.type=THREE.PCFSoftShadowMap
  // Light and model are stationary during orbit: reuse the shadow map.
  renderer.shadowMap.autoUpdate=false
  host.appendChild(canvas)
  const scene=new THREE.Scene()
  const camera=new THREE.OrthographicCamera(-8,8,6,-6,.1,1000)
  const walkCamera=new THREE.PerspectiveCamera(65,1,.03,1000)
  let walking=false,yaw=0,pitch=0,looking=false,lastPointer={x:0,y:0}
  const activeCamera=()=>walking?walkCamera:camera
  function look(){walkCamera.rotation.order='YXZ';walkCamera.rotation.set(pitch,yaw,0);requestDraw()}
  const target=new THREE.Vector3(0,.35,0)
  camera.position.set(10,10,13);camera.lookAt(target)
  const controls=new OrbitControls(camera,canvas)
  controls.target.copy(target)
  controls.enableDamping=true;controls.dampingFactor=.12
  controls.rotateSpeed=.58;controls.zoomSpeed=.6;controls.enablePan=false
  controls.minPolarAngle=.03;controls.maxPolarAngle=Math.PI/2-.13
  controls.minZoom=.65;controls.maxZoom=1.8
  controls.update()
  const ambient=new THREE.HemisphereLight('#fffaf0','#b8c5b5',2.6)
  const sun=new THREE.DirectionalLight('#fff7e9',3.3)
  sun.position.set(-5,12,7);sun.castShadow=true
  sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=-10;sun.shadow.camera.right=10
  sun.shadow.camera.top=10;sun.shadow.camera.bottom=-10
  sun.shadow.normalBias=.045;sun.shadow.bias=-.00015;sun.shadow.radius=3
  const fill=new THREE.DirectionalLight('#e2ebf5',1.2);fill.position.set(8,7,-7)
  scene.add(ambient,sun,fill)
  const groundGeometry=new THREE.PlaneGeometry(200,200)
  const groundMaterial=new THREE.ShadowMaterial({color:'#7a8174',opacity:.16})
  const ground=new THREE.Mesh(groundGeometry,groundMaterial);ground.rotation.x=-Math.PI/2;ground.position.y=-.225;ground.receiveShadow=true
  scene.add(ground)
  let model:ModelScene, currentDesign=initialDesign, currentOptions=initialOptions
  let frame=0,disposed=false,inView=true,lost=false,fullscreen=false
  let previousFrame=0,consecutive=false,frameCount=0
  const frameTimes:number[]=[],renderTimes:number[]=[]
  const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)')
  let desiredView:CameraView='perspective'
  let tween:{start:number;from:THREE.Vector3;to:THREE.Vector3;fromZoom:number;toZoom:number}|null=null
  const home=new THREE.Vector3(10,10,13)
  let pendingModel:{design:Design;options:ModelOptions}|null=null
  function requestDraw(){
    if(!frame&&!disposed&&!lost&&inView&&!document.hidden) frame=requestAnimationFrame(draw)
  }
  function setModel(design:Design, options:ModelOptions){
    const changed=!model || design.geometry!==currentDesign.geometry || design.width!==currentDesign.width || design.depth!==currentDesign.depth || design.height!==currentDesign.height || options.walls!==currentOptions.walls || options.roof!==currentOptions.roof || options.section!==currentOptions.section || options.selectedWall!==currentOptions.selectedWall || options.floorId!==currentOptions.floorId || options.furniture!==currentOptions.furniture
    if(changed){
      if(model){scene.remove(model.group);model.dispose()}
      model=buildModel(design,options);scene.add(model.group)
      const diagonal=Math.hypot(design.width,design.depth),distance=Math.max(20,diagonal*1.6)
      home.set(10,10,13).normalize().multiplyScalar(distance)
      camera.position.sub(controls.target).normalize().multiplyScalar(distance).add(controls.target)
      sun.shadow.camera.left=-diagonal/2-2;sun.shadow.camera.right=diagonal/2+2
      sun.shadow.camera.top=diagonal/2+2;sun.shadow.camera.bottom=-diagonal/2-2;sun.shadow.camera.far=500
      sun.position.set(-5,12,7).normalize().multiplyScalar(Math.max(16,diagonal*1.5));sun.shadow.camera.updateProjectionMatrix()
      renderer.shadowMap.needsUpdate=true
    }
    currentDesign=design;currentOptions=options
    model.setFinish(options.finish)
    model.annotations.visible=options.labels && !options.presentation
    model.dimensions.visible=options.dimensions && !options.presentation
  }
  function recordDiagnostics(){
    const percentile=(values:number[])=>values.length?values.slice().sort((a,b)=>a-b)[Math.floor((values.length-1)*.95)].toFixed(2):'0'
    canvas.dataset.frames=String(frameCount)
    canvas.dataset.frameP95=percentile(frameTimes)
    canvas.dataset.renderP95=percentile(renderTimes)
    canvas.dataset.drawCalls=String(renderer.info.render.calls)
    canvas.dataset.triangles=String(renderer.info.render.triangles)
    canvas.dataset.renderState=frame?'moving':'idle'
  }
  function draw(now:number){
    frame=0
    if(disposed||lost||!inView||document.hidden){consecutive=false;return}
    const start=performance.now()
    if(consecutive&&previousFrame) {frameTimes.push(now-previousFrame);if(frameTimes.length>180)frameTimes.shift()}
    previousFrame=now
    if(pendingModel){const pending=pendingModel;pendingModel=null;setModel(pending.design,pending.options);resize(false)}
    if(tween){
      const t=Math.min(1,(now-tween.start)/420),ease=1-Math.pow(1-t,3)
      camera.position.lerpVectors(tween.from,tween.to,ease)
      camera.zoom=THREE.MathUtils.lerp(tween.fromZoom,tween.toZoom,ease)
      camera.updateProjectionMatrix()
      if(t===1){tween=null;controls.enableDamping=!reducedMotion.matches}
      else requestDraw()
    }
    controls.update()
    renderer.render(scene,activeCamera())
    frameCount++
    renderTimes.push(performance.now()-start);if(renderTimes.length>180)renderTimes.shift()
    consecutive=!!frame
    if(!frame||frameCount%30===0)recordDiagnostics()
  }
  function resize(schedule=true){
    const {width,height}=host.getBoundingClientRect()
    if(width<1||height<1)return
    const aspect=width/height
    walkCamera.aspect=aspect;walkCamera.updateProjectionMatrix()
    // Fit the entire footprint through a full orbit, including dimension markers.
    const diagonal=Math.hypot(currentDesign.width,currentDesign.depth)+2
    const buildingHeight=currentDesign.geometry?Math.max(...levels(currentDesign.geometry).map(l=>l.elevation+Math.max(...l.geometry.walls.map(w=>w.height),2.7))):currentDesign.height
    const vertical=Math.max(9,buildingHeight*2.2,diagonal/aspect)
    camera.left=-vertical*aspect/2;camera.right=vertical*aspect/2
    camera.top=vertical/2;camera.bottom=-vertical/2
    camera.updateProjectionMatrix();renderer.setSize(width,height,false)
    if(schedule)requestDraw()
  }
  function transition(destination:THREE.Vector3,zoom=camera.zoom){
    // Drain residual orbit momentum before an explicit camera preset.
    controls.enableDamping=false;controls.update()
    if(reducedMotion.matches){
      camera.position.copy(destination);camera.zoom=zoom;camera.updateProjectionMatrix();controls.update()
      tween=null
    }else tween={start:performance.now(),from:camera.position.clone(),to:destination,fromZoom:camera.zoom,toZoom:zoom}
    requestDraw()
  }
  function changeView(view:CameraView){
    walking=false;controls.enabled=true
    desiredView=view;controls.enableRotate=view!=='plan'
    const direction=view==='plan'?new THREE.Vector3(0,20,.001):view==='front'?new THREE.Vector3(0,3,20):view==='side'?new THREE.Vector3(20,3,0):home.clone()
    transition(direction.normalize().multiplyScalar(home.length()),1)
  }
  function start(){tween=null;controls.enableDamping=!reducedMotion.matches;canvas.classList.add('is-dragging');requestDraw()}
  function end(){canvas.classList.remove('is-dragging');requestDraw()}
  function wheel(e:WheelEvent){
    // Embedded viewers must not trap the page's normal scroll.
    if(!fullscreen&&!e.ctrlKey&&!e.metaKey)e.stopImmediatePropagation()
  }
  canvas.addEventListener('wheel',wheel,{capture:true,passive:true})
  function contextLost(e:Event){e.preventDefault();lost=true;if(frame)cancelAnimationFrame(frame);frame=0;onContextLost()}
  canvas.addEventListener('webglcontextlost',contextLost)
  let pointerStart={x:0,y:0}
  const pointerDown=(e:PointerEvent)=>{pointerStart={x:e.clientX,y:e.clientY};lastPointer=pointerStart;looking=walking;if(walking)canvas.setPointerCapture(e.pointerId)}
  const pointerMove=(e:PointerEvent)=>{if(!looking)return;yaw-=(e.clientX-lastPointer.x)*.005;pitch=THREE.MathUtils.clamp(pitch-(e.clientY-lastPointer.y)*.005,-1.2,1.2);lastPointer={x:e.clientX,y:e.clientY};look()}
  const pointerUp=(e:PointerEvent)=>{looking=false;if(walking)return;if(Math.hypot(e.clientX-pointerStart.x,e.clientY-pointerStart.y)>5)return;const r=canvas.getBoundingClientRect();const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera);const hit=ray.intersectObject(model.group,true).find(h=>h.object.userData.wallId);if(hit)onSelectWall?.(hit.object.userData.wallId)}
  const pointerCancel=()=>{looking=false}
  canvas.addEventListener('pointercancel',pointerCancel)
  canvas.addEventListener('pointermove',pointerMove)
  canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointerup',pointerUp)
  function visibility(){if(document.hidden){if(frame)cancelAnimationFrame(frame);frame=0;consecutive=false}else requestDraw()}
  document.addEventListener('visibilitychange',visibility)
  function motion(){controls.enableDamping=!reducedMotion.matches;requestDraw()}
  reducedMotion.addEventListener('change',motion)
  controls.addEventListener('change',requestDraw);controls.addEventListener('start',start);controls.addEventListener('end',end)
  const observer=new ResizeObserver(()=>resize());observer.observe(host)
  const intersection=new IntersectionObserver(entries=>{inView=entries[0]?.isIntersecting??true;if(inView)requestDraw();else{if(frame)cancelAnimationFrame(frame);frame=0;consecutive=false}})
  intersection.observe(host)
  setModel(initialDesign,initialOptions)
  controls.enableDamping=!reducedMotion.matches
  resize()
  return {
    exportImage(){if(pendingModel){const next=pendingModel;pendingModel=null;setModel(next.design,next.options);resize(false)}renderer.render(scene,activeCamera());return canvas.toDataURL('image/png')},
    walk(roomId){const g=currentDesign.geometry;if(!g)return;const level=levels(g).find(l=>l.geometry.rooms?.some(r=>r.id===roomId)),room=level?.geometry.rooms?.find(r=>r.id===roomId);if(!level||!room)return;const b=geometryBounds(g),centre=room.polygon.reduce((s,p)=>({x:s.x+p.x/room.polygon.length,y:s.y+p.y/room.polygon.length}),{x:0,y:0});walking=true;controls.enabled=false;tween=null;yaw=0;pitch=0;walkCamera.position.set(centre.x-b.minX-b.width/2,level.elevation+1.6,centre.y-b.minY-b.depth/2);look()},
    move(forward,side){if(!walking)return;walkCamera.position.x+=(-Math.sin(yaw)*forward+Math.cos(yaw)*side)*.35;walkCamera.position.z+=(-Math.cos(yaw)*forward-Math.sin(yaw)*side)*.35;requestDraw()},
    saveView(){return {position:camera.position.toArray(),zoom:camera.zoom}},
    restoreView(v){walking=false;controls.enabled=true;desiredView='perspective';controls.enableRotate=true;transition(new THREE.Vector3().fromArray(v.position),v.zoom)},
    update(design,options){pendingModel={design,options};requestDraw()},
    view:changeView,
    reset(){walking=false;controls.enabled=true;desiredView='perspective';controls.enableRotate=true;transition(home.clone(),1)},
    zoom(direction){if(walking){walkCamera.fov=THREE.MathUtils.clamp(walkCamera.fov-direction*5,35,90);walkCamera.updateProjectionMatrix();requestDraw();return}transition(camera.position.clone(),THREE.MathUtils.clamp(camera.zoom*(direction>0?1.15:1/1.15),.65,1.8))},
    rotate(x,y){
      if(walking){yaw-=x;pitch=THREE.MathUtils.clamp(pitch-y,-1.2,1.2);look();return}
      if(desiredView==='plan')return
      const offset=camera.position.clone().sub(controls.target)
      const spherical=new THREE.Spherical().setFromVector3(offset)
      spherical.theta+=x;spherical.phi=THREE.MathUtils.clamp(spherical.phi+y,.03,Math.PI/2-.13)
      transition(new THREE.Vector3().setFromSpherical(spherical).add(controls.target))
    },
    expanded(value){fullscreen=value;resize()},
    dispose(){
      disposed=true;if(frame)cancelAnimationFrame(frame)
      observer.disconnect();intersection.disconnect()
      document.removeEventListener('visibilitychange',visibility)
      reducedMotion.removeEventListener('change',motion)
      controls.removeEventListener('change',requestDraw);controls.removeEventListener('start',start);controls.removeEventListener('end',end)
      canvas.removeEventListener('wheel',wheel,true);canvas.removeEventListener('webglcontextlost',contextLost)
      canvas.removeEventListener('pointerdown',pointerDown);canvas.removeEventListener('pointerup',pointerUp)
      canvas.removeEventListener('pointermove',pointerMove);canvas.removeEventListener('pointercancel',pointerCancel)
      controls.dispose();model?.dispose();groundGeometry.dispose();groundMaterial.dispose()
      sun.shadow.map?.dispose()
      renderer.dispose();renderer.forceContextLoss();canvas.remove()
    },
  }
}
