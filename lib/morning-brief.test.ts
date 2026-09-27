import test from 'node:test'
import assert from 'node:assert/strict'
import {buildBriefEmail,shouldSendBrief} from './morning-brief.ts'

test('count-only and empty briefs do not trigger email',()=>{
  assert.equal(shouldSendBrief([]),false)
  assert.equal(shouldSendBrief([{priority:'low',message:'2 jobs',entity_type:'summary'}]),false)
  assert.equal(shouldSendBrief([{priority:'medium',message:'Job needs prices',action:'Review',entity_type:'quote'}]),true)
})
test('brief replaces stale all-clear prose with recorded evidence and direct links',()=>{
  const email=buildBriefEmail('Chris Builder','All clear today',[{priority:'medium',message:'Alfred Street: 2 missing prices.',action:'Continue estimate review',href:'/jobs/abc-123',entity_type:'quote'}])
  assert.match(email.text,/Alfred Street: 2 missing prices/)
  assert.match(email.text,/\/jobs\/abc-123/)
  assert.match(email.html,/Review today’s jobs/)
  assert.match(email.text,/Missing or outdated records/)
  assert.doesNotMatch(email.text+email.subject,/all clear|\/chat/i)
})
test('untrusted job names are escaped and external links cannot enter the email',()=>{
  const email=buildBriefEmail('<img src=x>','',[{priority:'high',message:'<script>alert(1)</script>',action:'"Click"',href:'//evil.example/steal'}])
  assert.doesNotMatch(email.html,/<script>|<img|evil\.example/)
  assert.match(email.html,/&lt;script&gt;/)
  assert.match(email.text,/\/today/)
})
test('urgent actions lead, with bounded detail and remaining count',()=>{
  const email=buildBriefEmail('Chris','',Array.from({length:10},(_,i)=>({priority:i===9?'high' as const:'medium' as const,message:`Action ${i}`,action:'Review',href:'/jobs/abc'})))
  assert.ok(email.text.indexOf('Action 9')<email.text.indexOf('Action 0'))
  assert.match(email.text,/2 more actions/)
  assert.equal((email.html.match(/<section /g)||[]).length,8)
})
