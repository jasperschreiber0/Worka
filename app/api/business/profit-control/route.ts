import { NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { loadProfitControl } from '@/lib/profit-control-data'
export const dynamic = 'force-dynamic'
export async function GET() {
  const builder=await getAuthenticatedBuilderId()
  if(!builder)return NextResponse.json({error:'Unauthorized'},{status:401})
  if(isDemoMode())return NextResponse.json({error:'Connect your business to view real profit control figures'},{status:400})
  try { return NextResponse.json(await loadProfitControl(builder)) }
  catch(e) { console.error('profit_control_load_failed',e instanceof Error ? e.message : 'Unknown error'); return NextResponse.json({error:'Could not load profit control. Please retry.'},{status:503}) }
}
