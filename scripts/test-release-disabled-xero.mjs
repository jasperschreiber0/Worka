import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const root = 'C:/Users/Nebula PC/Documents/Codex/Worka'
// Run-specific synthetic IDs below were cleaned up. A new run needs new recorded
// identities and a private config file {url,key,password}; never commit that file.
if (!process.env.WORKA_RELEASE_TEST_CONFIG) throw Error('Set WORKA_RELEASE_TEST_CONFIG to a private synthetic-fixture configuration file')
const cfg = JSON.parse(readFileSync(process.env.WORKA_RELEASE_TEST_CONFIG,'utf8'))
const origin = 'http://127.0.0.1:3217'
const results = []
const check = (name,condition) => { assert.ok(condition,name); results.push({name,passed:true}) }
const server = spawn(process.execPath,[root+'/node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3217'],{
 cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],
 env:{...process.env,NODE_ENV:'production',NEXT_PUBLIC_SUPABASE_URL:cfg.url,NEXT_PUBLIC_SUPABASE_ANON_KEY:cfg.key,NEXT_PUBLIC_APP_URL:origin,XERO_ENABLED:'false',SUPABASE_SERVICE_ROLE_KEY:'',XERO_CLIENT_ID:'',XERO_CLIENT_SECRET:'',XERO_TOKEN_ENCRYPTION_KEY:''}
})
// Keep server output private: URLs could contain OAuth parameters.
let startup = ''; server.stdout.on('data',d=>{startup+=d}); server.stderr.on('data',()=>{})
try {
 for(let i=0;i<60;i++){if(startup.includes('Ready'))break;if(server.exitCode!==null)throw Error('Server startup failed');await new Promise(r=>setTimeout(r,500))}
 const request=(path,cookie)=>fetch(origin+path,{redirect:'manual',headers:cookie?{cookie}:{}})
 let r=await request('/api/xero/connect');check('Unauthenticated initiation denied',r.status===401)
 r=await request('/settings/xero');check('Protected settings redirect anonymous access to login',r.status===307&&r.headers.get('location').includes('/login'))
 r=await request('/api/xero/connect','sb-nfyuhsqvmmcdgbedhsxd-auth-token=forged');check('Forged session denied',r.status===401)
 for (const [suffix,id] of [['a','92702873-a3b3-4460-b92f-63e17e919d9a'],['b','8c79b6a5-6f64-4299-89f8-e96eafce85e8']]) {
  const auth=await fetch(cfg.url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:cfg.key,'Content-Type':'application/json'},body:JSON.stringify({email:'worka-release-20260908-'+suffix+'@example.invalid',password:cfg.password})})
  assert.equal(auth.status,200,'Synthetic login')
  const session=await auth.json();check('Tenant '+suffix+' real authentication',session.user.id===id)
  const raw=JSON.stringify([session.access_token,session.refresh_token,null,null,null]); const chunks=raw.match(/.{1,3180}/g)
  const cookie=chunks.map((v,i)=>'sb-nfyuhsqvmmcdgbedhsxd-auth-token'+(chunks.length>1?'.'+i:'')+'='+encodeURIComponent(v)).join('; ')
  r=await request('/api/xero/connect',cookie);const data=await r.json()
  check('Tenant '+suffix+' authenticated disabled initiation',r.status===200&&data.setup_required===true&&!data.auth_url)
  check('Tenant '+suffix+' disabled initiation sets no OAuth cookie',!r.headers.get('set-cookie')?.includes('worka_xero'))
  r=await request('/settings/xero',cookie);check('Tenant '+suffix+' authenticated settings loads',r.status===200)
  r=await request('/api/xero/callback?state=invalid&code=synthetic-never-exchange',cookie)
  check('Tenant '+suffix+' disabled callback fails closed',r.status===307&&r.headers.get('location').endsWith('status=error'))
  const clear=r.headers.get('set-cookie')??''
  check('Tenant '+suffix+' callback clears correct production cookie scope',/Path=\/api\/xero/.test(clear)&&/Max-Age=0/.test(clear)&&/HttpOnly/.test(clear)&&/Secure/.test(clear))
  for(const [path,method] of [['/api/xero/sync','POST'],['/api/xero/import-items','GET'],['/api/xero/import-items','PATCH'],['/api/xero/import-items','POST']]){
   const blocked=await fetch(origin+path,{method,headers:{cookie,'Content-Type':'application/json'},...(method==='GET'?{}:{body:'{}'})})
   check('Tenant '+suffix+' disabled '+method+' '+path,blocked.status===503&&(await blocked.json()).disabled===true)
  }
  // Revoke only this synthetic session.
  const logout=await fetch(cfg.url+'/auth/v1/logout?scope=global',{method:'POST',headers:{apikey:cfg.key,Authorization:'Bearer '+session.access_token}})
  check('Tenant '+suffix+' synthetic session logout',logout.status===204)
 }
 writeFileSync(new URL('./running-app-results.json',import.meta.url),JSON.stringify({mode:'Actual Next production server + live Supabase Auth; Xero and service-role configuration explicitly disabled',results},null,2))
 console.log(JSON.stringify({passed:results.length,failed:0}))
} catch(error) {
 writeFileSync(new URL('./running-app-results.json',import.meta.url),JSON.stringify({results,error:error.message},null,2))
 console.error(error.message);process.exitCode=1
} finally { server.kill() }
