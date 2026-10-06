import {totals,round} from './project-studio.ts'
import type {Line,Revision} from './project-studio.ts'
const allowances:Record<string,[number,number,string]>={framing:[55,45,'Standard timber stud wall; structural steel and roof framing excluded.'],insulation:[15,10,'Standard wall batts; specified R-value and garage inclusion need review.'],'internal lining':[18,32,'One standard plasterboard face, fixed, set and sanded; special fire/wet-area systems excluded.'],painting:[5,20,'Internal wall preparation and standard paint finish; special coatings excluded.']}
const work=(l:Line)=>l.name.split(' · ').at(-1)!.trim().toLowerCase()
export function preparePriceDraft(r:Revision,rates:Line[]){
 let suggested=0,saved=0
 const lines=r.lines.map(l=>{
  if(!l.included||l.rate+(l.labour||0)>0)return l
  const match=rates.find(a=>a.rateVerified&&a.unit===l.unit&&a.source===l.source&&a.trade===l.trade&&work(a)===work(l)&&a.rate+(a.labour||0)>0&&a.note===l.note)
  if(match){saved++;return {...l,rate:match.rate,labour:match.labour||0,waste:match.waste||0,rateVerified:false,supplier:match.supplier,note:l.note+' Saved builder rate proposed; confirm applicability.'}}
  const a=l.source==='wall-area'&&l.unit==='m²'&&!l.packageId?allowances[work(l)]:undefined
  if(!a)return l
  suggested++;return {...l,rate:a[0],labour:a[1],waste:0,rateVerified:false,note:l.note+' Suggested allowance (7 Oct 2026), not a supplier quote. '+a[2]+' Ordinary waste included.'}
 })
 const revision={...r,lines},missing=lines.filter(l=>l.included&&l.rate+(l.labour||0)<=0).length
 return {revision,suggested,saved,missing,total:totals(revision)}
}
export function markupForTotal(r:Revision,total:number){const cost=totals(r).cost;if(!Number.isFinite(total)||cost<=0||total<round(cost*1.1)||total>round(cost*2.2))throw new Error('Enter a total between estimated cost plus GST and twice estimated cost plus GST.');return Math.max(0,Math.min(100,(total/1.1/cost-1)*100))}
