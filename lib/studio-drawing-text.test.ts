import test from 'node:test'
import assert from 'node:assert/strict'
import {drawingText,validDrawingText} from './studio-drawing-text.ts'
import {recognisedPlan} from './studio-recognition.ts'
const points=[{x:100,y:100},{x:900,y:100},{x:900,y:500},{x:100,y:500}]
const sample=()=>({kind:'floor-plan',dimension:null,warnings:[],footprint:points,walls:points.map((a,i)=>({name:'Wall',a,b:points[(i+1)%4],height:2.7,thickness:.15,openings:[]})),dimensions:[{label:'8000',a:points[0],b:points[1],metres:8},{label:'4000',a:points[1],b:points[2],metres:4}]})
test('PDF labels follow viewport transforms rather than assuming page origin or rotation',()=>{const t=drawingText([{str:'11,080',transform:[1,0,0,1,20,30]}],{width:200,height:100,convertToViewportPoint:(x,y)=>[y,100-x]});assert.deepEqual(t,[{text:'11,080',x:150,y:400}]);assert.ok(validDrawingText(t,2));assert.equal(validDrawingText([{text:'x',x:NaN,y:0}],2),false);assert.equal(validDrawingText([{text:'x',x:0,y:501}],2),false)})
test('two independent agreeing printed spans can recover missing primary dimension',()=>{const r=recognisedPlan(sample(),1.25);assert.equal(r.design.width,8);assert.equal(r.design.depth,4);assert.equal(r.geometry.verified,false)})
test('conflicting or duplicated dimension spans cannot silently supply scale',()=>{const v=sample();v.dimensions[1].metres=5;assert.throws(()=>recognisedPlan(v,1.25),/disagree/);v.dimensions=[v.dimensions[0],v.dimensions[0]];assert.throws(()=>recognisedPlan(v,1.25),/No readable/);assert.equal(recognisedPlan(v,1.25,.01).design.width,8)})
test('primary scale is checked against independent printed dimensions',()=>{const v={...sample(),dimension:{a:points[0],b:points[1],metres:10}};assert.throws(()=>recognisedPlan(v,1.25),/disagree/)})
