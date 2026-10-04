import test from 'node:test'
import assert from 'node:assert/strict'
import {newWorkspace,parseWorkspace} from './studio-workspace.ts'
import {rectangleGeometry,buildingDimensions} from './studio-geometry.ts'
import {omitWallProposal,meetingFinancials} from './studio-meeting.ts'
import {totals} from './project-studio.ts'
function fixture(){const w=newWorkspace();w.project.working.design=buildingDimensions(rectangleGeometry(8,6,2.7));w.project.working.lines=[{id:'a',trade:'Interiors',name:'Partition',unit:'m²',quantity:0,rate:50,source:'wall-area',wallId:w.project.working.design.geometry!.walls[0].id,allowance:true,included:true,note:''}];return w}
test('wall omission excludes only linked work, preserves source and adds explicit related-work allowance',()=>{const w=fixture(),before=structuredClone(w),id=w.project.working.lines[0].wallId!;const p=omitWallProposal(w,id,500);assert.deepEqual(w,before);assert.equal(p.project.working.design.geometry!.walls.length,3);assert.equal(p.project.working.lines[0].included,false);assert.equal(totals(p.project.working).cost,500);assert.equal(p.project.baseline,null);assert.ok(parseWorkspace(p));assert.throws(()=>omitWallProposal(w,id,-1));assert.throws(()=>omitWallProposal(w,'unknown',0))})
test('proposed finance does not erase commitments or mutate accepted contract',()=>{const w=fixture();w.project.baseline=structuredClone(w.project.working);w.project.costs.find(c=>c.trade==='Interiors')!.committed=900;const p=omitWallProposal(w,w.project.working.lines[0].wallId!,0),f=meetingFinancials(p);assert.equal(f.proposed.forecast,900);assert.equal(f.current.revenue,totals(w.project.baseline!).price);assert.deepEqual(p.project.baseline,w.project.baseline)})
