import {NextRequest,NextResponse} from 'next/server'
import {identity,sameOrigin,StoreError} from '@/lib/studio-store'
import {querySite,siteLocation} from '@/lib/studio-site'
export const runtime='nodejs',dynamic='force-dynamic',maxDuration=60
export async function POST(req:NextRequest){try{sameOrigin(req);await identity(req);const raw=await req.text();if(raw.length>2000)throw new StoreError('Site request too large.',413);let location;try{location=siteLocation(JSON.parse(raw))}catch(e){throw new StoreError(e instanceof Error?e.message:'Invalid coordinates.')};return NextResponse.json(await querySite(location),{headers:{'Cache-Control':'no-store'}})}catch(e){return NextResponse.json({error:e instanceof StoreError?e.message:'Site lookup failed. No planning conclusion has been made.'},{status:e instanceof StoreError?e.status:502})}}
