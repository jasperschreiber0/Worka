import {stableJson} from './studio-json.ts'
import {parseWorkspace} from './studio-workspace.ts'
import type {Workspace,StoredWorkspace} from './studio-workspace.ts'
export function decodeRecovery(raw:string|null):{workspace:Workspace;baseVersion:number|null}|null{
 if(!raw)return null
 try{const v=JSON.parse(raw);if(v.recoveryFormat===1){const workspace=parseWorkspace(v.workspace);return workspace&&Number.isInteger(v.baseVersion)&&v.baseVersion>=0?{workspace,baseVersion:v.baseVersion}:workspace?{workspace,baseVersion:null}:null}const workspace=parseWorkspace(v);return workspace?{workspace,baseVersion:null}:null}catch{return null}
}
export function encodeRecovery(workspace:Workspace,baseVersion:number|null){return JSON.stringify({recoveryFormat:1,workspace,baseVersion})}
export function recoveryConflicts(recovery:NonNullable<ReturnType<typeof decodeRecovery>>,saved:StoredWorkspace){return stableJson(recovery.workspace)!==stableJson(saved.workspace)&&recovery.baseVersion!==saved.version}
