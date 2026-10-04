import {cashDate,addDays,validateCashPlan,projectCash} from './cash-plan.ts'
import type {CashEntry} from './cash-plan.ts'
import {financials,stages} from './project-studio.ts'
import type {Workspace} from './studio-workspace.ts'
export type ProjectCashTiming={startOn:string;opening:number;buffer:number;costGstPercent:number|null;stages:{receiptOn:string;paymentOn:string}[]}
export function defaultProjectTiming(startOn:string):ProjectCashTiming{return {startOn,opening:0,buffer:0,costGstPercent:null,stages:stages.map((_,i)=>({receiptOn:addDays(startOn,i*28),paymentOn:addDays(startOn,i*28)}))}}
export function validProjectTiming(t:any):t is ProjectCashTiming{return !!t&&cashDate(t.startOn)&&Number.isFinite(t.opening)&&Math.abs(t.opening)<=1e9&&Number.isFinite(t.buffer)&&t.buffer>=0&&t.buffer<=1e9&&(t.costGstPercent===null||(Number.isFinite(t.costGstPercent)&&t.costGstPercent>=0&&t.costGstPercent<=20))&&Array.isArray(t.stages)&&t.stages.length===stages.length&&t.stages.every((s:any)=>s&&cashDate(s.receiptOn)&&cashDate(s.paymentOn))}
export function projectCashForecast(w:Workspace,t:ProjectCashTiming,basis:'proposed'|'accepted'){
 if(!validProjectTiming(t)||t.costGstPercent===null)throw new Error('Enter valid payment dates and the GST allowance on project costs.')
 if(basis==='accepted'&&!w.project.baseline)throw new Error('No accepted contract is recorded.')
 const p=basis==='proposed'?{...w.project,baseline:null,variations:[]}:w.project,f=financials(p)
 const receiptCents=Math.round(f.revenue*1.1*100),paymentCents=Math.round(f.forecast*(1+t.costGstPercent/100)*100)
 let received=0,paid=0
 const entries:CashEntry[]=stages.flatMap((stage,i)=>{
  const receipt=i===stages.length-1?receiptCents-received:Math.round(receiptCents*stage.percent/100),payment=i===stages.length-1?paymentCents-paid:Math.round(paymentCents*stage.costPercent/100);received+=receipt;paid+=payment
  return ([['in',receipt,t.stages[i].receiptOn],['out',payment,t.stages[i].paymentOn]] as const).filter(([,amount])=>amount>0).map(([direction,amount,on])=>({id:`stage-${i}-${direction}`,label:stage.name+(direction==='in'?' receipt':' costs'),direction,amount:amount/100,dueOn:on,expectedOn:on,frequency:'once' as const,endOn:'',timing:'day' as const,note:'Illustrative stage allocation. Replace with contract milestones and actual supplier payment timing. Not a booked bank movement.'}))
 })
 const plan=validateCashPlan({version:1,startOn:t.startOn,opening:t.opening,buffer:t.buffer,accounts:'Project cash scenario only',complete:false,entries})
 return {plan,weeks:projectCash(plan),months:projectCash(plan,undefined,'12-months'),receipts:receiptCents/100,payments:paymentCents/100}
}
