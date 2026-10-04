import test from 'node:test'
import assert from 'node:assert/strict'
import {estimateReadiness,itemReadiness} from './studio-readiness.ts'
import {newWorkspace,recordApproval,clientProjection} from './studio-workspace.ts'
import {rectangleGeometry} from './studio-geometry.ts'
import type {Line} from './project-studio.ts'
const line:Line={id:'test',name:'Floor finish',trade:'Interiors',unit:'m²',quantity:1,source:'area',rate:0,labour:0,included:true,allowance:false,note:'',rateVerified:true}
function workspace(){const w=newWorkspace();w.project.working.design.geometry=rectangleGeometry(8,6,2.7);w.project.working.design.geometry.verified=true;w.project.working.lines=[{...line}];return w}
test('checked zero-price items remain unpriced and block real-project approval',()=>{const w=workspace();assert.equal(itemReadiness(w.project.working.lines[0],w.project.working),'Unpriced');assert.equal(estimateReadiness(w.project.working).unpriced,1);assert.throws(()=>recordApproval(w,'Builder','Meeting record'),/Price every included item/);assert.equal(clientProjection(w).current.reviewRequired,true)})
test('labour-only pricing counts while excluded items do not inflate readiness warnings',()=>{const w=workspace();w.project.working.lines[0].labour=40;w.project.working.lines.push({...line,id:'excluded',included:false});assert.equal(estimateReadiness(w.project.working).unpriced,0);assert.equal(itemReadiness(w.project.working.lines[0],w.project.working),'Reviewed');assert.doesNotThrow(()=>recordApproval(w,'Builder','Meeting record'));assert.equal(clientProjection(w).current.reviewRequired,false)})
test('zero entered quantity is unresolved even when its rate is reviewed',()=>{const w=workspace();w.project.working.lines=[{...line,source:'entered',rate:50,quantity:0}];assert.equal(itemReadiness(w.project.working.lines[0],w.project.working),'Needs quantity');assert.equal(estimateReadiness(w.project.working).missingQuantities,1);assert.throws(()=>recordApproval(w,'Builder','Meeting record'),/quantities/)})
