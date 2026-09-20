import {createHash} from 'node:crypto'
import type {SupabaseClient} from '@supabase/supabase-js'
import {allRows} from './profitability-data'
import {calculateClientPrice} from './pricing'
import {quoteMarginPolicy} from './quote-margin-policy'
export async function quoteSendReview(db:SupabaseClient,builder:string,quote:string){
 const [items,profile]=await Promise.all([
  allRows(()=>db.from('quote_line_items').select('id,total,margin_pct,assumption_status').eq('quote_id',quote).order('id')),
  db.from('business_financial_profiles').select('profile').eq('builder_id',builder).maybeSingle(),
 ])
 if(profile.error)throw new Error('Could not verify business overheads. Refresh and try again.')
 const active=items.filter(i=>i.assumption_status!=='excluded')
 const result=quoteMarginPolicy(active.reduce((s,i)=>s+Number(i.total??0),0),calculateClientPrice(items),profile.data?.profile??null)
 const fingerprint=createHash('sha256').update(JSON.stringify({items,profile:profile.data?.profile??null})).digest('hex')
 return {...result,fingerprint}
}
