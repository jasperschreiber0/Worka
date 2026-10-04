import {NextRequest,NextResponse} from 'next/server'
import {identity,StoreError} from '@/lib/studio-store'
import {renderRepository} from '@/lib/studio-render-store'
export const runtime='nodejs',dynamic='force-dynamic'
export async function GET(req:NextRequest){try{
 const owner=await identity(req),projectId=req.nextUrl.searchParams.get('projectId')||'',id=req.nextUrl.searchParams.get('id'),store=await renderRepository()
 return NextResponse.json(id?{render:await store.read(owner,projectId,id)}:{renders:await store.list(owner,projectId)},{headers:{'Cache-Control':'private, no-store'}})
}catch(e){return NextResponse.json({error:e instanceof StoreError?e.message:'Saved images could not be opened.'},{status:e instanceof StoreError?e.status:400,headers:{'Cache-Control':'no-store'}})}}
