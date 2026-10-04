import {acceptedRevision,financials,lineCost,quantity,round} from './project-studio.ts'
import type {StudioProject,Line} from './project-studio.ts'
export type RateLesson={id:string;at:string;revision:number;lineId:string;name:string;unit:string;quantity:number;material:number;labour:number;waste:number;oldRate:number;oldLabour:number;rate:number;labourRate:number;reason:string}
export function tradeOutcomes(p:StudioProject){return financials(p).rows.map(r=>({...r,ready:!!p.baseline&&!!r.complete&&r.actual>=r.committed,variance:round(r.actual-r.budget),percent:r.budget?round((r.actual-r.budget)/r.budget*100):null}))}
export function learnRate(p:StudioProject,lineId:string,input:{quantity:number;material:number;labour:number;reason:string},id:string,at=new Date().toISOString()):RateLesson{
 const r=acceptedRevision(p),line=r?.lines.find(l=>l.id===lineId&&l.included)
 if(!r||!line)throw new Error('Choose an item from agreed scope.')
 if(!tradeOutcomes(p).find(t=>t.trade===line.trade)?.ready)throw new Error('Complete the trade and settle its commitments first.')
 if(!Number.isFinite(input.quantity)||input.quantity<=0||input.quantity>1e7||[input.material,input.labour].some(n=>!Number.isFinite(n)||n<0||n>1e7)||input.material+input.labour<=0)throw new Error('Enter a positive measured quantity and actual item costs.')
 if(!input.reason.trim()||input.reason.length>2000)throw new Error('Record the invoice reference and reason for the difference.')
 const trade=p.costs.find(c=>c.trade===line.trade)!
 if(input.material+input.labour>trade.actual+.01)throw new Error('Item costs exceed the actual costs recorded for this trade.')
 return {id,at,revision:r.id,lineId,name:line.name,unit:line.unit,quantity:input.quantity,material:input.material,labour:input.labour,waste:line.waste||0,oldRate:line.rate,oldLabour:line.labour||0,rate:round(input.material/input.quantity/(1+(line.waste||0)/100)),labourRate:round(input.labour/input.quantity),reason:input.reason.trim()}
}
export function lessonRate(lesson:RateLesson,line:Line,id:string):Line{return {...structuredClone(line),id,rate:lesson.rate,labour:lesson.labourRate,waste:lesson.waste,quantity:1,wallId:undefined,roomId:undefined,rateVerified:false,note:'Reviewed job evidence · R'+lesson.revision+' · '+lesson.at+' · '+lesson.reason}}
export function validLessons(value:unknown):value is RateLesson[]{return Array.isArray(value)&&value.length<=100&&new Set(value.map(v=>v?.id)).size===value.length&&value.every(v=>v&&['id','lineId','name','unit','reason'].every(k=>typeof v[k]==='string'&&v[k].length<=2000)&&typeof v.at==='string'&&Number.isFinite(Date.parse(v.at))&&['revision','quantity','material','labour','waste','oldRate','oldLabour','rate','labourRate'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k])&&v[k]>=0&&v[k]<=1e9)&&v.quantity>0&&v.waste<=100)}
