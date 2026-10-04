import test from 'node:test'
import assert from 'node:assert/strict'
import {vectorScale,vectorDimensions,validVectorDimensions} from './studio-vector-scale.ts'
const dimensions=[{label:'8000',metres:8,a:{x:0,y:10},b:{x:800,y:10}},{label:'6000',metres:6,a:{x:10,y:0},b:{x:10,y:600}},{label:'4000',metres:4,a:{x:0,y:20},b:{x:400,y:20}}]

test('text clipping masks are not mistaken for printed dimension spans',()=>{
 const codes={constructPath:1,moveTo:2,lineTo:3,clip:4,endPath:5,stroke:6,fill:7}
 const path=(x:number,y:number,width:number)=>[[2,3],[x,y,x+width,y]]
 const result=vectorDimensions({fnArray:[1,4,5,1,7,1,6],argsArray:[path(390,8,20),[],[],path(385,8,30),[],path(0,10,800),[]]},codes,[{str:'8000',width:20,transform:[1,0,0,1,390,8]}],{width:1000,convertToViewportPoint:(x,y)=>[x,y]})
 assert.deepEqual(result,[{label:'8000',a:{x:0,y:10},b:{x:800,y:10},metres:8}])
})
test('independent vector spans in both axes recover scale without user calibration',()=>{assert.equal(vectorScale(dimensions)?.metresPerUnit,.01);assert.equal(vectorScale(dimensions.slice(0,2)),null);assert.equal(vectorScale([...dimensions,{...dimensions[0],metres:2}]),null);assert.equal(vectorScale([dimensions[0],dimensions[0],dimensions[0]]),null)})
test('vector evidence rejects nonfinite and out-of-page coordinates',()=>{assert.ok(validVectorDimensions(dimensions,1));assert.equal(validVectorDimensions([{...dimensions[0],a:{x:Infinity,y:0}}],1),false);assert.equal(validVectorDimensions([{...dimensions[0],b:{x:0,y:1100}}],1),false)})
test('dimension extraction respects nested transforms and ignores curves',()=>{const codes={save:1,restore:2,transform:3,constructPath:4,moveTo:5,lineTo:6,curveTo:7,paintFormXObjectBegin:8,paintFormXObjectEnd:9,stroke:10};const result=vectorDimensions({fnArray:[1,3,4,10,2],argsArray:[[],[1,0,0,1,100,0],[[5,6],[0,10,800,10]],[],[]]},codes,[{str:'8000',width:20,transform:[1,0,0,1,490,8]}],{width:1000,convertToViewportPoint:(x,y)=>[x,y]});assert.deepEqual(result,[{label:'8000',a:{x:100,y:10},b:{x:900,y:10},metres:8}])})
