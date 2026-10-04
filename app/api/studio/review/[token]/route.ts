import { NextRequest,NextResponse } from 'next/server'
import { getShare,addFeedback,sameOrigin,StoreError } from '@/lib/studio-store'
export const dynamic='force-dynamic'
export const runtime='nodejs'
function failure(e:unknown){return NextResponse.json({error:e instanceof Error?e.message:'Review unavailable.'},{status:e instanceof StoreError?e.status:500})}
export async function GET(_req:NextRequest,{params}:{params:{token:string}}){try{const s=await getShare(params.token);return NextResponse.json({payload:s.payload,expiresAt:s.expiresAt},{headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}})}catch(e){return failure(e)}}
export async function POST(req:NextRequest,{params}:{params:{token:string}}){try{sameOrigin(req);const text=await req.text();if(text.length>5000)throw new StoreError('Comment too long.',413);const b=JSON.parse(text);if(typeof b.name!=='string'||typeof b.message!=='string')throw new StoreError('Name and comment required.');return NextResponse.json(await addFeedback(params.token,b.name,b.message))}catch(e){return failure(e)}}
