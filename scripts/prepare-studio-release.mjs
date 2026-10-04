import fs from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const tracked=execFileSync('git',['diff','--name-only','HEAD'],{encoding:'utf8'}).trim().split(/\r?\n/)
const untracked=execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split(/\r?\n/)
const paths=[...new Set([...tracked,...untracked])].filter(p=>/^(app\/|components\/|lib\/|middleware\.ts$|next\.config\.mjs$|package(-lock)?\.json$|tsconfig\.json$|\.gitignore$|supabase\/functions\/smooth-responder\/|supabase\/migrations\/20261001235306_)/.test(p)).sort()
const files=[]
for(const path of paths){const data=await fs.readFile(path);files.push({path,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')})}
const manifest={createdAt:new Date().toISOString(),baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),status:'Local build tested; not deployed. Real-plan estimate and geometry accuracy remain unverified.',tests:{passed:910,failed:0,build:'passed',liveCheckpoint:'passed',imageGeneration:'passed; illustrative only',publicStudio:'404'},files}
await fs.writeFile('output/studio-release-manifest.json',JSON.stringify(manifest,null,2))
console.log(JSON.stringify({files:files.length,sourceBytes:files.reduce((s,f)=>s+f.bytes,0),baseCommit:manifest.baseCommit,status:manifest.status}))
