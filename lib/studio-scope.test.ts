import test from 'node:test'
import assert from 'node:assert/strict'
import {newWorkspace,parseWorkspace,approvalIssues,clientProjection,newPlanProject} from './studio-workspace.ts'
import {newScopeReview,scopeIssues,validScopeReview,addScopePlaceholder,benchmarkComparison,registerPlanSource} from './studio-scope.ts'
import {totals,revise} from './project-studio.ts'
test('new jobs require an independent scope review without inheriting the previous job',()=>{
 const old=newWorkspace();old.scopeReview=newScopeReview();old.scopeReview.benchmark={totalInclGST:2300000,source:'PRIVATE builder reference',scopeConfirmed:false}
 const next=newPlanProject(old,'New house','');assert.ok(next.scopeReview);assert.equal(next.scopeReview.benchmark,undefined);assert.ok(approvalIssues(next).some(s=>s.includes('current source documents')));assert.ok(parseWorkspace(next))
})
test('included work gets an unpriced placeholder without replacing rates or duplicating links',()=>{
 const w=newWorkspace(),review=newScopeReview();review.items[0]={...review.items[0],status:'included',note:'Drawing A100, verify site setup'}
 const before=JSON.stringify(w.project),result=addScopePlaceholder(review,w.project.working,'preliminaries','scope-1')
 assert.equal(JSON.stringify(w.project),before);assert.equal(result.lines[0].quantity,0);assert.equal(result.lines[0].rate,0)
 w.scopeReview=result.review;w.project=revise(w.project,{lines:result.lines});assert.ok(parseWorkspace(w));assert.ok(approvalIssues(w).some(s=>s.includes('zero quantity')))
 assert.throws(()=>addScopePlaceholder(result.review,w.project.working,'preliminaries','duplicate'),/existing/)
 w.project.working.lines=[];assert.ok(scopeIssues(result.review,w.project.working).some(s=>s.includes('removed')))
})
test('benchmark never changes the calculated estimate or exposes private evidence to clients',()=>{
 const w=newWorkspace(),before=totals(w.project.working);w.scopeReview=newScopeReview();w.scopeReview.benchmark={totalInclGST:2300000,source:'PRIVATE builder reference',scopeConfirmed:false}
 assert.deepEqual(totals(w.project.working),before);assert.equal(benchmarkComparison(w.scopeReview,w.project.working,before.total)?.comparable,false)
 assert.ok(!JSON.stringify(clientProjection(w)).includes('PRIVATE'));assert.equal(clientProjection(w).current.reviewRequired,true)
 assert.deepEqual(parseWorkspace(JSON.stringify(w))?.scopeReview,w.scopeReview)
})
test('malformed scope imports and nonfinite benchmark values are rejected',()=>{
 const w=newWorkspace();w.scopeReview=newScopeReview();assert.ok(validScopeReview(w.scopeReview));w.scopeReview.items.pop();assert.equal(parseWorkspace(w),null)
 w.scopeReview=newScopeReview();w.scopeReview.benchmark={totalInclGST:Infinity,source:'x',scopeConfirmed:false};assert.equal(parseWorkspace(w),null)
 w.scopeReview=newScopeReview();w.scopeReview.documents=[{name:'plans',pages:-1,revision:'',status:'current',note:''}];assert.equal(parseWorkspace(w),null)
})
test('excluding a scope cannot conceal an included linked cost',()=>{
 const w=newWorkspace(),review=newScopeReview();review.items[0]={...review.items[0],status:'included',note:'site'}
 const result=addScopePlaceholder(review,w.project.working,'preliminaries','scope-1');result.review.items[0].status='excluded';w.project.working.lines=result.lines
 assert.ok(scopeIssues(result.review,w.project.working).some(s=>s.includes('excluded scope still')))
})
test('uploaded sources register once without overwriting a reviewed document',()=>{
 const initial=newScopeReview(),registered=registerPlanSource(initial,'Plans.pdf',6,'B')
 assert.equal(initial.documents.length,0);assert.equal(registered.documents[0].status,'unreviewed');assert.match(registered.documents[0].note,/total page count/)
 registered.documents[0].status='current';assert.equal(registerPlanSource(registered,'Plans.pdf',6,'B'),registered);assert.ok(validScopeReview(registered))
})
