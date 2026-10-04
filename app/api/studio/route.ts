import { NextRequest,NextResponse } from 'next/server'
import { identity,sameOrigin,listProjects,getProject,saveProject,StoreError,localMode,createShare,reviews,revoke } from '@/lib/studio-store'
import { clientProjection } from '@/lib/studio-workspace'
export const runtime='nodejs'
export const dynamic='force-dynamic'
function failure(e:unknown){return NextResponse.json({error:e instanceof Error?e.message:'Unable to complete request.'},{status:e instanceof StoreError?e.status:500})}
export async function GET(req:NextRequest){try{const owner=await identity(req),id=req.nextUrl.searchParams.get('id');if(req.nextUrl.searchParams.get('reviews')&&id)return NextResponse.json({reviews:await reviews(owner,id)});return NextResponse.json(id?{record:await getProject(owner,id),local:localMode()}:{projects:await listProjects(owner),local:localMode(),owner},{headers:{'Cache-Control':'no-store'}})}catch(e){return failure(e)}}
export async function POST(req:NextRequest){try{sameOrigin(req);const owner=await identity(req),raw=await req.text();if(raw.length>12000000)throw new StoreError('Project exceeds the save limit.',413);const body=JSON.parse(raw)
  if(body.action==='revoke'){await revoke(owner,body.id);return NextResponse.json({ok:true})}
  if(body.action==='share'){const p=await getProject(owner,body.id);if(!p)throw new StoreError('Save this project before creating a review.',404);return NextResponse.json({...await createShare(owner,body.id,clientProjection(p.workspace)),local:localMode()})}
  if(!Number.isInteger(body.version)||body.version<0)throw new StoreError('Invalid save version.')
  return NextResponse.json({record:await saveProject(owner,body.workspace,body.version,typeof body.label==='string'?body.label.slice(0,200):'Saved revision'),local:localMode()})
}catch(e){return failure(e)}}
