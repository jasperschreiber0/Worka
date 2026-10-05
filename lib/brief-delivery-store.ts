import type {SupabaseClient} from '@supabase/supabase-js'
import type {BriefDeliveryIO,BriefDeliveryState,BriefPending} from './brief-delivery.ts'

export function briefDeliveryStore(db:SupabaseClient,builderId:string,send:(pending:BriefPending)=>Promise<boolean>):BriefDeliveryIO{
  const token=globalThis.crypto.randomUUID()
  return {
    async claim(){
      const seed=await db.from('morning_brief_delivery').upsert({builder_id:builderId},{onConflict:'builder_id',ignoreDuplicates:true});if(seed.error)throw seed.error
      const now=new Date(),lease=new Date(now.getTime()+5*60000).toISOString()
      const result=await db.from('morning_brief_delivery').update({lease_token:token,lease_until:lease}).eq('builder_id',builderId).lt('lease_until',now.toISOString()).select('state').maybeSingle()
      if(result.error)throw result.error
      return result.data?.state as BriefDeliveryState||null
    },
    async save(state){
      const {data,error}=await db.from('morning_brief_delivery').update({state}).eq('builder_id',builderId).eq('lease_token',token).select('builder_id').single()
      if(error||!data)throw error||new Error('Morning brief lease lost')
    },
    async release(){
      const {error}=await db.from('morning_brief_delivery').update({lease_until:'1970-01-01T00:00:00Z',lease_token:null}).eq('builder_id',builderId).eq('lease_token',token)
      if(error)throw error
    },send,
  }
}
