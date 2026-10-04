import fs from 'node:fs/promises'
const base=process.argv[2]||'https://getworka.com'
const results=[]
for(const [path,expected] of [['/login',[200]],['/studio',[302,303,307,308]],['/api/studio',[401]],['/api/studio/recognise',[401]],['/api/studio/renders?projectId=release-check',[401]]]){
 try{const r=await fetch(new URL(path,base),{redirect:'manual',signal:AbortSignal.timeout(20000)});const location=r.headers.get('location');const passes=expected.includes(r.status)&&(path!=='/studio'||!!location?.includes('/login'));results.push({path,status:r.status,passes,...(path==='/studio'?{loginRedirect:location}: {})})}catch(e){results.push({path,passes:false,error:e.message})}
}
const report={checkedAt:new Date().toISOString(),base,passed:results.every(r=>r.passes),scope:'Unauthenticated release entry points only. Does not verify a signed-in builder, real-plan accuracy, provider availability, or account storage.',results}
await fs.mkdir('output',{recursive:true});await fs.writeFile('output/public-studio-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1
