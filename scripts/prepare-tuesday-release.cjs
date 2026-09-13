const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process')
const root = path.resolve(__dirname, '..')
const git = args => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const files = [
 'app/business/page.tsx','app/page.tsx','components/jobs/JobWorkspaceView.tsx','components/quote/QuoteView.tsx','package.json','package-lock.json',
 'WORKA_TUESDAY_AUDIT.md','WORKA_TUESDAY_RELEASE.md','lib/profitability.ts','lib/profitability.test.ts','lib/profitability-ai.ts','lib/profitability-data.ts','lib/cost-import.ts','lib/cost-import.test.ts',
 'app/api/business/financial-profile/route.ts','app/api/jobs/[jobId]/intelligence/route.ts','app/api/jobs/[jobId]/correspondence/route.ts','app/api/jobs/[jobId]/cost-import/route.ts','app/api/jobs/[jobId]/learning/route.ts','app/api/jobs/[jobId]/profitability-analysis/route.ts','app/jobs/[jobId]/profitability/page.tsx',
 'scripts/preview-profitability.cjs','scripts/test-profitability-api.cjs','scripts/test-profitability-db.cjs','scripts/prepare-tuesday-release.cjs','supabase/migrations/20260913105546_profitability_intelligence.sql',
 ...fs.readdirSync(path.join(root,'components/profitability')).map(name=>'components/profitability/'+name)
].sort()
const manifest={createdAt:new Date().toISOString(),baseCommit:git(['rev-parse','HEAD']).trim(),branch:git(['branch','--show-current']).trim(),status:'Awaiting approval for production migration, deployment and scoped synthetic validation',files:files.map(file=>({path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}))}
let patch=git(['diff','--binary','HEAD','--',...files])
const tracked=new Set(git(['ls-files']).trim().split(/\r?\n/))
for(const file of files.filter(f=>!tracked.has(f))){const content=fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');const lines=content.replace(/\n$/,'').split('\n');patch+=`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`+lines.map(l=>'+'+l).join('\n')+'\n';if(!content.endsWith('\n'))patch+='\\ No newline at end of file\n'}
fs.writeFileSync(path.join(root,'tuesday-release-manifest.json'),JSON.stringify(manifest,null,2));fs.writeFileSync(path.join(root,'tuesday-release.patch'),patch)
console.log(JSON.stringify({files:files.length,baseCommit:manifest.baseCommit,branch:manifest.branch,patchBytes:Buffer.byteLength(patch)}))
