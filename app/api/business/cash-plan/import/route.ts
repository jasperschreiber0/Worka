import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { cashDate } from '@/lib/cash-plan'
import { previewCashWorkbook } from '@/lib/cash-import'
export const runtime='nodejs'
export async function POST(req:NextRequest) {
  if(!await getAuthenticatedBuilderId()) return NextResponse.json({error:'Unauthorized'},{status:401})
  try {
    if(Number(req.headers.get('content-length')??0)>5_500_000) throw new Error('Use a workbook smaller than 5 MB')
    const data=await req.formData(), file=data.get('file'), start=String(data.get('firstWeekEnd')??'')
    if(!(file instanceof File)||file.size>5_000_000||!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('Choose an .xlsx workbook smaller than 5 MB')
    if(!cashDate(start)) throw new Error('Choose the first week-ending date to import')
    return NextResponse.json(await previewCashWorkbook(Buffer.from(await file.arrayBuffer()),start))
  } catch(e){return NextResponse.json({error:(e as Error).message},{status:400})}
}
