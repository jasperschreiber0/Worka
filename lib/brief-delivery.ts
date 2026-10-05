import type {BriefAction,SentActions} from './brief-actions.ts'
import {dueActions,recordSent} from './brief-actions.ts'
import {buildBriefEmail} from './morning-brief.ts'
import type {BriefEmail} from './morning-brief.ts'

export type BriefPending={id:string;createdAt:string;to:string;email:BriefEmail;actions:BriefAction[]}
export type BriefDeliveryState={sent:SentActions;pending:BriefPending|null}
export interface BriefDeliveryIO {
  claim:()=>Promise<BriefDeliveryState|null>
  save:(state:BriefDeliveryState)=>Promise<void>
  release:()=>Promise<void>
  send:(pending:BriefPending)=>Promise<boolean>
}
/** Durable outbox: concurrent runs claim one lease. Failed/uncertain delivery
 * retries the identical payload and provider key, never an edited email. */
export async function deliverBrief(io:BriefDeliveryIO,builder:{name:string;email:string},actions:BriefAction[],now:Date):Promise<'sent'|'quiet'|'busy'|'failed'>{
  const state=await io.claim();if(!state)return 'busy'
  try{
    let pending=state.pending
    if(pending){
      // Resend only deduplicates for 24h. An uncertain older delivery needs
      // operator reconciliation rather than risking a duplicate email.
      if(now.getTime()-Date.parse(pending.createdAt)>=23*3600000)throw new Error('Unconfirmed morning brief delivery needs reconciliation')
    }else{
      const due=dueActions(actions,state.sent,now)
      if(!due.length){await io.save({sent:recordSent(state.sent,actions,[],now),pending:null});return 'quiet'}
      pending={id:globalThis.crypto.randomUUID(),createdAt:now.toISOString(),to:builder.email,email:buildBriefEmail(builder.name,'',due),actions:due}
      await io.save({...state,pending})
    }
    if(!await io.send(pending))return 'failed'
    await io.save({sent:recordSent(state.sent,actions,pending.actions,now),pending:null})
    return 'sent'
  }finally{await io.release()}
}
