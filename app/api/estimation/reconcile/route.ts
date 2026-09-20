import { NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
// Retired: completion now uses the owner-scoped, revision-checked profitability review.
export async function POST() {
  if (!await getAuthenticatedBuilderId()) return NextResponse.json({error:'Unauthorized'},{status:401})
  return NextResponse.json({error:'Use Job → Profitability → Review to reconcile actual costs and complete the job. No changes were made.',code:'USE_PROFITABILITY_REVIEW'},{status:410})
}
