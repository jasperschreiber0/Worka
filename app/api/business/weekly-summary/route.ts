import {NextResponse} from 'next/server'
import {getAuthenticatedBuilderId} from '@/lib/auth/api-auth'
import {intelligenceDB,allRows} from '@/lib/profitability-data'
export const dynamic='force-dynamic'
export async function GET(){
 const builder=await getAuthenticatedBuilderId();if(!builder)return NextResponse.json({error:'Sign in required'},{status:401})
 try{const db=intelligenceDB(),since=new Date(Date.now()-7*86400000).toISOString()
 const [jobs,quotes]=await Promise.all([allRows(()=>db.from('jobs').select('id,address,status,created_at').eq('builder_id',builder).order('id')),allRows(()=>db.from('quotes').select('id,job_id,created_at,sent_at,approved_at,status').eq('builder_id',builder).order('id'))])
 const newJobs=jobs.filter(j=>j.created_at>=since),sent=quotes.filter(q=>q.sent_at&&q.sent_at>=since),won=quotes.filter(q=>q.status==='approved'&&q.approved_at&&q.approved_at>=since)
 const name=(id:string)=>jobs.find(j=>j.id===id)?.address??'Job unavailable'
 const report=`WorkA weekly activity — last seven days to ${new Date().toLocaleDateString('en-AU',{timeZone:'Australia/Sydney'})}\nNew job records: ${newJobs.length}\nQuotes issued: ${sent.length}\nJobs with a quote approved in this period: ${new Set(won.map(q=>q.job_id)).size}\n\nIssued quotes:\n${sent.map(q=>'- '+name(q.job_id)).join('\n')||'None recorded in this period.'}\n\nApproved quotes:\n${won.map(q=>'- '+name(q.job_id)).join('\n')||'None recorded in this period.'}\n\nCoverage: WorkA records only. New jobs are not necessarily new sales leads. Marketing activity and external inbox records are not connected. This report has not been sent.`
 return NextResponse.json({report})
 }catch{return NextResponse.json({error:'Could not load the weekly report. Retry before relying on the totals.'},{status:503})}
}
