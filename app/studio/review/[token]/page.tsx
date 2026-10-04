'use client'
import { useEffect,useState } from 'react'
import ClientReview from '@/components/studio/ClientReview'
import type { ClientProjection } from '@/lib/studio-workspace'
import '../../studio.css'
import '../../workspace.css'
export default function ReviewPage({params}:{params:{token:string}}){const [payload,setPayload]=useState<ClientProjection|null>(null),[error,setError]=useState('');useEffect(()=>{let active=true;fetch('/api/studio/review/'+params.token).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);if(active)setPayload(d.payload)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[params.token]);return payload?<ClientReview payload={payload} token={params.token}/>:<main className="wb-loading">{error||'Opening your project review…'}</main>}
