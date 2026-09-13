import {NextResponse} from 'next/server'
import {createClient} from '@supabase/supabase-js'
import {getAuthenticatedBuilderId,isDemoMode} from '@/lib/auth/api-auth'
export async function POST(_req:Request,{params}:{params:{quoteId:string;itemId:string}}) {
 const builderId=await getAuthenticatedBuilderId();if(!builderId||isDemoMode())return NextResponse.json({error:'Unauthorized'},{status:401})
 const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!)
 const {data:quote}=await db.from('quotes').select('id').eq('id',params.quoteId).eq('builder_id',builderId).maybeSingle()
 if(!quote)return NextResponse.json({error:'Quote not found'},{status:404})
 const {data:item}=await db.from('quote_line_items').select('id').eq('id',params.itemId).eq('quote_id',params.quoteId).maybeSingle()
 if(!item)return NextResponse.json({error:'Item not found'},{status:404})
 const {data,error}=await db.rpc('save_confirmed_builder_rate',{p_builder_id:builderId,p_item_id:params.itemId})
 if(error)return NextResponse.json({error:error.message},{status:400})
 return NextResponse.json({saved:true,id:data})
}
